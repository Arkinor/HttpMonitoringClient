"""Notification delivery: Telegram, MAX, e-mail and generic webhook."""

from __future__ import annotations

import asyncio
import json
import smtplib
import ssl
from email.header import Header
from email.mime.text import MIMEText
from email.utils import formataddr
from typing import Any, Optional

import aiohttp

from servicemonitor import config
from servicemonitor.core.httpcheck import _safe_headers
from servicemonitor.models import CHANNEL_LABELS, EmailSettings, Service, Settings, now_iso
from servicemonitor.storage import storage

log = config.get_logger(__name__)

HTTP_TIMEOUT = 12
MAX_TEXT = 4000


class NotificationError(Exception):
    pass


def _result_line(result: dict[str, Any]) -> str:
    status_code = result.get("status_code")
    error = (result.get("error") or "").strip()
    if status_code is not None:
        return f"HTTP {status_code}" + (f" — {error}" if error and not error.startswith("HTTP ") else "")
    if error:
        return error
    return "Нет ответа"


def build_message(service: Service, result: dict[str, Any], event: str) -> str:
    name = service.display_name
    checked_at = result.get("checked_at") or now_iso()
    duration = result.get("duration_ms")
    duration_text = f"{duration} мс" if duration is not None else "—"
    comment = f"Комментарий: {service.comment}" if service.comment else ""

    if event == "recovery":
        title = "Сервис снова доступен"
        icon = "🟢"
    elif event == "test":
        title = "Тестовое уведомление"
        icon = "✅"
    else:
        title = "Сервис недоступен"
        icon = "🔴"

    lines = [
        f"{icon} {title}",
        "",
        name,
        service.url,
        f"Метод: {service.method}",
        f"Результат: {_result_line(result)}",
        f"Время: {checked_at}",
        f"Ответ: {duration_text}",
    ]
    if comment:
        lines.append(comment)
    lines.extend(["", config.APP_NAME])
    return "\n".join(lines)[:MAX_TEXT]


def _unwrap_response(text: str) -> str:
    return (text or "").strip().replace("\n", " ")[:300]


async def _send_telegram(settings: Settings, text: str) -> None:
    cfg = settings.notifications.telegram
    if not cfg.bot_token:
        raise NotificationError("Не указан токен бота")
    if not cfg.chat_id:
        raise NotificationError("Не указан chat_id")
    url = f"https://api.telegram.org/bot{cfg.bot_token}/sendMessage"
    payload = {
        "chat_id": cfg.chat_id,
        "text": text,
        "disable_web_page_preview": True,
    }
    if cfg.silent:
        payload["disable_notification"] = True

    timeout = aiohttp.ClientTimeout(total=HTTP_TIMEOUT)
    async with aiohttp.ClientSession(timeout=timeout) as session:
        async with session.post(url, json=payload) as response:
            body = await response.text()
            if response.status != 200:
                raise NotificationError(f"Telegram: HTTP {response.status}. {_unwrap_response(body)}")
            try:
                data = json.loads(body)
                if not data.get("ok"):
                    raise NotificationError(
                        f"Telegram: {data.get('description') or 'не удалось отправить сообщение'}"
                    )
            except json.JSONDecodeError:
                raise NotificationError("Telegram: некорректный ответ API")


async def _send_max(settings: Settings, text: str) -> None:
    cfg = settings.notifications.max
    if not cfg.token:
        raise NotificationError("Не указан токен бота MAX")
    params: dict[str, str] = {}
    if cfg.chat_id:
        params["chat_id"] = cfg.chat_id
    elif cfg.user_id:
        params["user_id"] = cfg.user_id
    else:
        raise NotificationError("Укажите chat_id или user_id")

    timeout = aiohttp.ClientTimeout(total=HTTP_TIMEOUT)
    headers = {"Authorization": cfg.token, "Content-Type": "application/json"}
    async with aiohttp.ClientSession(timeout=timeout) as session:
        async with session.post(
            "https://platform-api2.max.ru/messages",
            params=params,
            headers=headers,
            json={"text": text[:MAX_TEXT]},
        ) as response:
            body = await response.text()
            if response.status != 200:
                raise NotificationError(f"MAX: HTTP {response.status}. {_unwrap_response(body)}")


def _send_email_sync(settings: Settings, subject: str, text: str) -> None:
    cfg: EmailSettings = settings.notifications.email
    if not cfg.smtp_host:
        raise NotificationError("Не указан SMTP-сервер")
    recipients = [address for address in cfg.to_addrs if address]
    if not recipients:
        raise NotificationError("Не указаны получатели")
    sender = cfg.from_addr or cfg.username
    if not sender:
        raise NotificationError("Не указан адрес отправителя")

    message = MIMEText(text, "plain", "utf-8")
    message["Subject"] = Header(f"{cfg.subject_prefix} {subject}".strip(), "utf-8")
    message["From"] = formataddr((str(Header(config.APP_NAME, "utf-8")), sender))
    message["To"] = ", ".join(recipients)

    timeout = 15
    if cfg.security == "ssl":
        client = smtplib.SMTP_SSL(cfg.smtp_host, cfg.smtp_port, timeout=timeout, context=ssl.create_default_context())
    else:
        client = smtplib.SMTP(cfg.smtp_host, cfg.smtp_port, timeout=timeout)

    try:
        if cfg.security == "starttls":
            client.starttls(context=ssl.create_default_context())
        if cfg.username:
            client.login(cfg.username, cfg.password)
        client.sendmail(sender, recipients, message.as_string())
    finally:
        try:
            client.quit()
        except Exception:
            pass


EMAIL_SUBJECTS = {
    "failure": "Сервис недоступен",
    "recovery": "Сервис снова доступен",
    "test": "Тестовое уведомление",
}


async def _send_email(settings: Settings, text: str, subject: str) -> None:
    try:
        await asyncio.wait_for(asyncio.to_thread(_send_email_sync, settings, subject, text), timeout=30)
    except NotificationError:
        raise
    except Exception as exc:  # noqa: BLE001
        raise NotificationError(f"Почта: {exc}") from exc


def _webhook_payload(settings: Settings, service: Service, result: dict[str, Any], event: str) -> tuple[str, bool]:
    cfg = settings.notifications.webhook
    mapping = {
        "{app}": config.APP_NAME,
        "{event}": f"service_{'up' if event == 'recovery' else 'down'}" if event != "test" else "test",
        "{name}": service.display_name,
        "{url}": service.url,
        "{method}": service.method,
        "{status_code}": "" if result.get("status_code") is None else str(result.get("status_code")),
        "{error}": result.get("error") or "",
        "{duration_ms}": "" if result.get("duration_ms") is None else str(result.get("duration_ms")),
        "{checked_at}": result.get("checked_at") or now_iso(),
        "{service_id}": service.id,
        "{comment}": service.comment,
    }
    if cfg.payload_template.strip():
        payload = cfg.payload_template
        for key, value in mapping.items():
            payload = payload.replace(key, value)
        try:
            json.loads(payload)
            return payload, True
        except (ValueError, TypeError):
            return payload, False

    default = {
        "app": config.APP_NAME,
        "event": mapping["{event}"],
        "service": {
            "id": service.id,
            "name": service.display_name,
            "url": service.url,
            "method": service.method,
            "comment": service.comment,
        },
        "status": "ok" if event == "recovery" else ("test" if event == "test" else "error"),
        "status_code": result.get("status_code"),
        "error": result.get("error"),
        "duration_ms": result.get("duration_ms"),
        "checked_at": result.get("checked_at"),
    }
    return json.dumps(default, ensure_ascii=False), True


async def _send_webhook(
    settings: Settings, service: Service, result: dict[str, Any], event: str
) -> None:
    cfg = settings.notifications.webhook
    if not cfg.url:
        raise NotificationError("Не указан URL webhook")
    if not cfg.url.lower().startswith(("http://", "https://")):
        raise NotificationError("URL webhook должен начинаться с http:// или https://")

    payload, is_json = _webhook_payload(settings, service, result, event)
    headers = _safe_headers(cfg.enabled_headers())
    if is_json and not any(key.lower() == "content-type" for key in headers):
        headers["Content-Type"] = "application/json; charset=utf-8"
    if not is_json and not any(key.lower() == "content-type" for key in headers):
        headers["Content-Type"] = "text/plain; charset=utf-8"

    timeout = aiohttp.ClientTimeout(total=cfg.timeout_seconds)
    async with aiohttp.ClientSession(timeout=timeout) as session:
        async with session.request(
            cfg.method,
            cfg.url,
            data=payload.encode("utf-8"),
            headers=headers,
            ssl=cfg.verify_ssl,
        ) as response:
            body = await response.text()
            if not 200 <= response.status < 300:
                raise NotificationError(f"Webhook: HTTP {response.status}. {_unwrap_response(body)}")


async def send_channel(
    channel: str,
    settings: Settings,
    service: Service,
    result: dict[str, Any],
    event: str,
) -> None:
    text = build_message(service, result, event)
    if channel == "telegram":
        await _send_telegram(settings, text)
    elif channel == "max":
        await _send_max(settings, text)
    elif channel == "email":
        await _send_email(settings, text, EMAIL_SUBJECTS.get(event, "Service Monitor"))
    elif channel == "webhook":
        await _send_webhook(settings, service, result, event)
    else:
        raise NotificationError(f"Неизвестный канал: {channel}")


def _log_entry(
    channel: str,
    event: str,
    service: Service,
    result: dict[str, Any],
    success: bool,
    error: Optional[str],
) -> None:
    storage.add_notification_log(
        {
            "time": now_iso(),
            "channel": channel,
            "channel_label": CHANNEL_LABELS.get(channel, channel),
            "event": event,
            "service_id": service.id,
            "service_name": service.display_name,
            "url": service.url,
            "status_code": result.get("status_code"),
            "success": success,
            "error": error,
        }
    )


async def dispatch(
    service: Service,
    result: dict[str, Any],
    event: str,
    settings: Optional[Settings] = None,
) -> list[dict[str, Any]]:
    """Send a notification to every channel selected for the service."""
    current = settings or storage.settings()
    targets = current.notifications.targets_for(service)
    if not targets:
        return []

    outcomes: list[dict[str, Any]] = []
    for channel in targets:
        try:
            await send_channel(channel, current, service, result, event)
            outcomes.append({"channel": channel, "success": True})
            _log_entry(channel, event, service, result, True, None)
        except Exception as exc:  # noqa: BLE001
            message = str(exc).strip() or exc.__class__.__name__
            outcomes.append({"channel": channel, "success": False, "error": message})
            _log_entry(channel, event, service, result, False, message)
            log.warning("Notification to %s failed for %s: %s", channel, service.url, message)
    return outcomes


async def test_channel(
    channel: str,
    settings: Settings,
) -> dict[str, Any]:
    service = Service(
        url="https://example.com/health",
        method="GET",
        name="Тестовый сервис",
        comment="Проверка настроек уведомлений",
        notify_on_error=True,
    )
    result = {
        "status_code": 200,
        "success": True,
        "error": None,
        "duration_ms": 12,
        "checked_at": now_iso(),
    }
    try:
        await send_channel(channel, settings, service, result, "test")
        _log_entry(channel, "test", service, result, True, None)
        return {"success": True, "message": f"{CHANNEL_LABELS.get(channel, channel)}: уведомление отправлено"}
    except Exception as exc:  # noqa: BLE001
        message = str(exc).strip() or exc.__class__.__name__
        _log_entry(channel, "test", service, result, False, message)
        return {"success": False, "message": message}
