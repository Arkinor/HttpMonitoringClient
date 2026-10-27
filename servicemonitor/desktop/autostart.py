"""Windows autostart (HKCU Run) helper."""

from __future__ import annotations

import sys
from pathlib import Path
from typing import Optional

from servicemonitor import config

log = config.get_logger(__name__)

RUN_KEY = r"Software\Microsoft\Windows\CurrentVersion\Run"
VALUE_NAME = config.APP_ID


def _command() -> str:
    if config.is_frozen():
        exe = Path(sys.executable).resolve()
        return f'"{exe}" --start-minimized'
    python = Path(sys.executable).resolve()
    pythonw = python.with_name("pythonw.exe")
    interpreter = pythonw if pythonw.exists() else python
    script = Path(__file__).resolve().parents[2] / "run.py"
    return f'"{interpreter}" "{script}" --start-minimized'


def is_enabled() -> bool:
    if sys.platform != "win32":
        return False
    try:
        import winreg
    except ImportError:
        return False
    try:
        with winreg.OpenKey(winreg.HKEY_CURRENT_USER, RUN_KEY) as key:
            value, _ = winreg.QueryValueEx(key, VALUE_NAME)
            return bool(value)
    except OSError:
        return False


def set_enabled(enabled: bool) -> tuple[bool, Optional[str]]:
    if sys.platform != "win32":
        return False, "Автозапуск доступен только в Windows"
    try:
        import winreg
    except ImportError:
        return False, "Модуль winreg недоступен"

    try:
        with winreg.CreateKey(winreg.HKEY_CURRENT_USER, RUN_KEY) as key:
            if enabled:
                winreg.SetValueEx(key, VALUE_NAME, 0, winreg.REG_SZ, _command())
            else:
                try:
                    winreg.DeleteValue(key, VALUE_NAME)
                except FileNotFoundError:
                    pass
        return True, None
    except OSError as exc:
        log.warning("Cannot update autostart: %s", exc)
        return False, str(exc)
