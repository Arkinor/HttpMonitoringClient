"""Application paths, constants, runtime overrides and logging."""

from __future__ import annotations

import logging
import os
import sys
from logging.handlers import RotatingFileHandler
from pathlib import Path

APP_NAME = "Service Monitor"
APP_VERSION = "3.2.0"
APP_ID = "ServiceMonitor"

DEFAULT_HOST = "0.0.0.0"
DEFAULT_PORT = 8062
DEFAULT_INTERVAL = 600
MIN_INTERVAL = 10
MAX_INTERVAL = 86400

DATA_DIR_NAME = "data"
HISTORY_FILE = "history.json"

_DATA_DIR: Path | None = None
_CUSTOM_DATA_DIR = False
_RUNTIME_HOST: str | None = None
_RUNTIME_PORT: int | None = None
_LOG_CONFIGURED = False


def is_frozen() -> bool:
    return bool(getattr(sys, "frozen", False))


def application_dir() -> Path:
    """Directory that contains the executable (or the project root in development)."""
    if is_frozen():
        return Path(sys.executable).resolve().parent
    return Path(__file__).resolve().parent.parent


def resource_dir() -> Path:
    """Directory with bundled read-only resources (web interface)."""
    if is_frozen():
        return Path(getattr(sys, "_MEIPASS", application_dir()))
    return Path(__file__).resolve().parent


def resource_path(*parts: str) -> Path:
    return resource_dir().joinpath(*parts)


def _writable(path: Path) -> bool:
    try:
        path.mkdir(parents=True, exist_ok=True)
        probe = path / f".write-check-{os.getpid()}"
        probe.write_text("ok", encoding="utf-8")
        probe.unlink()
        return True
    except OSError:
        return False


def _fallback_data_dir() -> Path:
    local = os.environ.get("LOCALAPPDATA")
    return Path(local) / "ServiceMonitor" if local else Path.home() / ".service-monitor"


def _default_data_dir() -> Path:
    env_dir = os.environ.get("SERVICE_MONITOR_DATA")
    if env_dir:
        return Path(env_dir).expanduser().resolve()

    preferred = application_dir() / DATA_DIR_NAME
    if _writable(preferred):
        return preferred

    fallback = _fallback_data_dir()
    fallback.mkdir(parents=True, exist_ok=True)
    return fallback


def set_data_dir(path: str | Path) -> Path:
    global _DATA_DIR, _CUSTOM_DATA_DIR
    candidate = Path(path).expanduser().resolve()
    candidate.mkdir(parents=True, exist_ok=True)
    _DATA_DIR = candidate
    _CUSTOM_DATA_DIR = True
    return candidate


def data_dir() -> Path:
    global _DATA_DIR
    if _DATA_DIR is None:
        _DATA_DIR = _default_data_dir()
        _DATA_DIR.mkdir(parents=True, exist_ok=True)
    return _DATA_DIR


def data_path(name: str) -> Path:
    return data_dir() / name


def custom_data_dir() -> bool:
    """True when the data directory was chosen explicitly (--data-dir or env)."""
    return _CUSTOM_DATA_DIR


def legacy_data_dirs() -> list[Path]:
    """Previous locations that may still contain data files."""
    current = data_dir().resolve()
    candidates = [
        application_dir() / DATA_DIR_NAME,
        application_dir(),
        _fallback_data_dir(),
    ]
    result: list[Path] = []
    seen: set[Path] = {current}
    for candidate in candidates:
        try:
            resolved = candidate.expanduser().resolve()
        except OSError:
            continue
        if resolved in seen or not resolved.is_dir():
            continue
        seen.add(resolved)
        result.append(resolved)
    return result


def log_path() -> Path:
    logs = data_dir() / "logs"
    logs.mkdir(parents=True, exist_ok=True)
    return logs / "service-monitor.log"


def set_runtime(host: str, port: int) -> None:
    """Remember the address the server actually listens on."""
    global _RUNTIME_HOST, _RUNTIME_PORT
    _RUNTIME_HOST = host
    _RUNTIME_PORT = int(port)


def runtime_host(fallback: str) -> str:
    return _RUNTIME_HOST or fallback


def runtime_port(fallback: int) -> int:
    return _RUNTIME_PORT or fallback


def setup_logging(verbose: bool = False, console: bool = True) -> None:
    global _LOG_CONFIGURED
    if _LOG_CONFIGURED:
        return

    level = logging.DEBUG if verbose else logging.INFO
    root = logging.getLogger()
    root.setLevel(level)
    root.handlers.clear()

    fmt = logging.Formatter(
        "%(asctime)s  %(levelname)-7s  %(name)s  %(message)s",
        datefmt="%Y-%m-%d %H:%M:%S",
    )

    file_handler = RotatingFileHandler(
        log_path(), maxBytes=2 * 1024 * 1024, backupCount=3, encoding="utf-8"
    )
    file_handler.setFormatter(fmt)
    file_handler.setLevel(level)
    root.addHandler(file_handler)

    if console and sys.stdout is not None:
        stream = logging.StreamHandler(sys.stdout)
        stream.setFormatter(fmt)
        stream.setLevel(level)
        root.addHandler(stream)

    # Keep noisy third-party loggers quieter.
    logging.getLogger("uvicorn.access").setLevel(logging.WARNING)
    logging.getLogger("aiohttp.access").setLevel(logging.WARNING)
    logging.getLogger("pystray").setLevel(logging.WARNING)
    _LOG_CONFIGURED = True


def get_logger(name: str) -> logging.Logger:
    return logging.getLogger(name)
