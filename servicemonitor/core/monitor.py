"""Monitoring engine: scheduled checks, live events and alert transitions."""

from __future__ import annotations

import asyncio
import time
import uuid
from datetime import datetime, timedelta
from typing import Any, Optional

import aiohttp

from servicemonitor import config, events
from servicemonitor.core.httpcheck import PREVIEW_BODY_LIMIT, perform_check
from servicemonitor.models import Service, Settings, now_iso
from servicemonitor.notify import channels as notifications
from servicemonitor.storage import storage

log = config.get_logger(__name__)

PERSIST_THROTTLE_SEC = 3.0


def _parse_iso(value: Optional[str]) -> Optional[datetime]:
    if not value:
        return None
    try:
        return datetime.fromisoformat(value)
    except (ValueError, TypeError):
        return None


class Monitor:
    def __init__(self) -> None:
        self._loop_task: Optional[asyncio.Task] = None
        self._manual_task: Optional[asyncio.Task] = None
        self._current: Optional[dict[str, Any]] = None
        self._check_guard = asyncio.Lock()
        self._wake = asyncio.Event()
        self._stop = False
        self._last_check_time: Optional[datetime] = None
        self.next_check_at: Optional[datetime] = None
        self._last_state_persist = 0.0
        self._notification_tasks: set[asyncio.Task] = set()

    # ── Lifecycle ────────────────────────────────────────────────────────
    async def start(self) -> None:
        self._stop = False
        self._loop_task = asyncio.create_task(self._loop(), name="monitoring-loop")
        log.info("Monitoring started (auto check: %s)", storage.settings().monitoring.auto_check_enabled)

    async def stop(self) -> None:
        self._stop = True
        self._wake.set()
        for task in (self._loop_task, self._manual_task):
            if task and not task.done():
                task.cancel()
                try:
                    await task
                except asyncio.CancelledError:
                    pass
        if self._notification_tasks:
            try:
                await asyncio.wait_for(
                    asyncio.gather(*self._notification_tasks, return_exceptions=True), timeout=5
                )
            except asyncio.TimeoutError:
                pass
        self._persist_states(force=True)
        log.info("Monitoring stopped")

    # ── Scheduler ────────────────────────────────────────────────────────
    async def _loop(self) -> None:
        while not self._stop:
            settings = storage.settings()
            if not settings.monitoring.auto_check_enabled:
                self.next_check_at = None
                self._wake.clear()
                try:
                    await asyncio.wait_for(self._wake.wait(), timeout=5)
                except asyncio.TimeoutError:
                    pass
                continue

            try:
                await self.run_check("auto")
            except asyncio.CancelledError:
                raise
            except Exception as exc:  # noqa: BLE001
                log.exception("Automatic check failed: %s", exc)

            if self._stop:
                break
            interval = storage.settings().monitoring.interval_seconds
            self.next_check_at = datetime.now().astimezone() + timedelta(seconds=interval)
            events.publish({"type": "schedule", "next_check_time": self.next_check_at.isoformat()})
            await self._sleep_between_checks(interval)

    async def _sleep_between_checks(self, interval: int) -> None:
        deadline = time.monotonic() + interval
        wake = self._wake
        wake.clear()
        while not self._stop:
            settings = storage.settings()
            if not settings.monitoring.auto_check_enabled:
                self.next_check_at = None
                return
            if wake.is_set():
                wake.clear()
            if settings.monitoring.interval_seconds != interval:
                interval = settings.monitoring.interval_seconds
                deadline = time.monotonic() + interval
                self.next_check_at = datetime.now().astimezone() + timedelta(seconds=interval)
                events.publish({"type": "schedule", "next_check_time": self.next_check_at.isoformat()})
            remaining = deadline - time.monotonic()
            if remaining <= 0:
                return
            await asyncio.sleep(min(1.0, remaining))

    def settings_changed(self) -> None:
        self._wake.set()
        events.publish({"type": "settings_changed", "status": self.get_status()})

    async def set_auto_check(self, enabled: bool) -> Settings:
        settings = storage.settings()
        settings.monitoring.auto_check_enabled = enabled
        settings = storage.save_settings(settings)
        self.settings_changed()
        events.publish({"type": "monitoring", "status": self.get_status()})
        return settings

    def set_interval(self, seconds: int) -> Settings:
        settings = storage.settings()
        settings.monitoring.interval_seconds = seconds
        settings = storage.save_settings(settings)
        self.settings_changed()
        return settings

    # ── Check entry points ───────────────────────────────────────────────
    def request_check(self, trigger: str = "manual") -> tuple[bool, Optional[str], Optional[dict[str, Any]]]:
        if self._current is not None or (self._manual_task and not self._manual_task.done()):
            return False, self._current.get("check_id") if self._current else None, dict(self._current or {})
        check_id = self._new_check_id()
        self._manual_task = asyncio.create_task(
            self.run_check(trigger, check_id=check_id), name="manual-check"
        )
        return True, check_id, None

    async def run_check(self, trigger: str = "auto", check_id: Optional[str] = None) -> dict[str, Any]:
        async with self._check_guard:
            if self._current is not None:
                return {"message": "Проверка уже выполняется", "running": True}
            return await self._run_check_locked(trigger, check_id or self._new_check_id())

    async def _run_check_locked(self, trigger: str, check_id: str) -> dict[str, Any]:
        started = datetime.now().astimezone()
        settings = storage.settings()
        services = storage.services()
        check_time = started.isoformat(timespec="seconds")

        batch: dict[str, Any] = {
            "check_id": check_id,
            "check_time": check_time,
            "finished_at": None,
            "status": "running",
            "trigger": trigger,
            "total": len(services),
            "success_count": 0,
            "failed_count": 0,
            "skipped_count": 0,
            "results": [],
        }
        self._current = {
            "check_id": check_id,
            "check_time": check_time,
            "trigger": trigger,
            "total": len(services),
            "done": 0,
            "success": 0,
            "failed": 0,
            "skipped": 0,
        }
        self._last_check_time = started
        self.next_check_at = None

        if services:
            storage.save_batch(batch)

        events.publish(
            {
                "type": "batch_start",
                "check_id": check_id,
                "check_time": check_time,
                "trigger": trigger,
                "total": len(services),
                "services": [
                    {
                        "id": s.id,
                        "name": s.display_name,
                        "url": s.url,
                        "method": s.method,
                        "comment": s.comment,
                        "enabled": s.enabled,
                    }
                    for s in services
                ],
            }
        )

        last_persist = 0.0
        try:
            connector = aiohttp.TCPConnector(limit=max(8, settings.monitoring.concurrency * 2), ssl=False)
            async with aiohttp.ClientSession(connector=connector) as session:
                async for service, result in self._iter_results(services, settings, session):
                    batch["results"].append(result)
                    progress = self._current
                    progress["done"] = len(batch["results"])
                    if result.get("success") is True:
                        progress["success"] += 1
                        batch["success_count"] += 1
                    elif result.get("success") is False:
                        progress["failed"] += 1
                        batch["failed_count"] += 1
                    else:
                        progress["skipped"] += 1
                        batch["skipped_count"] += 1

                    self._apply_result_state(service, result, settings)
                    public_result = {
                        key: value
                        for key, value in result.items()
                        if key not in ("response_body", "response_headers")
                    }
                    events.publish(
                        {
                            "type": "service_result",
                            "check_id": check_id,
                            "result": public_result,
                            "state": self._service_state(service),
                            "progress": dict(progress),
                        }
                    )
                    if services:
                        now = time.monotonic()
                        if now - last_persist >= PERSIST_THROTTLE_SEC:
                            storage.save_batch(batch)
                            self._persist_states(force=True)
                            last_persist = now
        except asyncio.CancelledError:
            batch["status"] = "cancelled"
            raise
        except Exception as exc:  # noqa: BLE001
            log.exception("Check failed: %s", exc)
            batch["status"] = "error"
            batch["error"] = str(exc)
        finally:
            if batch["status"] == "running":
                batch["status"] = "done"
            batch["finished_at"] = now_iso()
            if batch["results"]:
                storage.save_batch(batch)
            self._persist_states(force=True)
            self._current = None

            summary = {
                "type": "batch_done",
                "check_id": check_id,
                "check_time": check_time,
                "finished_at": batch["finished_at"],
                "status": batch["status"],
                "total": len(services),
                "success_count": batch["success_count"],
                "failed_count": batch["failed_count"],
                "skipped_count": batch["skipped_count"],
            }
            events.publish(summary)
            log.info(
                "Check %s finished: %s ok, %s failed, %s skipped",
                check_id,
                batch["success_count"],
                batch["failed_count"],
                batch["skipped_count"],
            )
        return {
            "message": "Проверка завершена",
            "check_id": check_id,
            "total_count": len(services),
            "success_count": batch["success_count"],
            "failed_count": batch["failed_count"],
        }

    async def _iter_results(
        self,
        services: list[Service],
        settings: Settings,
        session: aiohttp.ClientSession,
    ):
        semaphore = asyncio.Semaphore(settings.monitoring.concurrency)
        enabled = [service for service in services if service.enabled]
        disabled = [service for service in services if not service.enabled]

        for service in disabled:
            yield service, self._skipped_result(service, "Мониторинг отключён")

        async def worker(service: Service) -> dict[str, Any]:
            async with semaphore:
                try:
                    return await perform_check(service, settings, session=session)
                except asyncio.CancelledError:
                    raise
                except Exception as exc:  # noqa: BLE001
                    return {
                        "service_id": service.id,
                        "url": service.url,
                        "method": service.method,
                        "name": service.display_name,
                        "comment": service.comment,
                        "enabled": service.enabled,
                        "status_code": None,
                        "success": False,
                        "error": f"Ошибка проверки: {exc}",
                        "error_kind": "other",
                        "response_body": "",
                        "body_truncated": False,
                        "response_size": 0,
                        "response_size_partial": False,
                        "response_content_type": "",
                        "response_binary": False,
                        "duration_ms": 0,
                        "checked_at": now_iso(),
                    }

        tasks = [asyncio.create_task(worker(service), name=f"check-{service.id}") for service in enabled]
        try:
            for future in asyncio.as_completed(tasks):
                result = await future
                service = next((s for s in enabled if s.id == result.get("service_id")), None)
                if service is None:
                    continue
                yield service, result
        finally:
            for task in tasks:
                if not task.done():
                    task.cancel()

    @staticmethod
    def _skipped_result(service: Service, message: str) -> dict[str, Any]:
        return {
            "service_id": service.id,
            "url": service.url,
            "method": service.method,
            "name": service.display_name,
            "comment": service.comment,
            "enabled": False,
            "status_code": None,
            "success": None,
            "error": message,
            "error_kind": "disabled",
            "response_body": "",
            "body_truncated": False,
            "response_size": 0,
            "response_size_partial": False,
            "response_content_type": "",
            "response_binary": False,
            "duration_ms": 0,
            "checked_at": now_iso(),
        }

    # ── State and alerts ─────────────────────────────────────────────────
    def _service_state(self, service: Service) -> dict[str, Any]:
        return storage.states().get("services", {}).get(service.id, {})

    def _apply_result_state(self, service: Service, result: dict[str, Any], settings: Settings) -> None:
        states = storage.states()
        service_states = states.setdefault("services", {})
        previous = dict(service_states.get(service.id) or {})
        previous_success = previous.get("success")

        if result.get("success") is None:
            service_states[service.id] = {
                "success": None,
                "status_code": None,
                "duration_ms": 0,
                "checked_at": result.get("checked_at"),
                "error": result.get("error") or "Мониторинг отключён",
                "consecutive_failures": 0,
                "alerted": False,
                "last_alert_at": previous.get("last_alert_at"),
            }
            storage.save_states(states, persist=False)
            self._persist_states()
            return

        success = bool(result.get("success"))
        now_string = now_iso()
        state = {
            "success": success,
            "status_code": result.get("status_code"),
            "duration_ms": result.get("duration_ms"),
            "checked_at": result.get("checked_at") or now_string,
            "error": result.get("error"),
            "consecutive_failures": 0 if success else int(previous.get("consecutive_failures") or 0) + 1,
            "alerted": bool(previous.get("alerted")),
            "last_alert_at": previous.get("last_alert_at"),
        }

        if success:
            if previous_success is False and settings.notifications.notify_on_recovery:
                self._schedule_notification(service, result, "recovery", settings)
            state["alerted"] = False
            state["last_alert_at"] = None
        else:
            repeat_minutes = settings.notifications.repeat_interval_minutes
            edge = previous_success is not False
            repeat_due = False
            if repeat_minutes > 0 and state["alerted"] and state["last_alert_at"]:
                last_alert = _parse_iso(state["last_alert_at"])
                if last_alert is not None:
                    repeat_due = datetime.now().astimezone() - last_alert >= timedelta(minutes=repeat_minutes)
            targets = settings.notifications.targets_for(service)
            if targets and (edge or repeat_due):
                self._schedule_notification(service, result, "failure", settings)
                state["alerted"] = True
                state["last_alert_at"] = now_string

        service_states[service.id] = state
        storage.save_states(states, persist=False)
        self._persist_states()

    def _schedule_notification(
        self, service: Service, result: dict[str, Any], event: str, settings: Settings
    ) -> None:
        task = asyncio.create_task(
            notifications.dispatch(service, result, event, settings),
            name=f"notify-{service.id}-{event}",
        )
        self._notification_tasks.add(task)

        def done(completed: asyncio.Task) -> None:
            self._notification_tasks.discard(completed)
            if completed.cancelled():
                return
            error = completed.exception()
            if error:
                log.warning("Notification task failed: %s", error)

        task.add_done_callback(done)

    def _persist_states(self, force: bool = False) -> None:
        now = time.monotonic()
        if not force and now - self._last_state_persist < PERSIST_THROTTLE_SEC:
            return
        storage.save_states(storage.states())
        self._last_state_persist = now

    def reset_state(self, service_id: str) -> None:
        states = storage.states()
        if service_id in states.get("services", {}):
            states["services"].pop(service_id, None)
            storage.save_states(states)

    # ── Utilities / API support ──────────────────────────────────────────
    @staticmethod
    def _new_check_id() -> str:
        return f"{datetime.now().strftime('%Y%m%d-%H%M%S')}-{uuid.uuid4().hex[:6]}"

    @property
    def last_check_time(self) -> Optional[datetime]:
        return self._last_check_time

    def get_status(self) -> dict[str, Any]:
        settings = storage.settings()
        return {
            "auto_check_enabled": settings.monitoring.auto_check_enabled,
            "last_check_time": self._last_check_time.isoformat(timespec="seconds") if self._last_check_time else None,
            "check_interval": settings.monitoring.interval_seconds,
            "next_check_time": self.next_check_at.isoformat(timespec="seconds") if self.next_check_at else None,
            "checking": self._current is not None,
            "progress": dict(self._current) if self._current else None,
            "server_time": now_iso(),
            "version": config.APP_VERSION,
            "subscribers": events.subscriber_count(),
        }

    async def single_check(self, service: Service, include_headers: bool = True) -> dict[str, Any]:
        settings = storage.settings()
        return await perform_check(
            service,
            settings,
            body_limit=PREVIEW_BODY_LIMIT,
            include_headers=include_headers,
        )


monitor = Monitor()
