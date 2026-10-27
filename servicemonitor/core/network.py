"""Local network address helpers."""

from __future__ import annotations

import socket
import time
from typing import Any

from servicemonitor import config
from servicemonitor.storage import storage

log = config.get_logger(__name__)

_LAN_CACHE: dict[int, tuple[float, list[str]]] = {}
_LAN_CACHE_TTL = 60.0


def _discover_lan_urls(port: int) -> list[str]:
    addresses: set[str] = set()
    try:
        hostname = socket.gethostname()
        for info in socket.getaddrinfo(hostname, None, socket.AF_INET, socket.SOCK_STREAM):
            addresses.add(info[4][0])
    except OSError:
        pass

    try:
        probe = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
        try:
            probe.connect(("8.8.8.8", 80))
            addresses.add(probe.getsockname()[0])
        finally:
            probe.close()
    except OSError:
        pass

    cleaned = [
        address
        for address in addresses
        if address
        and not address.startswith("127.")
        and not address.startswith("169.254.")
        and address != "0.0.0.0"
    ]
    return [f"http://{address}:{port}" for address in sorted(cleaned)]


def lan_urls(port: int) -> list[str]:
    now = time.monotonic()
    cached = _LAN_CACHE.get(port)
    if cached and now - cached[0] < _LAN_CACHE_TTL:
        return list(cached[1])
    urls = _discover_lan_urls(port)
    _LAN_CACHE[port] = (now, urls)
    return list(urls)


def server_info() -> dict[str, Any]:
    settings = storage.settings()
    host = config.runtime_host(settings.app.host)
    port = config.runtime_port(settings.app.port)
    return {
        "host": host,
        "port": port,
        "local_url": f"http://127.0.0.1:{port}",
        "lan_urls": lan_urls(port),
        "data_dir": str(config.data_dir()),
        "history_file": str(storage.history_path),
        "data_files": storage.data_files(),
        "log_file": str(config.log_path()),
    }
