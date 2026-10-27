"""
Service Monitoring v2.0 — единый модуль.
Мониторинг доступности веб-сервисов: сервисы опрашиваются по одному,
результат каждого публикуется сразу после ответа (SSE), фоновое
авто-обновление и REST API.
"""

import asyncio
import json
import logging
import os
import sys
import time
import uuid
import webbrowser
from contextlib import asynccontextmanager
from datetime import datetime, timedelta
from pathlib import Path
from typing import Any, AsyncIterator, Dict, List, Optional, Set

import aiohttp
import uvicorn
from fastapi import APIRouter, FastAPI, HTTPException, Request
from fastapi.responses import HTMLResponse, StreamingResponse
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel, Field, field_validator

# ── Конфигурация ──────────────────────────────────────────────────────────

if getattr(sys, "frozen", False):
    BASE_DIR = Path(os.path.dirname(sys.executable))
else:
    BASE_DIR = Path(__file__).parent

BASE_JSON        = BASE_DIR / "BASE.json"
RESULTS_JSON     = BASE_DIR / "result.json"
STATIC_DIR       = BASE_DIR / "static"

HOST             = "0.0.0.0"
PORT             = 8062
CHECK_INTERVAL_MIN    = 60
CHECK_INTERVAL_MAX    = 3600
CHECK_INTERVAL_DEFAULT = 600
MAX_RESULTS_HISTORY   = 50
REQUEST_TIMEOUT       = 15

# Проверка TLS-сертификатов у опрашиваемых сервисов (внутренние стенды — self-signed)
VERIFY_SSL         = False
# Поддерживаемые HTTP-методы опроса
SUPPORTED_METHODS  = ("GET", "POST", "PUT", "DELETE")
# Шаг ожидания в цикле мониторинга: нужен, чтобы смена интервала применялась сразу
MONITOR_TICK_SEC   = 1.0
# Как часто разрешено перечитывать/перезаписывать result.json во время пачки
PERSIST_THROTTLE_SEC = 3.0

# ── Логирование ───────────────────────────────────────────────────────────

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s - %(name)s - %(levelname)s - %(message)s",
)
logger = logging.getLogger(__name__)

# ── Pydantic-модели ──────────────────────────────────────────────────────

class DatabaseItem(BaseModel):
    """Модель сервиса мониторинга."""
    url: str = Field(..., description="URL сервиса")
    method: Optional[str] = "GET"
    request_body: Optional[Dict[str, Any]] = None
    login: Optional[str] = None
    password: Optional[str] = None
    comment: Optional[str] = None
    enabled: Optional[bool] = True

    @field_validator("url")
    @classmethod
    def _validate_url(cls, value: str) -> str:
        value = value.strip()
        if not value:
            raise ValueError("url must not be empty")
        return value

    @field_validator("method")
    @classmethod
    def _validate_method(cls, value: Optional[str]) -> str:
        method = (value or "GET").strip().upper()
        if method not in SUPPORTED_METHODS:
            raise ValueError(f"method must be one of {', '.join(SUPPORTED_METHODS)}")
        return method


class IntervalRequest(BaseModel):
    """Запрос на изменение интервала авто-проверки."""
    interval: int = Field(
        ...,
        ge=CHECK_INTERVAL_MIN,
        le=CHECK_INTERVAL_MAX,
        description=f"Интервал в секундах ({CHECK_INTERVAL_MIN}-{CHECK_INTERVAL_MAX})",
    )


# ── Хранение данных ──────────────────────────────────────────────────────

def _read_json(filepath: Path) -> List[Dict[str, Any]]:
    """Читает JSON файл, возвращает список словарей (пустой список при любой проблеме)."""
    try:
        if not filepath.exists():
            return []
        with open(filepath, "r", encoding="utf-8") as f:
            data = json.load(f)
    except json.JSONDecodeError as e:
        logger.error("JSON decode error in %s: %s", filepath, e)
        return []
    except Exception as e:
        logger.error("Error reading %s: %s", filepath, e)
        return []

    if not isinstance(data, list):
        logger.error("Unexpected structure in %s: expected list, got %s",
                     filepath, type(data).__name__)
        return []
    return [item for item in data if isinstance(item, dict)]


def _save_json(filepath: Path, data: List[Dict[str, Any]], max_entries: Optional[int] = None) -> bool:
    """Сохраняет данные в JSON файл с атомарной записью."""
    try:
        if max_entries and len(data) > max_entries:
            data = data[-max_entries:]
        tmp = filepath.with_suffix(filepath.suffix + ".tmp")
        with open(tmp, "w", encoding="utf-8") as f:
            json.dump(data, f, indent=2, ensure_ascii=False)
        os.replace(tmp, filepath)
        return True
    except Exception as e:
        logger.error("Error saving to %s: %s", filepath, e)
        return False


def read_bases_file() -> List[Dict[str, Any]]:
    """Читает файл с конфигурацией сервисов."""
    return _read_json(BASE_JSON)


def save_bases_file(data: List[Dict[str, Any]]) -> bool:
    """Сохраняет конфигурацию сервисов."""
    return _save_json(BASE_JSON, data)


def read_results_file() -> List[Dict[str, Any]]:
    """Читает файл с результатами проверок."""
    return _read_json(RESULTS_JSON)


def save_results_file(data: List[Dict[str, Any]]) -> bool:
    """Сохраняет результаты проверок с ограничением истории."""
    return _save_json(RESULTS_JSON, data, MAX_RESULTS_HISTORY)


def initialize_files() -> None:
    """Инициализирует необходимые файлы, если они отсутствуют."""
    if not BASE_JSON.exists():
        save_bases_file([])
        logger.info("Created empty %s", BASE_JSON)
    if not RESULTS_JSON.exists():
        save_results_file([])
        logger.info("Created empty %s", RESULTS_JSON)
    if not STATIC_DIR.exists():
        logger.warning("Static directory not found: %s", STATIC_DIR)


# ── Проверка сервисов ────────────────────────────────────────────────────

async def check_service(
    url: str,
    method: str = "GET",
    request_body: Optional[Dict] = None,
    login: Optional[str] = None,
    password: Optional[str] = None,
    session: Optional[aiohttp.ClientSession] = None,
) -> Dict[str, Any]:
    """Проверяет доступность одного сервиса (сессия может быть общей)."""
    verb = (method or "GET").strip().upper()
    if verb not in SUPPORTED_METHODS:
        return {
            "status_code": None, "success": False,
            "error": f"Unsupported method: {method}",
            "response_body": None,
        }

    try:
        status_code: Optional[int] = None
        response_body: Any = None

        kwargs: Dict[str, Any] = {
            "timeout": aiohttp.ClientTimeout(total=REQUEST_TIMEOUT),
            "ssl": VERIFY_SSL,
        }
        if login:
            kwargs["auth"] = aiohttp.BasicAuth(login, password or "")
        if verb in ("POST", "PUT") and request_body is not None:
            kwargs["json"] = request_body

        own_session = session is None
        if own_session:
            session = aiohttp.ClientSession()

        try:
            request = getattr(session, verb.lower())
            async with request(url, **kwargs) as resp:
                status_code = resp.status
                if verb == "DELETE":
                    try:
                        response_body = await resp.text()
                    except Exception:
                        response_body = None
                else:
                    try:
                        response_body = await resp.json()
                    except Exception:
                        response_body = await resp.text()
        finally:
            if own_session:
                await session.close()

        success = status_code is not None and 200 <= status_code < 300
        return {
            "status_code": status_code, "success": success,
            "error": None if success else f"HTTP {status_code}",
            "response_body": response_body,
        }

    except asyncio.TimeoutError:
        return {
            "status_code": None, "success": False,
            "error": f"Timeout after {REQUEST_TIMEOUT}s", "response_body": None,
        }
    except aiohttp.ClientError as e:
        return {
            "status_code": None, "success": False,
            "error": f"Connection error: {e}", "response_body": None,
        }
    except Exception as e:
        return {
            "status_code": None, "success": False,
            "error": str(e), "response_body": None,
        }


async def iter_service_checks(
    bases: List[Dict[str, Any]],
) -> AsyncIterator[Dict[str, Any]]:
    """
    Последовательная проверка сервисов: результат каждого отдаётся сразу
    после получения ответа, без ожидания остальных сервисов.
    """
    if not bases:
        return

    enabled_count = sum(1 for b in bases if b.get("enabled", True) is not False)
    logger.info("Starting sequential check: %d enabled, %d disabled",
                enabled_count, len(bases) - enabled_count)

    timeout = aiohttp.ClientTimeout(total=REQUEST_TIMEOUT)
    async with aiohttp.ClientSession(timeout=timeout) as session:
        for base in bases:
            now_str = datetime.now().strftime("%Y-%m-%d %H:%M:%S")
            record = {
                "url": base.get("url"),
                "method": base.get("method", "GET"),
                "comment": base.get("comment"),
                "enabled": base.get("enabled", True),
                "request_body": base.get("request_body"),
            }

            if base.get("enabled", True) is False:
                yield {
                    **record, "status_code": None, "success": None,
                    "error": "Monitoring disabled", "response_body": None,
                    "duration_ms": 0, "check_time": now_str,
                }
                continue

            started = datetime.now()
            url = (base.get("url") or "").strip()
            if not url:
                yield {
                    **record, "status_code": None, "success": False,
                    "error": "URL is empty", "response_body": None,
                    "duration_ms": 0, "check_time": now_str,
                }
                continue

            try:
                result = await check_service(
                    url=url,
                    method=base.get("method", "GET"),
                    request_body=base.get("request_body"),
                    login=base.get("login"),
                    password=base.get("password"),
                    session=session,
                )
            except Exception as e:  # noqa: BLE001 - проверка не должна ронять цикл
                result = {
                    "status_code": None, "success": False,
                    "error": f"Task error: {e}", "response_body": None,
                }

            yield {
                **record, **result,
                "duration_ms": int((datetime.now() - started).total_seconds() * 1000),
                "check_time": now_str,
            }


# ── Шина событий ────────────────────────────────────────────────────────

event_subscribers: Set[asyncio.Queue] = set()


def subscribe_events() -> asyncio.Queue:
    """Подписывается на события проверок."""
    queue: asyncio.Queue = asyncio.Queue(maxsize=200)
    event_subscribers.add(queue)
    return queue


def unsubscribe_events(queue: asyncio.Queue) -> None:
    """Отписывается от событий проверок."""
    event_subscribers.discard(queue)


def publish_event(event: Dict[str, Any]) -> None:
    """Рассылает событие всем подписчикам (медленные подписчики пропускаются)."""
    for queue in list(event_subscribers):
        try:
            queue.put_nowait(event)
        except asyncio.QueueFull:
            logger.warning("Event queue overflow, event dropped")


def format_sse(data: Dict[str, Any]) -> str:
    """Форматирует событие в формат SSE."""
    return f"data: {json.dumps(data, ensure_ascii=False)}\n\n"


# ── Фоновый мониторинг ──────────────────────────────────────────────────

CHECK_INTERVAL = CHECK_INTERVAL_DEFAULT
last_check_time: Optional[datetime] = None
next_check_at: Optional[datetime] = None
auto_check_running = True
monitoring_task: Optional[asyncio.Task] = None
manual_check_task: Optional[asyncio.Task] = None

# Текущая проверка (None, если ничего не выполняется)
current_check: Optional[Dict[str, Any]] = None
check_lock = asyncio.Lock()


def get_status() -> Dict[str, Any]:
    """Возвращает текущий статус системы."""
    return {
        "auto_check_enabled": auto_check_running,
        "last_check_time": last_check_time.isoformat() if last_check_time else None,
        "check_interval": CHECK_INTERVAL,
        "next_check_time": next_check_at.isoformat() if next_check_at else None,
        "checking": current_check is not None,
        "progress": dict(current_check) if current_check else None,
        "server_time": datetime.now().isoformat(),
    }


def set_interval(interval: int) -> bool:
    """Устанавливает новый интервал авто-проверки (применяется без перезапуска)."""
    global CHECK_INTERVAL
    if interval < CHECK_INTERVAL_MIN or interval > CHECK_INTERVAL_MAX:
        return False
    CHECK_INTERVAL = interval
    logger.info("Check interval updated to %d seconds", CHECK_INTERVAL)
    return True


def _persist_batch(batch: Dict[str, Any]) -> None:
    """Сохраняет/обновляет пачку результатов в файле (бегущая пачка тоже видна)."""
    existing = read_results_file()
    for i, item in enumerate(existing):
        if item.get("check_id") == batch["check_id"]:
            existing[i] = batch
            break
    else:
        existing.append(batch)
    save_results_file(existing)


def _persist_batch_throttled(batch: Dict[str, Any], last_persist: float,
                             force: bool = False) -> float:
    """
    Сохраняет пачку не чаще PERSIST_THROTTLE_SEC.
    Без троттлинга файл перечитывался и перезаписывался на каждый ответ сервиса.
    """
    now = time.monotonic()
    if not force and last_persist and (now - last_persist) < PERSIST_THROTTLE_SEC:
        return last_persist
    _persist_batch(batch)
    return now


async def run_check(trigger: str = "auto") -> Dict[str, Any]:
    """
    Последовательно опрашивает сервисы, публикуя результат каждого сразу
    после ответа. Пачка сохраняется в файл по мере поступления ответов.
    """
    global last_check_time, current_check, next_check_at

    async with check_lock:
        bases = read_bases_file()
        started = datetime.now()
        check_id = f"{started.strftime('%Y%m%d-%H%M%S')}-{uuid.uuid4().hex[:6]}"
        check_time = started.strftime("%Y-%m-%d %H:%M:%S")

        batch: Dict[str, Any] = {
            "check_id": check_id,
            "check_time": check_time,
            "finished_at": None,
            "status": "running",
            "trigger": trigger,
            "total": len(bases),
            "success_count": 0,
            "failed_count": 0,
            "results": [],
        }
        current_check = {
            "check_id": check_id,
            "check_time": check_time,
            "trigger": trigger,
            "total": len(bases),
            "done": 0,
            "success": 0,
            "failed": 0,
        }
        last_check_time = started
        next_check_at = None
        last_persist = 0.0

        if bases:
            _persist_batch(batch)

        publish_event({
            "type": "batch_start",
            "check_id": check_id,
            "check_time": check_time,
            "trigger": trigger,
            "services": [
                {
                    "url": b.get("url"),
                    "method": b.get("method", "GET"),
                    "comment": b.get("comment"),
                    "enabled": b.get("enabled", True) is not False,
                }
                for b in bases
            ],
        })

        try:
            async for record in iter_service_checks(bases):
                batch["results"].append(record)
                current_check["done"] = len(batch["results"])
                if record.get("success") is True:
                    current_check["success"] += 1
                    batch["success_count"] += 1
                elif record.get("success") is False:
                    current_check["failed"] += 1
                    batch["failed_count"] += 1

                publish_event({
                    "type": "service_result",
                    "check_id": check_id,
                    "result": record,
                    "progress": dict(current_check),
                })

                if bases:
                    last_persist = _persist_batch_throttled(batch, last_persist)
        except Exception as e:  # noqa: BLE001 - фоновый цикл не должен падать
            logger.error("Check error: %s", e)
            batch["status"] = "error"
            batch["error"] = str(e)
        finally:
            if batch["status"] == "running":
                batch["status"] = "done"
            batch["finished_at"] = datetime.now().strftime("%Y-%m-%d %H:%M:%S")
            if bases:
                _persist_batch(batch)

            summary = {
                "message": f"Checked {len(bases)} services",
                "check_id": check_id,
                "check_time": check_time,
                "total_count": len(bases),
                "success_count": batch["success_count"],
                "failed_count": batch["failed_count"],
            }
            publish_event({"type": "batch_done", **summary})

            current_check = None
            logger.info("Check completed: %d/%d successful",
                        batch["success_count"], len(bases))

        return summary


async def _sleep_between_checks() -> None:
    """
    Пауза до следующей автопроверки. Если интервал поменяли во время сна,
    остаток пересчитывается сразу — без ожидания конца старого интервала.
    """
    global next_check_at

    interval = CHECK_INTERVAL
    deadline = time.monotonic() + interval
    while auto_check_running:
        remaining = deadline - time.monotonic()
        if remaining <= 0:
            return
        if CHECK_INTERVAL != interval:
            interval = CHECK_INTERVAL
            deadline = time.monotonic() + interval
            next_check_at = datetime.now() + timedelta(seconds=interval)
            continue
        await asyncio.sleep(min(remaining, MONITOR_TICK_SEC))


async def _monitoring_loop() -> None:
    """Фоновый цикл авто-проверки."""
    global next_check_at

    while auto_check_running:
        if current_check is None:
            try:
                await run_check("auto")
            except Exception as e:  # noqa: BLE001
                logger.error("Auto-check error: %s", e)
        else:
            logger.info("Auto-check skipped: another check is running")

        next_check_at = datetime.now() + timedelta(seconds=CHECK_INTERVAL)
        await _sleep_between_checks()


def start_monitoring_task() -> None:
    """Запускает фоновый мониторинг."""
    global monitoring_task
    if monitoring_task is None or monitoring_task.done():
        monitoring_task = asyncio.create_task(_monitoring_loop())
        logger.info("Background monitoring task started")


async def stop_monitoring_task() -> None:
    """Останавливает фоновый мониторинг."""
    global monitoring_task
    if monitoring_task and not monitoring_task.done():
        monitoring_task.cancel()
        try:
            await monitoring_task
        except asyncio.CancelledError:
            pass
        logger.info("Background monitoring task stopped")


# ── API роуты ────────────────────────────────────────────────────────────

router = APIRouter(prefix="/api", tags=["api"])


@router.get("/bases")
async def get_bases() -> List[Dict[str, Any]]:
    """Возвращает список всех сервисов для мониторинга."""
    bases = read_bases_file()
    logger.debug("Returning %d services", len(bases))
    return bases


@router.post("/bases")
async def save_bases(data: List[DatabaseItem]) -> Dict[str, Any]:
    """Сохраняет обновлённый список сервисов."""
    d = [item.model_dump() for item in data]
    if save_bases_file(d):
        logger.info("Saved %d services", len(data))
        return {"message": "Services saved successfully", "count": len(data)}
    raise HTTPException(500, "Failed to save services")


@router.get("/results")
async def get_results() -> List[Dict[str, Any]]:
    """Возвращает последние пачки проверок (новые сверху)."""
    all_res = read_results_file()
    last = all_res[-MAX_RESULTS_HISTORY:]
    last.reverse()
    return last


@router.get("/status")
async def api_status() -> Dict[str, Any]:
    """Возвращает текущий статус системы мониторинга."""
    return get_status()


@router.post("/check")
async def check_all_services() -> Dict[str, Any]:
    """Запускает проверку всех сервисов в фоне (результаты приходят в /api/stream)."""
    global manual_check_task
    if current_check is not None:
        return {
            "message": "Check is already running",
            "check_id": current_check["check_id"],
            "running": True,
            "progress": dict(current_check),
        }

    async def _run() -> None:
        try:
            await run_check("manual")
        except Exception as e:  # noqa: BLE001
            logger.error("Error checking services: %s", e)

    manual_check_task = asyncio.create_task(_run())
    return {"message": "Check started", "running": True}


@router.get("/stream")
async def events_stream(request: Request) -> StreamingResponse:
    """SSE-поток событий: результат каждого сервиса приходит сразу после ответа."""

    async def event_source():
        queue = subscribe_events()
        try:
            yield format_sse({"type": "connected", "status": get_status()})
            while not await request.is_disconnected():
                try:
                    event = await asyncio.wait_for(queue.get(), timeout=15)
                    yield format_sse(event)
                except asyncio.TimeoutError:
                    yield ": keep-alive\n\n"
        finally:
            unsubscribe_events(queue)

    return StreamingResponse(
        event_source(),
        media_type="text/event-stream",
        headers={
            "Cache-Control": "no-cache",
            "Connection": "keep-alive",
            "X-Accel-Buffering": "no",
        },
    )


@router.post("/set_interval")
async def api_set_interval(req: IntervalRequest) -> Dict[str, Any]:
    """Устанавливает новый интервал авто-проверки."""
    if set_interval(req.interval):
        return {
            "message": f"Interval updated to {req.interval} seconds",
            "interval": req.interval,
        }
    raise HTTPException(
        400,
        f"Interval must be between {CHECK_INTERVAL_MIN} "
        f"and {CHECK_INTERVAL_MAX} seconds",
    )


# ── FastAPI приложение ──────────────────────────────────────────────────

@asynccontextmanager
async def lifespan(app: FastAPI):
    """Управление жизненным циклом приложения."""
    initialize_files()
    start_monitoring_task()
    logger.info("Service Monitoring started. Auto-check runs in background.")
    yield
    await stop_monitoring_task()
    logger.info("Shutting down...")


app = FastAPI(
    title="Service Monitoring",
    description="Система мониторинга доступности веб-сервисов",
    version="2.0",
    lifespan=lifespan,
)
app.include_router(router)

if STATIC_DIR.exists():
    app.mount("/static", StaticFiles(directory=str(STATIC_DIR)), name="static")


@app.get("/", response_class=HTMLResponse)
async def root():
    """
    Главная страница. index.html читается на каждый запрос, чтобы правки
    интерфейса были видны без перезапуска приложения.
    """
    try:
        content = (STATIC_DIR / "index.html").read_text(encoding="utf-8")
    except FileNotFoundError:
        logger.error("Index file not found: %s", STATIC_DIR / "index.html")
        return HTMLResponse(
            content="<html><body><h1>Error: HTML file not found</h1></body></html>",
            status_code=404,
        )
    except Exception as e:
        logger.error("Error serving HTML: %s", e)
        return HTMLResponse(
            content="<html><body><h1>Error: cannot load interface</h1></body></html>",
            status_code=500,
        )
    return HTMLResponse(content=content)


# ── Точка входа ──────────────────────────────────────────────────────────

if __name__ == "__main__":
    logger.info("=" * 60)
    logger.info("Starting Service Monitoring v2.0")
    logger.info("=" * 60)

    try:
        webbrowser.open(f"http://localhost:{PORT}/")
        logger.info("Browser opened automatically")
    except Exception as e:
        logger.warning("Could not open browser: %s", e)

    uvicorn.run(
        "run:app",
        host=HOST,
        port=PORT,
        reload=False,
        log_level="info",
    )
