"""System tray icon and menu."""

from __future__ import annotations

import json
import os
import threading
import time
import urllib.error
import urllib.request
import webbrowser
from typing import Any, Callable, Optional

from servicemonitor import config
from servicemonitor.desktop.icon import create_icon

log = config.get_logger(__name__)


class TrayUnavailable(RuntimeError):
    pass


class TrayApp:
    def __init__(self, base_url: str, on_quit: Callable[[], None]) -> None:
        self.base_url = base_url.rstrip("/")
        self.on_quit = on_quit
        self._stop = threading.Event()
        self._auto_enabled = True
        self._problems: Optional[set[str]] = None
        self._tray_notifications = True
        self._icon: Any = None

        try:
            import pystray
        except Exception as exc:  # noqa: BLE001
            raise TrayUnavailable(str(exc)) from exc

        self._pystray = pystray
        menu = pystray.Menu(
            pystray.MenuItem("Открыть панель", self._open_panel, default=True),
            pystray.MenuItem("Проверить сейчас", self._check_now),
            pystray.Menu.SEPARATOR,
            pystray.MenuItem("Автопроверка", self._toggle_auto, checked=lambda item: self._auto_enabled),
            pystray.MenuItem("Открыть папку данных", self._open_data_dir),
            pystray.Menu.SEPARATOR,
            pystray.MenuItem("Выход", self._quit),
        )
        self._icon = pystray.Icon(
            config.APP_ID,
            create_icon(64, "unknown"),
            config.APP_NAME,
            menu,
        )

    # ── HTTP helpers ─────────────────────────────────────────────────────
    def _request(self, path: str, method: str = "GET", payload: Optional[dict] = None) -> dict[str, Any]:
        data = None
        headers = {"Accept": "application/json"}
        if payload is not None:
            data = json.dumps(payload).encode("utf-8")
            headers["Content-Type"] = "application/json"
        elif method != "GET":
            data = b"{}"
            headers["Content-Type"] = "application/json"
        request = urllib.request.Request(self.base_url + path, data=data, headers=headers, method=method)
        with urllib.request.urlopen(request, timeout=4) as response:
            body = response.read().decode("utf-8")
        return json.loads(body) if body else {}

    # ── Tray actions ─────────────────────────────────────────────────────
    def _open_panel(self, icon: Any = None, item: Any = None) -> None:
        try:
            webbrowser.open(self.base_url + "/")
        except Exception as exc:  # noqa: BLE001
            log.warning("Cannot open browser: %s", exc)

    def _check_now(self, icon: Any = None, item: Any = None) -> None:
        try:
            self._request("/api/check", method="POST", payload={})
        except Exception as exc:  # noqa: BLE001
            log.warning("Manual check request failed: %s", exc)

    def _toggle_auto(self, icon: Any = None, item: Any = None) -> None:
        try:
            result = self._request("/api/monitoring", method="POST", payload={"enabled": not self._auto_enabled})
            self._auto_enabled = bool(result.get("auto_check_enabled", not self._auto_enabled))
            if self._icon:
                self._icon.update_menu()
        except Exception as exc:  # noqa: BLE001
            log.warning("Cannot toggle auto check: %s", exc)

    def _open_data_dir(self, icon: Any = None, item: Any = None) -> None:
        try:
            if os.name == "nt":
                os.startfile(config.data_dir())  # type: ignore[attr-defined]
            else:
                webbrowser.open(config.data_dir().as_uri())
        except Exception as exc:  # noqa: BLE001
            log.warning("Cannot open data directory: %s", exc)

    def _quit(self, icon: Any = None, item: Any = None) -> None:
        self._stop.set()
        try:
            self.on_quit()
        finally:
            if self._icon:
                self._icon.stop()

    # ── Status polling ───────────────────────────────────────────────────
    def _refresh(self) -> None:
        state = self._request("/api/state")
        status = state.get("status") or {}
        counts = state.get("counts") or {}
        services = {service["id"]: service for service in state.get("services") or []}
        states = state.get("states") or {}
        preferences = state.get("preferences") or {}

        self._auto_enabled = bool(status.get("auto_check_enabled"))
        self._tray_notifications = bool(preferences.get("tray_notifications", True))

        problems = {
            service_id
            for service_id, service_state in states.items()
            if service_state.get("success") is False and service_id in services
        }

        if problems:
            status_name = "error"
        elif counts.get("ok"):
            status_name = "ok"
        else:
            status_name = "unknown"

        total = counts.get("enabled", 0)
        errors = counts.get("error", 0)
        if errors:
            tooltip = f"{config.APP_NAME}: {total} сервисов, ошибок {errors}"
        elif total:
            tooltip = f"{config.APP_NAME}: все {total} сервисов доступны"
        else:
            tooltip = f"{config.APP_NAME}: сервисы не добавлены"

        if self._icon:
            self._icon.icon = create_icon(64, status_name)
            self._icon.title = tooltip[:120]
            self._icon.update_menu()

        if self._problems is not None and self._tray_notifications:
            new_problems = problems - self._problems
            if new_problems:
                names = [services[service_id].get("name") or services[service_id].get("url", "") for service_id in new_problems]
                text = "Недоступно: " + ", ".join(names[:3])
                if len(names) > 3:
                    text += f" и ещё {len(names) - 3}"
                try:
                    self._icon.notify(text, config.APP_NAME)
                except Exception as exc:  # noqa: BLE001
                    log.debug("Tray notification failed: %s", exc)
        self._problems = problems

    def _poll_loop(self) -> None:
        while not self._stop.is_set():
            try:
                self._refresh()
            except Exception as exc:  # noqa: BLE001
                log.debug("Tray status poll failed: %s", exc)
                if self._icon:
                    self._icon.title = f"{config.APP_NAME}: нет связи с сервером"
            self._stop.wait(10)

    # ── Lifecycle ────────────────────────────────────────────────────────
    def run(self) -> None:
        if not self._icon:
            raise TrayUnavailable("Иконка не создана")
        poller = threading.Thread(target=self._poll_loop, name="tray-poll", daemon=True)
        poller.start()
        try:
            self._icon.run()
        finally:
            self._stop.set()
            poller.join(timeout=2)
            log.info("Tray stopped")
