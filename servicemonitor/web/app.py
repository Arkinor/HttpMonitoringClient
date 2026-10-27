"""FastAPI application factory."""

from __future__ import annotations

from contextlib import asynccontextmanager

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import HTMLResponse
from fastapi.staticfiles import StaticFiles

from servicemonitor import config
from servicemonitor.desktop import autostart
from servicemonitor.core.monitor import monitor
from servicemonitor.storage import storage
from servicemonitor.web.api import router

log = config.get_logger(__name__)

STATIC_DIR = config.resource_path("web", "static")


@asynccontextmanager
async def lifespan(app: FastAPI):
    storage.initialize()
    settings = storage.settings()
    if settings.app.start_with_windows:
        autostart.set_enabled(True)
    await monitor.start()
    log.info(
        "%s %s started on %s:%s",
        config.APP_NAME,
        config.APP_VERSION,
        config.runtime_host(settings.app.host),
        config.runtime_port(settings.app.port),
    )
    try:
        yield
    finally:
        await monitor.stop()
        log.info("%s stopped", config.APP_NAME)


def create_app() -> FastAPI:
    application = FastAPI(
        title=config.APP_NAME,
        description="Мониторинг доступности HTTP-сервисов в локальной сети",
        version=config.APP_VERSION,
        lifespan=lifespan,
        docs_url="/api/docs",
        redoc_url=None,
    )

    application.add_middleware(
        CORSMiddleware,
        allow_origins=["*"],
        allow_credentials=False,
        allow_methods=["*"],
        allow_headers=["*"],
        expose_headers=["*"],
        max_age=86400,
    )

    application.include_router(router)

    if STATIC_DIR.exists():
        application.mount("/static", StaticFiles(directory=str(STATIC_DIR)), name="static")
    else:
        log.error("Static directory is missing: %s", STATIC_DIR)

    @application.get("/", response_class=HTMLResponse, include_in_schema=False)
    async def index() -> HTMLResponse:
        try:
            content = (STATIC_DIR / "index.html").read_text(encoding="utf-8")
        except OSError as exc:
            log.error("Cannot read index.html: %s", exc)
            return HTMLResponse(
                "<!doctype html><html lang='ru'><body style='font-family:sans-serif;padding:40px'>"
                "<h1>Не удалось загрузить интерфейс</h1>"
                "<p>Файлы интерфейса не найдены. Пересоберите приложение.</p>"
                "</body></html>",
                status_code=500,
            )
        return HTMLResponse(content, headers={"Cache-Control": "no-cache"})

    return application


app = create_app()
