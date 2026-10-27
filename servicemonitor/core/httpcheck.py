"""HTTP request execution used by the monitoring engine and the editor."""

from __future__ import annotations

import asyncio
import base64
import json
import time
from typing import Any, Optional

import aiohttp

from servicemonitor import config
from servicemonitor.models import Service, Settings, now_iso, parse_expected_status

log = config.get_logger(__name__)

STORED_BODY_LIMIT = 2000
PREVIEW_BODY_LIMIT = 20000
RAW_READ_LIMIT = 64 * 1024

TEXT_MIME_TYPES = {
    "application/json",
    "application/xml",
    "application/javascript",
    "application/x-javascript",
    "application/x-www-form-urlencoded",
    "application/graphql",
    "application/ld+json",
    "application/problem+json",
    "image/svg+xml",
}


def _is_textual(content_type: str) -> bool:
    mime = (content_type or "").split(";", 1)[0].strip().lower()
    if not mime or mime.startswith("text/"):
        return True
    if mime in TEXT_MIME_TYPES:
        return True
    return mime.endswith("+json") or mime.endswith("+xml")



def _decode_body(raw: bytes, charset: Optional[str]) -> str:
    encoding = charset or "utf-8"
    try:
        return raw.decode(encoding, errors="replace")
    except LookupError:
        return raw.decode("utf-8", errors="replace")


def _request_kwargs(service: Service, settings: Settings) -> dict[str, Any]:
    headers = service.enabled_headers()
    auth = service.auth
    request_auth: Optional[aiohttp.BasicAuth] = None

    if auth.type == "basic" and (auth.username or auth.password):
        request_auth = aiohttp.BasicAuth(auth.username, auth.password)
    elif auth.type == "bearer" and auth.token:
        headers.setdefault("Authorization", f"Bearer {auth.token}")

    body = service.body or ""
    data: Optional[str] = None
    if body.strip() and service.method.upper() not in ("GET", "HEAD"):
        data = body
        if not any(key.lower() == "content-type" for key in headers):
            try:
                json.loads(body)
                headers["Content-Type"] = "application/json; charset=utf-8"
            except (ValueError, TypeError):
                headers["Content-Type"] = "text/plain; charset=utf-8"

    timeout_value = service.timeout_seconds or settings.monitoring.timeout_seconds
    expected_ssl = settings.monitoring.verify_ssl if service.verify_ssl is None else service.verify_ssl
    expected_redirects = (
        settings.monitoring.follow_redirects
        if service.follow_redirects is None
        else service.follow_redirects
    )

    kwargs: dict[str, Any] = {
        "headers": headers,
        "timeout": aiohttp.ClientTimeout(total=float(timeout_value)),
        "ssl": bool(expected_ssl),
        "allow_redirects": bool(expected_redirects),
    }
    if request_auth is not None:
        kwargs["auth"] = request_auth
    if data is not None:
        kwargs["data"] = data
    return kwargs


def _friendly_error(exc: BaseException) -> tuple[str, str]:
    if isinstance(exc, asyncio.TimeoutError):
        return "timeout", "Превышено время ожидания ответа"
    if isinstance(exc, aiohttp.ClientConnectorCertificateError):
        return "tls", "Ошибка TLS-сертификата"
    if isinstance(exc, aiohttp.ClientSSLError):
        return "tls", "Ошибка TLS-соединения"
    if isinstance(exc, aiohttp.TooManyRedirects):
        return "redirect", "Слишком много перенаправлений"
    if isinstance(exc, aiohttp.ServerDisconnectedError):
        return "connection", "Сервер разорвал соединение"
    if isinstance(exc, aiohttp.ClientConnectorError):
        return "connection", f"Не удалось подключиться: {exc.os_error or exc}"
    if isinstance(exc, aiohttp.ClientResponseError):
        return "http", f"Ошибка ответа: HTTP {exc.status}"
    if isinstance(exc, aiohttp.ClientError):
        text = str(exc).strip() or exc.__class__.__name__
        return "connection", f"Ошибка соединения: {text}"
    text = str(exc).strip() or exc.__class__.__name__
    return "other", text


async def perform_check(
    service: Service,
    settings: Settings,
    session: Optional[aiohttp.ClientSession] = None,
    body_limit: int = STORED_BODY_LIMIT,
    include_headers: bool = False,
) -> dict[str, Any]:
    """Execute one request and return a serializable result."""
    started = time.perf_counter()
    own_session = session is None
    client = session
    if client is None:
        connector = aiohttp.TCPConnector(limit=32, ssl=False)
        client = aiohttp.ClientSession(connector=connector)

    status_code: Optional[int] = None
    response_body = ""
    response_headers: dict[str, str] = {}
    response_content_type = ""
    response_size = 0
    response_size_partial = False
    response_binary = False
    raw = b""
    truncated = False
    error: Optional[str] = None
    error_kind: Optional[str] = None
    success = False

    try:
        kwargs = _request_kwargs(service, settings)
        async with client.request(service.method, service.url, **kwargs) as response:
            status_code = response.status
            response_headers = dict(response.headers)
            response_content_type = response_headers.get("Content-Type", "")
            content_length = response_headers.get("Content-Length", "")
            try:
                raw = await response.content.read(RAW_READ_LIMIT)
                truncated = len(raw) >= RAW_READ_LIMIT
                response_size = len(raw)
                if content_length.isdigit():
                    response_size = int(content_length)
                elif truncated:
                    response_size_partial = True
                if _is_textual(response_content_type):
                    text = _decode_body(raw, response.charset)
                else:
                    response_binary = True
                    text = ""
            except Exception as exc:  # response body is optional for availability
                log.debug("Cannot read response body for %s: %s", service.url, exc)
                text = ""

            response_body = text[:body_limit]
            if len(text) > body_limit:
                truncated = True

            expected = parse_expected_status(service.expected_status)
            if status_code not in expected:
                error = f"HTTP {status_code} (ожидался {service.expected_status})"
                error_kind = "http"
            elif service.body_contains and service.body_contains not in text:
                error = "В ответе нет ожидаемого текста"
                error_kind = "body"
            else:
                success = True
    except asyncio.CancelledError:
        raise
    except Exception as exc:  # noqa: BLE001 - a failed probe must never crash the loop
        error_kind, error = _friendly_error(exc)
    finally:
        if own_session and client is not None:
            await client.close()

    duration_ms = max(0, int((time.perf_counter() - started) * 1000))
    result: dict[str, Any] = {
        "service_id": service.id,
        "url": service.url,
        "method": service.method,
        "name": service.display_name,
        "comment": service.comment,
        "enabled": service.enabled,
        "status_code": status_code,
        "success": success,
        "error": error,
        "error_kind": error_kind,
        "response_body": response_body,
        "body_truncated": truncated,
        "response_size": response_size,
        "response_size_partial": response_size_partial,
        "response_content_type": response_content_type,
        "response_binary": response_binary,
        "duration_ms": duration_ms,
        "checked_at": now_iso(),
    }
    if include_headers:
        result["response_headers"] = response_headers
        if response_binary and raw:
            result["response_body_base64"] = base64.b64encode(raw).decode("ascii")
    return result
