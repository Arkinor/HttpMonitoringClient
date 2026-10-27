"""Command-line entry point: web server, instance lock and system tray."""

from __future__ import annotations

import argparse
import ctypes
import json
import multiprocessing
import os
import sys
import threading
import time
import webbrowser
from typing import Optional

from servicemonitor import config


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=f"{config.APP_NAME} {config.APP_VERSION}")
    parser.add_argument("--no-tray", action="store_true", help="Запустить без значка в трее")
    parser.add_argument("--no-browser", action="store_true", help="Не открывать браузер при запуске")
    parser.add_argument("--start-minimized", action="store_true", help="Не открывать панель при запуске")
    parser.add_argument("--data-dir", default="", help="Папка для файлов данных")
    parser.add_argument("--host", default="", help="Переопределить адрес прослушивания")
    parser.add_argument("--port", type=int, default=0, help="Переопределить порт")
    parser.add_argument("--allow-multi", action="store_true", help="Разрешить несколько экземпляров")
    parser.add_argument("--console", action="store_true", help="Писать лог в консоль")
    parser.add_argument("--verbose", action="store_true", help="Подробный лог")
    parser.add_argument("--version", action="version", version=f"{config.APP_NAME} {config.APP_VERSION}")
    return parser.parse_args()


def show_message(text: str, title: str = config.APP_NAME, error: bool = True) -> None:
    if os.name == "nt":
        try:
            flags = 0x10 if error else 0x40
            ctypes.windll.user32.MessageBoxW(None, text, title, flags)
            return
        except Exception:
            pass
    stream = sys.stderr or sys.stdout
    if stream:
        print(text, file=stream)


def acquire_instance_lock() -> tuple[Optional[object], bool]:
    """Return (handle, already_running)."""
    if os.name != "nt":
        return None, False
    try:
        kernel32 = ctypes.windll.kernel32
        handle = kernel32.CreateMutexW(None, True, "Local\\ServiceMonitor_Instance")
        if kernel32.GetLastError() == 183:  # ERROR_ALREADY_EXISTS
            if handle:
                kernel32.CloseHandle(handle)
            return None, True
        return handle, False
    except Exception:
        return None, False


def release_instance_lock(handle: Optional[object]) -> None:
    if handle and os.name == "nt":
        try:
            ctypes.windll.kernel32.CloseHandle(handle)
        except Exception:
            pass


def read_saved_port() -> int:
    try:
        with open(config.data_path("settings.json"), "r", encoding="utf-8") as handle:
            data = json.load(handle)
        port = int(((data.get("app") or {}).get("port") or config.DEFAULT_PORT))
        return port if 1 <= port <= 65535 else config.DEFAULT_PORT
    except Exception:
        return config.DEFAULT_PORT


def install_exception_hook() -> None:
    def handle(exc_type, exc_value, exc_tb):
        if issubclass(exc_type, KeyboardInterrupt):
            return
        import traceback

        text = "".join(traceback.format_exception(exc_type, exc_value, exc_tb))
        config.get_logger("crash").exception("Unhandled exception: %s", exc_value)
        show_message(
            "Произошла непредвиденная ошибка.\n\n"
            f"{exc_value}\n\nПодробности: {config.log_path()}",
        )

    sys.excepthook = handle


def _run_server(application, host: str, port: int, verbose: bool) -> tuple[object, threading.Thread]:
    import uvicorn

    server_config = uvicorn.Config(
        application,
        host=host,
        port=port,
        log_config=None,
        log_level="debug" if verbose else "info",
        access_log=False,
        server_header=False,
        date_header=False,
    )
    server = uvicorn.Server(server_config)
    thread = threading.Thread(target=server.run, name="http-server", daemon=True)
    thread.start()

    deadline = time.monotonic() + 30
    while time.monotonic() < deadline:
        if server.started:
            break
        if not thread.is_alive():
            break
        time.sleep(0.05)
    return server, thread


def main() -> int:
    multiprocessing.freeze_support()
    args = parse_args()
    if args.data_dir:
        config.set_data_dir(args.data_dir)

    console = args.console or not config.is_frozen()
    config.setup_logging(verbose=args.verbose, console=console)
    log = config.get_logger("run")
    install_exception_hook()

    if os.name == "nt":
        try:
            ctypes.windll.shcore.SetProcessDpiAwareness(1)
        except Exception:
            pass

    lock = None
    if not args.allow_multi:
        lock, already_running = acquire_instance_lock()
        if already_running:
            port = args.port or read_saved_port()
            webbrowser.open(f"http://127.0.0.1:{port}/")
            log.info("Another instance is already running")
            return 0

    try:
        from servicemonitor.storage import storage
        from servicemonitor.web.app import create_app

        storage.initialize()
        settings = storage.settings()
        host = args.host or settings.app.host
        port = args.port or settings.app.port
        if not 1 <= port <= 65535:
            raise RuntimeError(f"Некорректный порт: {port}")
        config.set_runtime(host, port)

        application = create_app()
        server, thread = _run_server(application, host, port, args.verbose)

        if not server.started:
            log.error("Server failed to start on %s:%s", host, port)
            show_message(
                f"Не удалось запустить сервер на {host}:{port}.\n\n"
                "Возможно, порт уже занят другим приложением.\n\n"
                f"Подробности: {config.log_path()}"
            )
            return 1

        connect_host = "127.0.0.1" if host in ("0.0.0.0", "::", "") else host
        base_url = f"http://{connect_host}:{port}"
        log.info("Panel available at %s", base_url)
        log.info("Data directory: %s", config.data_dir())

        if (
            not args.no_browser
            and not args.start_minimized
            and settings.app.open_browser_on_start
            and not settings.app.start_minimized
        ):
            try:
                webbrowser.open(base_url + "/")
            except Exception as exc:
                log.warning("Cannot open browser: %s", exc)

        def request_shutdown() -> None:
            server.should_exit = True

        if args.no_tray:
            try:
                while thread.is_alive():
                    time.sleep(0.5)
            except KeyboardInterrupt:
                pass
        else:
            try:
                from servicemonitor.desktop.tray import TrayApp, TrayUnavailable

                tray = TrayApp(base_url, request_shutdown)
                tray.run()
            except TrayUnavailable as exc:
                log.warning("Tray is unavailable: %s", exc)
                try:
                    while thread.is_alive():
                        time.sleep(0.5)
                except KeyboardInterrupt:
                    pass
            except KeyboardInterrupt:
                pass

        server.should_exit = True
        thread.join(timeout=12)
        log.info("Service Monitor exited")
        return 0
    except Exception as exc:  # noqa: BLE001
        config.get_logger("run").exception("Fatal error: %s", exc)
        show_message(
            f"Не удалось запустить {config.APP_NAME}.\n\n{exc}\n\n"
            f"Подробности: {config.log_path()}"
        )
        return 1
    finally:
        release_instance_lock(lock)


if __name__ == "__main__":
    raise SystemExit(main())
