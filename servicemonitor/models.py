"""Data models used by the API and stored in JSON files."""

from __future__ import annotations

import json
import re
import uuid
from datetime import datetime
from typing import Any, Literal, Optional

from pydantic import BaseModel, ConfigDict, Field, field_validator, model_validator

from servicemonitor import config

METHODS = ("GET", "POST", "PUT", "PATCH", "DELETE", "HEAD", "OPTIONS")
CHANNELS = ("telegram", "max", "email", "webhook")
CHANNEL_LABELS = {
    "telegram": "Telegram",
    "max": "MAX",
    "email": "Почта",
    "webhook": "Webhook",
}


def now_iso() -> str:
    return datetime.now().astimezone().isoformat(timespec="seconds")


def parse_expected_status(spec: str) -> set[int]:
    """Parse '200-299', '200, 201', '2xx' or a combination."""
    value = (spec or "").strip()
    if not value:
        return set(range(200, 300))

    codes: set[int] = set()
    tokens = [t for t in re.split(r"[,;\s]+", value) if t]
    if not tokens:
        raise ValueError("Укажите ожидаемые коды, например 200-299")

    for token in tokens:
        low = token.lower()
        if re.fullmatch(r"\d{3}", low):
            code = int(low)
            if not 100 <= code <= 599:
                raise ValueError(f"Недопустимый код: {token}")
            codes.add(code)
            continue
        if re.fullmatch(r"[1-5]xx", low):
            base = int(low[0]) * 100
            codes.update(range(base, base + 100))
            continue
        match = re.fullmatch(r"(\d{3})-(\d{3})", low)
        if match:
            start, end = int(match.group(1)), int(match.group(2))
            if not (100 <= start <= end <= 599):
                raise ValueError(f"Недопустимый диапазон: {token}")
            codes.update(range(start, end + 1))
            continue
        raise ValueError(f"Недопустимый код или диапазон: {token}")

    if not codes:
        raise ValueError("Укажите ожидаемые коды, например 200-299")
    return codes


class Header(BaseModel):
    model_config = ConfigDict(extra="ignore")
    key: str = ""
    value: str = ""
    enabled: bool = True

    @field_validator("key", "value", mode="before")
    @classmethod
    def _string(cls, value: Any) -> str:
        return "" if value is None else str(value)


class Auth(BaseModel):
    model_config = ConfigDict(extra="ignore")
    type: Literal["none", "basic", "bearer"] = "none"
    username: str = ""
    password: str = ""
    token: str = ""

    @field_validator("username", "password", "token", mode="before")
    @classmethod
    def _string(cls, value: Any) -> str:
        return "" if value is None else str(value)


class Service(BaseModel):
    model_config = ConfigDict(extra="ignore")

    id: str = Field(default_factory=lambda: uuid.uuid4().hex)
    name: str = ""
    url: str
    method: str = "GET"
    headers: list[Header] = Field(default_factory=list)
    auth: Auth = Field(default_factory=Auth)
    body: str = ""
    expected_status: str = "200-299"
    timeout_seconds: Optional[float] = None
    follow_redirects: Optional[bool] = None
    verify_ssl: Optional[bool] = None
    body_contains: Optional[str] = None
    comment: str = ""
    enabled: bool = True
    notify_on_error: bool = True
    notify_channels: Optional[list[str]] = None
    created_at: str = Field(default_factory=now_iso)
    updated_at: str = Field(default_factory=now_iso)

    @model_validator(mode="before")
    @classmethod
    def _legacy(cls, data: Any) -> Any:
        if not isinstance(data, dict):
            return data
        data = dict(data)

        # Old format kept login/password at the top level.
        login = data.pop("login", None)
        password = data.pop("password", None)
        if "auth" not in data and (login or password):
            data["auth"] = {
                "type": "basic",
                "username": login or "",
                "password": password or "",
            }

        # Old format stored request_body as a JSON object.
        old_body = data.pop("request_body", None)
        if old_body is not None and not data.get("body"):
            if isinstance(old_body, str):
                data["body"] = old_body
            else:
                data["body"] = json.dumps(old_body, ensure_ascii=False, indent=2)

        headers = data.get("headers")
        if isinstance(headers, dict):
            data["headers"] = [
                {"key": str(k), "value": "" if v is None else str(v), "enabled": True}
                for k, v in headers.items()
            ]

        body = data.get("body")
        if isinstance(body, (dict, list)):
            data["body"] = json.dumps(body, ensure_ascii=False, indent=2)

        if not data.get("id"):
            data["id"] = uuid.uuid4().hex
        if data.get("name") is None:
            data["name"] = ""
        if data.get("comment") is None:
            data["comment"] = ""
        return data

    @field_validator("url")
    @classmethod
    def _url(cls, value: str) -> str:
        value = (value or "").strip()
        if not value:
            raise ValueError("Укажите URL сервиса")
        if not re.match(r"^https?://", value, re.IGNORECASE):
            raise ValueError("URL должен начинаться с http:// или https://")
        return value

    @field_validator("method")
    @classmethod
    def _method(cls, value: str) -> str:
        method = (value or "GET").strip().upper()
        if method not in METHODS:
            raise ValueError(f"Метод должен быть одним из: {', '.join(METHODS)}")
        return method

    @field_validator("expected_status")
    @classmethod
    def _expected_status(cls, value: str) -> str:
        value = (value or "200-299").strip()
        parse_expected_status(value)
        return value

    @field_validator("timeout_seconds")
    @classmethod
    def _timeout(cls, value: Optional[float]) -> Optional[float]:
        if value is None or value == 0:
            return None
        if value < 0.5 or value > 120:
            raise ValueError("Таймаут должен быть от 0,5 до 120 секунд")
        return float(value)

    @field_validator("notify_channels")
    @classmethod
    def _channels(cls, value: Optional[list[str]]) -> Optional[list[str]]:
        if value is None:
            return None
        cleaned: list[str] = []
        for item in value:
            name = str(item).strip().lower()
            if name in CHANNELS and name not in cleaned:
                cleaned.append(name)
        return cleaned

    @property
    def display_name(self) -> str:
        if self.name.strip():
            return self.name.strip()
        if self.comment.strip():
            return self.comment.strip()
        return self.url

    def enabled_headers(self) -> dict[str, str]:
        return {
            h.key.strip(): h.value
            for h in self.headers
            if h.enabled and h.key.strip()
        }


class AppSettings(BaseModel):
    model_config = ConfigDict(extra="ignore")
    host: str = config.DEFAULT_HOST
    port: int = Field(default=config.DEFAULT_PORT, ge=1, le=65535)
    open_browser_on_start: bool = True
    start_minimized: bool = False
    start_with_windows: bool = False
    tray_notifications: bool = True

    @field_validator("host")
    @classmethod
    def _host(cls, value: str) -> str:
        value = (value or config.DEFAULT_HOST).strip()
        if not value:
            raise ValueError("Укажите адрес прослушивания")
        return value


class MonitoringSettings(BaseModel):
    model_config = ConfigDict(extra="ignore")
    interval_seconds: int = Field(default=config.DEFAULT_INTERVAL, ge=config.MIN_INTERVAL, le=config.MAX_INTERVAL)
    timeout_seconds: float = Field(default=15, ge=1, le=120)
    concurrency: int = Field(default=8, ge=1, le=32)
    verify_ssl: bool = False
    follow_redirects: bool = True
    auto_check_enabled: bool = True
    history_limit: int = Field(default=100, ge=10, le=1000)


class TelegramSettings(BaseModel):
    model_config = ConfigDict(extra="ignore")
    enabled: bool = False
    bot_token: str = ""
    chat_id: str = ""
    silent: bool = False

    @field_validator("bot_token", "chat_id", mode="before")
    @classmethod
    def _string(cls, value: Any) -> str:
        return "" if value is None else str(value).strip()


class MaxSettings(BaseModel):
    model_config = ConfigDict(extra="ignore")
    enabled: bool = False
    token: str = ""
    chat_id: str = ""
    user_id: str = ""

    @field_validator("token", "chat_id", "user_id", mode="before")
    @classmethod
    def _string(cls, value: Any) -> str:
        return "" if value is None else str(value).strip()


class EmailSettings(BaseModel):
    model_config = ConfigDict(extra="ignore")
    enabled: bool = False
    smtp_host: str = ""
    smtp_port: int = Field(default=465, ge=1, le=65535)
    security: Literal["ssl", "starttls", "none"] = "ssl"
    username: str = ""
    password: str = ""
    from_addr: str = ""
    to_addrs: list[str] = Field(default_factory=list)
    subject_prefix: str = "[Мониторинг]"

    @field_validator("to_addrs", mode="before")
    @classmethod
    def _addresses(cls, value: Any) -> list[str]:
        if value is None:
            return []
        if isinstance(value, str):
            parts = re.split(r"[,;\s]+", value)
        else:
            parts = [str(v) for v in value]
        result: list[str] = []
        for part in parts:
            address = part.strip()
            if not address:
                continue
            if "\n" in address or "\r" in address:
                raise ValueError("Некорректный адрес электронной почты")
            result.append(address)
        return result

    @field_validator("smtp_host", "username", "password", "from_addr", "subject_prefix", mode="before")
    @classmethod
    def _string(cls, value: Any) -> str:
        return "" if value is None else str(value).strip()


class WebhookSettings(BaseModel):
    model_config = ConfigDict(extra="ignore")
    enabled: bool = False
    url: str = ""
    method: Literal["POST", "PUT"] = "POST"
    headers: list[Header] = Field(default_factory=list)
    payload_template: str = ""
    timeout_seconds: float = Field(default=10, ge=1, le=60)
    verify_ssl: bool = True

    @field_validator("url", "payload_template", mode="before")
    @classmethod
    def _string(cls, value: Any) -> str:
        return "" if value is None else str(value).strip()

    @model_validator(mode="before")
    @classmethod
    def _headers(cls, data: Any) -> Any:
        if isinstance(data, dict) and isinstance(data.get("headers"), dict):
            data = dict(data)
            data["headers"] = [
                {"key": str(k), "value": "" if v is None else str(v)}
                for k, v in data["headers"].items()
            ]
        return data

    def enabled_headers(self) -> dict[str, str]:
        return {
            h.key.strip(): h.value
            for h in self.headers
            if h.enabled and h.key.strip()
        }


class NotificationSettings(BaseModel):
    model_config = ConfigDict(extra="ignore")
    enabled: bool = True
    notify_on_recovery: bool = True
    repeat_interval_minutes: int = Field(default=0, ge=0, le=1440)
    telegram: TelegramSettings = Field(default_factory=TelegramSettings)
    max: MaxSettings = Field(default_factory=MaxSettings)
    email: EmailSettings = Field(default_factory=EmailSettings)
    webhook: WebhookSettings = Field(default_factory=WebhookSettings)

    def channel(self, name: str) -> BaseModel:
        return getattr(self, name)

    def enabled_channels(self) -> list[str]:
        return [name for name in CHANNELS if getattr(self, name).enabled]

    def targets_for(self, service: Service) -> list[str]:
        available = self.enabled_channels()
        if not self.enabled or not service.notify_on_error:
            return []
        if service.notify_channels is None:
            return available
        return [name for name in available if name in service.notify_channels]


class Settings(BaseModel):
    model_config = ConfigDict(extra="ignore")
    app: AppSettings = Field(default_factory=AppSettings)
    monitoring: MonitoringSettings = Field(default_factory=MonitoringSettings)
    notifications: NotificationSettings = Field(default_factory=NotificationSettings)


class TestNotificationRequest(BaseModel):
    channel: Literal["telegram", "max", "email", "webhook"]
    config: dict[str, Any] = Field(default_factory=dict)


class AutoCheckRequest(BaseModel):
    enabled: bool


class IntervalRequest(BaseModel):
    interval: int = Field(
        ge=config.MIN_INTERVAL,
        le=config.MAX_INTERVAL,
        description="Интервал автоматической проверки в секундах",
    )


class BackupPayload(BaseModel):
    version: str = ""
    exported_at: str = ""
    services: list[Service] = Field(default_factory=list)
    settings: Optional[Settings] = None
