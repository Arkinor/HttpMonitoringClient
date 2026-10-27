"""Thread-safe JSON storage with atomic writes."""

from __future__ import annotations

import json
import os
import shutil
import threading
import time
from pathlib import Path
from typing import Any, Optional

from servicemonitor import config
from servicemonitor.models import Service, Settings, now_iso

log = config.get_logger(__name__)

MAX_NOTIFICATION_LOG = 200


class Storage:
    def __init__(self) -> None:
        self._lock = threading.RLock()
        self._initialized = False
        self._services: Optional[list[Service]] = None
        self._settings: Optional[Settings] = None
        self._results: Optional[list[dict[str, Any]]] = None
        self._states: Optional[dict[str, Any]] = None
        self._notifications: Optional[list[dict[str, Any]]] = None

    # ── Paths ────────────────────────────────────────────────────────────
    @property
    def services_path(self) -> Path:
        return config.data_path("services.json")

    @property
    def history_path(self) -> Path:
        return config.data_path(config.HISTORY_FILE)

    @property
    def settings_path(self) -> Path:
        return config.data_path("settings.json")

    @property
    def state_path(self) -> Path:
        return config.data_path("state.json")

    @property
    def notifications_path(self) -> Path:
        return config.data_path("notifications.json")

    def data_files(self) -> dict[str, str]:
        return {
            "services": str(self.services_path),
            "history": str(self.history_path),
            "settings": str(self.settings_path),
            "state": str(self.state_path),
            "notifications": str(self.notifications_path),
        }

    # ── Low-level helpers ────────────────────────────────────────────────
    @staticmethod
    def _read_json(path: Path, default: Any) -> Any:
        try:
            if not path.exists():
                return default
            with open(path, "r", encoding="utf-8") as handle:
                return json.load(handle)
        except (OSError, json.JSONDecodeError) as exc:
            log.error("Cannot read %s: %s", path, exc)
            return default

    @staticmethod
    def _write_json(path: Path, data: Any) -> None:
        path.parent.mkdir(parents=True, exist_ok=True)
        tmp = path.with_name(path.name + ".tmp")
        with open(tmp, "w", encoding="utf-8") as handle:
            json.dump(data, handle, ensure_ascii=False, indent=2)
            handle.flush()
            os.fsync(handle.fileno())
        os.replace(tmp, path)

    def _backup(self, path: Path) -> None:
        if not path.exists():
            return
        stamp = time.strftime("%Y%m%d-%H%M%S")
        try:
            shutil.copy2(path, path.with_name(f"{path.stem}.{stamp}.bak"))
        except OSError as exc:
            log.warning("Backup failed for %s: %s", path, exc)

    # ── Bootstrap ────────────────────────────────────────────────────────
    def initialize(self) -> None:
        with self._lock:
            if self._initialized:
                return
            self._migrate_legacy_files()

            if not self.settings_path.exists():
                self._write_json(self.settings_path, Settings().model_dump())
            if not self.state_path.exists():
                self._write_json(self.state_path, {"services": {}, "updated_at": now_iso()})
            if not self.notifications_path.exists():
                self._write_json(self.notifications_path, [])
            if not self.history_path.exists():
                self._write_json(self.history_path, [])

            raw_services = self._read_json(self.services_path, [])
            if not isinstance(raw_services, list):
                raw_services = []
            services: list[Service] = []
            for item in raw_services:
                try:
                    services.append(Service.model_validate(item))
                except Exception as exc:  # invalid item should not break the app
                    log.warning("Skipping invalid service entry: %s", exc)
            self._services = services
            # Normalize and persist once, so the file always uses the current schema.
            self._write_json(self.services_path, [s.model_dump() for s in services])

            raw_results = self._read_json(self.history_path, [])
            self._results = (
                [item for item in raw_results if isinstance(item, dict)]
                if isinstance(raw_results, list)
                else []
            )

            raw_settings = self._read_json(self.settings_path, {})
            try:
                self._settings = Settings.model_validate(raw_settings)
            except Exception as exc:
                log.error("Invalid settings file, using defaults: %s", exc)
                self._settings = Settings()
                self._write_json(self.settings_path, self._settings.model_dump())

            raw_state = self._read_json(self.state_path, {})
            if not isinstance(raw_state, dict):
                raw_state = {}
            if not isinstance(raw_state.get("services"), dict):
                raw_state["services"] = {}
            self._states = raw_state

            raw_notifications = self._read_json(self.notifications_path, [])
            self._notifications = (
                [item for item in raw_notifications if isinstance(item, dict)]
                if isinstance(raw_notifications, list)
                else []
            )

            self._prune_states_locked()
            self._trim_results_locked()
            self._initialized = True
            log.info("Storage ready in %s", config.data_dir())

    def _migrate_legacy_files(self) -> None:
        """Move data from the old flat layout into the current data directory.

        Older builds kept JSON files next to the executable and called the
        history file ``results.json``. New builds use a single ``data`` folder
        with ``history.json``. When the user passes an explicit data directory,
        nothing is moved: the chosen location starts clean.
        """
        if config.custom_data_dir():
            return

        mapping = {
            "services.json": "services.json",
            "settings.json": "settings.json",
            "state.json": "state.json",
            "notifications.json": "notifications.json",
            "results.json": config.HISTORY_FILE,
            "BASE.json": "services.json",
            "result.json": config.HISTORY_FILE,
        }
        directories = [config.data_dir(), *config.legacy_data_dirs()]
        seen: set[Path] = set()
        for directory in directories:
            try:
                resolved = directory.resolve()
            except OSError:
                continue
            if resolved in seen:
                continue
            seen.add(resolved)

            for source_name, target_name in mapping.items():
                source = directory / source_name
                target = config.data_path(target_name)
                if not source.exists() or source.resolve() == target.resolve() or target.exists():
                    continue
                try:
                    shutil.move(str(source), str(target))
                    log.info("Moved %s to %s", source, target)
                except OSError as exc:
                    log.warning("Cannot move %s to %s: %s", source, target, exc)
                    try:
                        shutil.copy2(source, target)
                        log.info("Copied %s to %s", source, target)
                    except OSError as copy_exc:
                        log.error("Cannot migrate %s: %s", source, copy_exc)

    def _prune_states_locked(self) -> None:
        if self._services is None or self._states is None:
            return
        ids = {s.id for s in self._services}
        states = self._states.get("services", {})
        removed = [key for key in states if key not in ids]
        for key in removed:
            states.pop(key, None)
        if removed:
            self._states["updated_at"] = now_iso()
            self._write_json(self.state_path, self._states)

    def _trim_results_locked(self) -> None:
        if self._results is None or self._settings is None:
            return
        limit = self._settings.monitoring.history_limit
        if len(self._results) > limit:
            self._results = self._results[-limit:]
            self._write_json(self.history_path, self._results)

    # ── Services ─────────────────────────────────────────────────────────
    def services(self) -> list[Service]:
        with self._lock:
            if self._services is None:
                self.initialize()
            return [s.model_copy(deep=True) for s in (self._services or [])]

    def service(self, service_id: str) -> Optional[Service]:
        with self._lock:
            for service in self._services or []:
                if service.id == service_id:
                    return service.model_copy(deep=True)
            return None

    def save_services(self, services: list[Service]) -> None:
        unique: dict[str, Service] = {}
        for item in services:
            unique[item.id] = item
        with self._lock:
            self._services = list(unique.values())
            self._write_json(self.services_path, [s.model_dump() for s in self._services])
            self._prune_states_locked()

    def add_service(self, service: Service) -> Service:
        with self._lock:
            services = self.services()
            services.append(service)
            self.save_services(services)
            return service

    def update_service(self, service: Service) -> Service:
        with self._lock:
            services = self.services()
            for index, existing in enumerate(services):
                if existing.id == service.id:
                    service.created_at = existing.created_at
                    service.updated_at = now_iso()
                    services[index] = service
                    self.save_services(services)
                    return service
        raise KeyError("Сервис не найден")

    def delete_service(self, service_id: str) -> bool:
        with self._lock:
            services = self.services()
            remaining = [s for s in services if s.id != service_id]
            if len(remaining) == len(services):
                return False
            self.save_services(remaining)
            states = self.states()
            if service_id in states.get("services", {}):
                states["services"].pop(service_id, None)
                self.save_states(states)
            return True

    def find_by_key(self, url: str, method: str) -> Optional[Service]:
        with self._lock:
            for service in self._services or []:
                if service.url == url and service.method == method.upper():
                    return service.model_copy(deep=True)
            return None

    # ── Settings ─────────────────────────────────────────────────────────
    def settings(self) -> Settings:
        with self._lock:
            if self._settings is None:
                self.initialize()
            return (self._settings or Settings()).model_copy(deep=True)

    def save_settings(self, settings: Settings) -> Settings:
        with self._lock:
            self._settings = settings
            self._write_json(self.settings_path, settings.model_dump())
            if self._results is not None:
                limit = settings.monitoring.history_limit
                if len(self._results) > limit:
                    self._results = self._results[-limit:]
                    self._write_json(self.history_path, self._results)
            return settings.model_copy(deep=True)

    def apply_runtime_settings(self, settings: Settings) -> None:
        """Save monitoring-only changes without touching other settings."""
        with self._lock:
            self._settings = settings
            self._write_json(self.settings_path, settings.model_dump())

    # ── Results ──────────────────────────────────────────────────────────
    def results(self, limit: Optional[int] = None, newest_first: bool = True) -> list[dict[str, Any]]:
        with self._lock:
            data = list(self._results or [])
        if newest_first:
            data.reverse()
        if limit is not None and limit >= 0:
            data = data[:limit]
        return data

    def save_batch(self, batch: dict[str, Any]) -> None:
        with self._lock:
            data = self._results if self._results is not None else []
            for index, item in enumerate(data):
                if item.get("check_id") == batch.get("check_id"):
                    data[index] = batch
                    break
            else:
                data.append(batch)
            limit = (self._settings or Settings()).monitoring.history_limit
            if len(data) > limit:
                data = data[-limit:]
            self._results = data
            self._write_json(self.history_path, data)

    def clear_results(self) -> None:
        with self._lock:
            self._results = []
            self._write_json(self.history_path, [])

    # ── Runtime states ───────────────────────────────────────────────────
    def states(self) -> dict[str, Any]:
        with self._lock:
            if self._states is None:
                self.initialize()
            return json.loads(json.dumps(self._states or {"services": {}}))

    def save_states(self, states: dict[str, Any], persist: bool = True) -> None:
        with self._lock:
            if not isinstance(states.get("services"), dict):
                states["services"] = {}
            states["updated_at"] = now_iso()
            self._states = states
            if persist:
                self._write_json(self.state_path, states)

    # ── Notification log ─────────────────────────────────────────────────
    def add_notification_log(self, entry: dict[str, Any]) -> None:
        with self._lock:
            data = self._notifications if self._notifications is not None else []
            data.append(entry)
            if len(data) > MAX_NOTIFICATION_LOG:
                data = data[-MAX_NOTIFICATION_LOG:]
            self._notifications = data
            self._write_json(self.notifications_path, data)

    def notifications(self, limit: int = 50) -> list[dict[str, Any]]:
        with self._lock:
            data = list(self._notifications or [])
        data.reverse()
        return data[:limit]

    # ── Backup / restore ─────────────────────────────────────────────────
    def export_backup(self) -> dict[str, Any]:
        return {
            "version": config.APP_VERSION,
            "exported_at": now_iso(),
            "services": [s.model_dump() for s in self.services()],
            "settings": self.settings().model_dump(),
        }

    def restore_backup(self, services: list[Service], settings: Settings) -> None:
        with self._lock:
            self._backup(self.services_path)
            self._backup(self.settings_path)
            self._services = services
            self._settings = settings
            self._states = {"services": {}, "updated_at": now_iso()}
            self._write_json(self.services_path, [s.model_dump() for s in services])
            self._write_json(self.settings_path, settings.model_dump())
            self._write_json(self.state_path, self._states)
            self._trim_results_locked()


storage = Storage()

