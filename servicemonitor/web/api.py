"""HTTP API consumed by the web interface and the tray."""

from __future__ import annotations

import asyncio
import os
from typing import Any, Optional

from fastapi import APIRouter, HTTPException, Query, Request
from fastapi.responses import JSONResponse, StreamingResponse

from servicemonitor import config, events
from servicemonitor.core import network
from servicemonitor.core.monitor import monitor
from servicemonitor.desktop import autostart
from servicemonitor.models import (
    AutoCheckRequest,
    BackupPayload,
    IntervalRequest,
    Service,
    Settings,
    TestNotificationRequest,
    now_iso,
)
from servicemonitor.notify import channels as notifications
from servicemonitor.storage import storage

router = APIRouter(prefix="/api")

log = config.get_logger(__name__)


# ── State / dashboard ────────────────────────────────────────────────────
def _channel_summary(settings: Settings) -> list[dict[str, Any]]:
    n = settings.notifications
    return [
        {
            "id": "telegram",
            "label": "Telegram",
            "enabled": n.telegram.enabled,
            "configured": bool(n.telegram.bot_token and n.telegram.chat_id),
        },
        {
            "id": "max",
            "label": "MAX",
            "enabled": n.max.enabled,
            "configured": bool(n.max.token and (n.max.chat_id or n.max.user_id)),
        },
        {
            "id": "email",
            "label": "Почта",
            "enabled": n.email.enabled,
            "configured": bool(
                n.email.smtp_host
                and n.email.to_addrs
                and (n.email.from_addr or n.email.username)
            ),
        },
        {
            "id": "webhook",
            "label": "Webhook",
            "enabled": n.webhook.enabled,
            "configured": bool(n.webhook.url),
        },
    ]


def _counts(services: list[Service], states: dict[str, Any]) -> dict[str, int]:
    result = {"total": len(services), "enabled": 0, "ok": 0, "error": 0, "unknown": 0, "disabled": 0}
    for service in services:
        if not service.enabled:
            result["disabled"] += 1
            continue
        result["enabled"] += 1
        state = states.get(service.id) or {}
        if state.get("success") is True:
            result["ok"] += 1
        elif state.get("success") is False:
            result["error"] += 1
        else:
            result["unknown"] += 1
    return result


def _public_batches(batches: list[dict[str, Any]]) -> list[dict[str, Any]]:
    """Strip payloads that only the live test panel needs."""
    cleaned: list[dict[str, Any]] = []
    for batch in batches:
        item = {key: value for key, value in batch.items() if key != "results"}
        results = []
        for result in batch.get("results") or []:
            row = dict(result)
            row.pop("response_body", None)
            row.pop("response_headers", None)
            results.append(row)
        item["results"] = results
        cleaned.append(item)
    return cleaned


@router.get("/state")
async def get_state() -> dict[str, Any]:
    settings = storage.settings()
    services = storage.services()
    states = storage.states().get("services", {})
    return {
        "app": {"name": config.APP_NAME, "version": config.APP_VERSION},
        "services": [service.model_dump() for service in services],
        "states": states,
        "results": _public_batches(storage.results(limit=settings.monitoring.history_limit)),
        "status": monitor.get_status(),
        "counts": _counts(services, states),
        "channels": _channel_summary(settings),
        "system": network.server_info(),
        "preferences": {"tray_notifications": settings.app.tray_notifications},
    }


@router.get("/status")
async def get_status() -> dict[str, Any]:
    services = storage.services()
    states = storage.states().get("services", {})
    status = monitor.get_status()
    status["counts"] = _counts(services, states)
    status["system"] = network.server_info()
    status["problems"] = [
        {
            "id": service.id,
            "name": service.display_name,
            "url": service.url,
            "error": (states.get(service.id) or {}).get("error"),
        }
        for service in services
        if service.enabled and (states.get(service.id) or {}).get("success") is False
    ]
    return status


@router.get("/results")
async def get_results(limit: int = Query(default=100, ge=1, le=1000)) -> list[dict[str, Any]]:
    return _public_batches(storage.results(limit=limit))


# ── Services ─────────────────────────────────────────────────────────────
@router.get("/services")
async def list_services() -> list[dict[str, Any]]:
    return [service.model_dump() for service in storage.services()]


@router.get("/services/{service_id}")
async def get_service(service_id: str) -> dict[str, Any]:
    service = storage.service(service_id)
    if not service:
        raise HTTPException(404, "Сервис не найден")
    return service.model_dump()


@router.post("/services", status_code=201)
async def create_service(service: Service) -> dict[str, Any]:
    if storage.service(service.id):
        raise HTTPException(409, "Сервис с таким идентификатором уже существует")
    created = storage.add_service(service)
    events.publish({"type": "services_changed", "action": "created", "service_id": created.id})
    log.info("Service added: %s (%s)", created.display_name, created.url)
    return created.model_dump()


@router.put("/services/{service_id}")
async def update_service(service_id: str, service: Service) -> dict[str, Any]:
    existing = storage.service(service_id)
    if not existing:
        raise HTTPException(404, "Сервис не найден")
    service.id = service_id
    critical_before = (
        existing.url,
        existing.method,
        existing.headers,
        existing.auth,
        existing.body,
        existing.expected_status,
        existing.body_contains,
        existing.timeout_seconds,
        existing.follow_redirects,
        existing.verify_ssl,
    )
    critical_after = (
        service.url,
        service.method,
        service.headers,
        service.auth,
        service.body,
        service.expected_status,
        service.body_contains,
        service.timeout_seconds,
        service.follow_redirects,
        service.verify_ssl,
    )
    if critical_before != critical_after:
        monitor.reset_state(service_id)
    updated = storage.update_service(service)
    events.publish({"type": "services_changed", "action": "updated", "service_id": updated.id})
    return updated.model_dump()


@router.delete("/services/{service_id}")
async def delete_service(service_id: str) -> dict[str, Any]:
    if not storage.delete_service(service_id):
        raise HTTPException(404, "Сервис не найден")
    events.publish({"type": "services_changed", "action": "deleted", "service_id": service_id})
    return {"success": True}


@router.post("/services/test")
async def test_service(service: Service) -> dict[str, Any]:
    result = await monitor.single_check(service, include_headers=True)
    return result


@router.post("/services/{service_id}/test")
async def test_saved_service(service_id: str) -> dict[str, Any]:
    service = storage.service(service_id)
    if not service:
        raise HTTPException(404, "Сервис не найден")
    return await monitor.single_check(service, include_headers=True)


# Legacy whole-list endpoint kept for existing integrations.
@router.get("/bases")
async def legacy_get_bases() -> list[dict[str, Any]]:
    return [service.model_dump() for service in storage.services()]


@router.post("/bases")
async def legacy_save_bases(services: list[Service]) -> dict[str, Any]:
    storage.save_services(services)
    events.publish({"type": "services_changed", "action": "replaced"})
    return {"message": "Сервисы сохранены", "count": len(services)}


# ── Monitoring ───────────────────────────────────────────────────────────
@router.post("/check")
async def start_check() -> dict[str, Any]:
    started, check_id, current = monitor.request_check("manual")
    if not started:
        return {
            "started": False,
            "running": True,
            "check_id": check_id,
            "progress": current,
            "message": "Проверка уже выполняется",
        }
    return {"started": True, "running": True, "check_id": check_id, "message": "Проверка запущена"}


@router.post("/set_interval")
async def set_interval(request: IntervalRequest) -> dict[str, Any]:
    settings = monitor.set_interval(request.interval)
    return {"interval": settings.monitoring.interval_seconds, "status": monitor.get_status()}


@router.post("/monitoring")
async def set_monitoring(request: AutoCheckRequest) -> dict[str, Any]:
    settings = await monitor.set_auto_check(request.enabled)
    return {"auto_check_enabled": settings.monitoring.auto_check_enabled, "status": monitor.get_status()}


@router.get("/stream")
async def stream(request: Request) -> StreamingResponse:
    async def event_source():
        queue = events.subscribe()
        try:
            yield events.format_sse(
                {
                    "type": "connected",
                    "status": monitor.get_status(),
                    "server_time": now_iso(),
                }
            )
            while not await request.is_disconnected():
                try:
                    event = await asyncio.wait_for(queue.get(), timeout=15)
                    yield events.format_sse(event)
                except asyncio.TimeoutError:
                    yield ": keep-alive\n\n"
        finally:
            events.unsubscribe(queue)

    return StreamingResponse(
        event_source(),
        media_type="text/event-stream",
        headers={
            "Cache-Control": "no-cache, no-transform",
            "Connection": "keep-alive",
            "X-Accel-Buffering": "no",
        },
    )


# ── Settings ─────────────────────────────────────────────────────────────
@router.get("/settings")
async def get_settings() -> dict[str, Any]:
    return storage.settings().model_dump()


@router.put("/settings")
async def update_settings(settings: Settings) -> dict[str, Any]:
    previous = storage.settings()
    autostart_error: Optional[str] = None
    if settings.app.start_with_windows != previous.app.start_with_windows:
        ok, autostart_error = autostart.set_enabled(settings.app.start_with_windows)
        if not ok and settings.app.start_with_windows:
            log.warning("Autostart was not enabled: %s", autostart_error)

    saved = storage.save_settings(settings)
    monitor.settings_changed()
    events.publish({"type": "settings_changed", "status": monitor.get_status()})

    restart_required = (
        saved.app.host != previous.app.host or saved.app.port != previous.app.port
    )
    return {
        "settings": saved.model_dump(),
        "restart_required": restart_required,
        "autostart_error": autostart_error,
    }


@router.post("/settings/test-notification")
async def test_notification(request: TestNotificationRequest) -> dict[str, Any]:
    settings = storage.settings()
    template = settings.notifications.channel(request.channel)
    try:
        channel_settings = type(template).model_validate(request.config)
    except Exception as exc:  # noqa: BLE001
        raise HTTPException(422, f"Проверьте настройки канала: {exc}") from exc
    setattr(settings.notifications, request.channel, channel_settings)
    return await notifications.test_channel(request.channel, settings)


@router.get("/notifications/log")
async def notification_log(limit: int = Query(default=50, ge=1, le=200)) -> list[dict[str, Any]]:
    return storage.notifications(limit=limit)


# ── Backup / restore ─────────────────────────────────────────────────────
@router.get("/backup")
async def export_backup() -> JSONResponse:
    payload = storage.export_backup()
    filename = f"service-monitor-backup-{now_iso()[:10]}.json"
    return JSONResponse(
        content=payload,
        headers={"Content-Disposition": f'attachment; filename="{filename}"'},
    )


@router.post("/restore")
async def restore_backup(payload: BackupPayload) -> dict[str, Any]:
    settings = payload.settings or storage.settings()
    storage.restore_backup(payload.services, settings)
    if settings.app.start_with_windows:
        autostart.set_enabled(True)
    monitor.settings_changed()
    events.publish({"type": "services_changed", "action": "restored"})
    events.publish({"type": "settings_changed", "status": monitor.get_status()})
    return {
        "success": True,
        "services": len(payload.services),
        "message": "Резервная копия восстановлена",
    }


@router.get("/health")
async def health() -> dict[str, Any]:
    return {"status": "ok", "version": config.APP_VERSION, "time": now_iso()}


@router.get("/open-data-dir")
async def open_data_dir() -> dict[str, Any]:
    path = config.data_dir()
    if os.name == "nt":
        try:
            os.startfile(path)  # type: ignore[attr-defined]
            return {"success": True, "path": str(path)}
        except OSError as exc:
            raise HTTPException(500, f"Не удалось открыть папку: {exc}") from exc
    return {"success": False, "path": str(path)}
