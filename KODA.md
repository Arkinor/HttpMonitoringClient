# KODA.md — инструкция по проекту Service Monitor

## Обзор проекта

**Service Monitor** (текущая версия `3.2.0`) — настольное Windows-приложение для мониторинга доступности HTTP/HTTPS-сервисов в локальной сети. Оно периодически опрашивает список URL по расписанию, хранит историю проверок, показывает русскоязычную веб-панель и отправляет уведомления об ошибках и восстановлении.

Ключевые особенности:

- **Веб-панель на FastAPI** отдаётся тем же процессом и открывается в браузере по адресу `http://localhost:8062`. Доступна с любого компьютера в локальной сети, без учётных записей и без ограничений CORS.
- **Несколько одновременных пользователей**, обновление состояния в реальном времени через SSE (`GET /api/stream`).
- **Системный трей** (pystray): открыть панель, проверить сейчас, переключить автопроверку, открыть папку данных, выход.
- **Уведомления** в четыре канала: Telegram, MAX, e-mail (SMTP), произвольный webhook с шаблоном тела. Для каждого сервиса выбираются свои каналы.
- **Автозапуск вместе с Windows** через ключ реестра `HKCU\...\Run`.
- **Хранение — плоские JSON-файлы** в папке `data` рядом с программой, с атомарной записью и переносом старых файлов из предыдущих версий.
- **Сборка в один `exe`** через PyInstaller — на целевой машине Python не нужен.

Проект **не имеет тестов** (в репозитории нет ни одного `test_*.py` вне `.venv`), нет и конфигурации линтеров/`pyproject.toml`/`setup.py`.

### Технологический стек

| Слой | Технологии |
| --- | --- |
| Язык | Python 3.10+ (в `.venv` установлен 3.11.0), только Windows-API-вызовы через `ctypes`/`winreg` |
| HTTP-сервер | FastAPI 0.104.1 + uvicorn[standard] 0.24.0 |
| HTTP-клиент (проверки и уведомления) | aiohttp 3.9.1 |
| Модели данных | pydantic 2.5.0 |
| Трей и графика | pystray 0.19.5, Pillow 13.0.0 |
| Уведомления по почте | стандартная библиотека `smtplib` + `email` + `ssl` |
| Сборка | PyInstaller 6.18.0 (только для сборки, не в `requirements.txt`) |
| Фронтенд | Vanilla JS без сборки и без зависимостей: `app.js`, `index.html`, `styles.css` |

### Архитектура и поток данных

```
run.py  →  servicemonitor.cli.main()
              ├── блокировка единственного экземпляра (Windows mutex)
              ├── storage.initialize()      ← загрузка/миграция JSON
              ├── web.app.create_app()      ← FastAPI + lifespan(monitor.start)
              ├── _run_server()             ← uvicorn в daemon-потоке
              └── desktop.tray.TrayApp      ← основной поток, опрос /api/state каждые 10 с
```

Монолит на один процесс: веб-сервер работает в отдельном потоке, планировщик проверок — асинхронные задачи внутри event-loop uvicorn, трей — в основном потоке. Трей общается с сервером **через HTTP по 127.0.0.1**, а не напрямую с объектами, поэтому `--no-tray` не меняет поведение ядра.

Центральные узлы:

- `storage` (модуль-синглтон из `servicemonitor/storage.py`) — единственная точка доступа к JSON-файлам, защищённая `threading.RLock`. Кэширует всё в памяти, пишет на диск атомарно (`.tmp` + `os.replace` + `fsync`).
- `monitor` (синглтон из `servicemonitor/core/monitor.py`) — планировщик, выполнение пакетов проверок, переходы состояний и Постановка уведомлений в очередь задач asyncio.
- `events` (модуль `servicemonitor/events.py`) — шина событий в процессе: множество `asyncio.Queue` подписчиков, `publish()` из любого места, `format_sse()` для отправки клиенту.

## Сборка и запуск

Все команды — для Windows PowerShell из корня проекта.

| Задача | Команда |
| --- | --- |
| Установка зависимостей + запуск из исходников | `.\setup_and_run.bat` (создаёт `.venv`, ставит `requirements.txt`, запускает `run.py`) |
| Запуск напрямую | `.\.venv\Scripts\python.exe run.py` |
| То же через модуль | `.\.venv\Scripts\python.exe -m servicemonitor` |
| Сборка single-file exe | `.\build.bat` или `powershell -ExecutionPolicy Bypass -File build.ps1` |
| Результат сборки | `dist\ServiceMonitor.exe`, данные — в `dist\data` |
| Генерация иконки | `.\.venv\Scripts\python.exe tools\make_icon.py` (пишет `assets\icon.ico` и `assets\icon.png`; вызывается автоматически из `build.ps1`, если `icon.ico` отсутствует) |
| Интерактивная документация API | `http://localhost:8062/api/docs` |

Явных команд запуска тестов, линтеров или форматтеров в проекте **нет** — проверка изменений выполняется ручным запуском приложения и открытием панели. При необходимости запускайте приложение с `--console --verbose`, чтобы видеть лог.

Полезные ключи запуска (`servicemonitor/cli.py:parse_args`):

```
--no-tray             запуск без значка в трее (сервер держит процесс, выход по Ctrl+C)
--no-browser          не открывать браузер
--start-minimized     не открывать панель при запуске
--data-dir PATH       явная папка данных (отключает миграцию старых файлов)
--host HOST           адрес прослушивания
--port PORT           порт
--allow-multi         разрешить несколько экземпляров
--console             лог в консоль
--verbose             подробный лог (DEBUG)
--version             версия
```

Переменные окружения: `SERVICE_MONITOR_DATA` — папка данных, `LOCALAPPDATA` — резервная папка `%LOCALAPPDATA%\ServiceMonitor`, если рядом с программой писать нечем.

## Структура проекта

```
run.py                        точка входа (и для PyInstaller, и для python run.py)
build.ps1 / build.bat         сборка exe через PyInstaller
setup_and_run.bat             создание .venv, установка зависимостей, запуск
requirements.txt              зафиксированные версии всех рантайм-зависимостей
README.md                     пользовательская документация на русском
servicemonitor/
  cli.py                      аргументы, блокировка экземпляра, запуск uvicorn, трей
  config.py                   константы, пути, версия, логирование, runtime host/port
  models.py                   схемы pydantic + разбор ожидаемых кодов ответа
  storage.py                  JSON-хранилище, миграция старых файлов, резервные копии
  events.py                   шина событий для SSE
  __main__.py                 запуск через python -m servicemonitor
  core/
    httpcheck.py              выполнение одного HTTP-запроса, форматирование результата
    monitor.py                планировщик, пакет проверок, переходы состояний, алерты
    network.py                адреса локальной сети (с кэшем 60 с), сведения о сервере
  notify/
    channels.py               Telegram, MAX, SMTP-почта, webhook; журнал отправок
  desktop/
    tray.py                   иконка трея, меню, опрос /api/state, всплывающие сообщения
    icon.py                   рисование иконки через Pillow (4 статуса цвета)
    autostart.py              включение/выключение автозапуска в реестре Windows
  web/
    app.py                    фабрика FastAPI, lifespan, CORS, раздача статики
    api.py                    все эндпоинты под префиксом /api
    static/                   фронтенд: index.html, app.js, styles.css
tools/
  make_icon.py                генерация icon.ico/icon.png из desktop/icon.py
  version_info.txt            метаданные версии для PyInstaller
assets/                       готовые icon.ico и icon.png (в git не попадают)
data/                         файлы данных, создаются при запуске (в git не попадают)
build/, dist/                 артефакты PyInstaller (в git не попадают)
```

## Ключевые файлы

| Файл | Зачем |
| --- | --- |
| `servicemonitor/config.py` | Единственный источник `APP_NAME`, `APP_VERSION`, `APP_ID`, `DEFAULT_HOST` (`0.0.0.0`), `DEFAULT_PORT` (`8062`), `DEFAULT_INTERVAL` (600 с), `MIN_INTERVAL` (10), `MAX_INTERVAL` (86400), `HISTORY_FILE` (`history.json`). Здесь же настройка логирования. |
| `servicemonitor/models.py` | Все схемы данных и валидация (включая обратную совместимость со старими форматами). |
| `servicemonitor/storage.py` | Пути всех файлов, кэш в памяти, атомарная запись, миграция legacy-файлов, экспорт/импорт резервной копии. |
| `servicemonitor/core/monitor.py` | Логика планировщика, прогресс пакета, троттлинг записи состояния (`PERSIST_THROTTLE_SEC = 3.0`), условия отправки уведомлений. |
| `servicemonitor/web/api.py` | Контракт API для фронтенда и трея. |
| `servicemonitor/web/static/app.js` | ~3000 строк: состояние, рендеринг, SSE, темы, валидация, все взаимодействия с API. |
| `build.ps1` | Флаги PyInstaller и список `--add-data`. |
| `tools/version_info.txt` | Версия в метаданных exe. |

## Данные и файлы конфигурации

Все файлы лежат в `config.data_dir()` (по умолчанию `data\` рядом с программой; при недоступной записи — `%LOCALAPPDATA%\ServiceMonitor`):

- `services.json` — список сервисов;
- `settings.json` — настройки приложения, мониторинга и каналов уведомлений;
- `history.json` — пакеты проверок (не `results.json` — это имя из старых версий);
- `state.json` — текущее состояние каждого сервиса (`success`, `status_code`, `duration_ms`, `checked_at`, `error`, `consecutive_failures`, `alerted`, `last_alert_at`);
- `notifications.json` — журнал отправок, максимум 200 записей (`MAX_NOTIFICATION_LOG`);
- `logs\service-monitor.log` — ротируемый лог (2 МБ × 3 файла).

`Storage._migrate_legacy_files()` переносит старые файлы в `data\` и переименовывает `results.json`/`result.json` → `history.json`, `BASE.json` → `services.json`. Миграция **пропускается**, если папка задана явно через `--data-dir` или `SERVICE_MONITOR_DATA`.

Резервная копия (`GET /api/backup`) содержит пароли и токены в открытом виде.

## API

Все эндпоинты под префиксом `/api`, без аутентификации (панель рассчитана на доверенную локальную сеть):

- Состояние: `GET /api/state`, `GET /api/status`, `GET /api/results?limit=`, `GET /api/health`
- Сервисы: `GET /api/services`, `GET /api/services/{id}`, `POST /api/services` (201, 409 при дубликате id), `PUT /api/services/{id}`, `DELETE /api/services/{id}`, `POST /api/services/test`, `POST /api/services/{id}/test`
- Устаревшие (сохранены для совместимости): `GET /api/bases`, `POST /api/bases`
- Мониторинг: `POST /api/check`, `POST /api/set_interval`, `POST /api/monitoring`, `GET /api/stream` (SSE)
- Настройки: `GET /api/settings`, `PUT /api/settings`, `POST /api/settings/test-notification`
- Уведомления: `GET /api/notifications/log?limit=`
- Резервные копии: `GET /api/backup`, `POST /api/restore`
- Служебные: `GET /api/open-data-dir`
- Статика и корень: `GET /static/...`, `GET /` (index.html), `GET /api/docs`

Типы SSE-событий (`events.publish`): `connected`, `schedule`, `batch_start`, `service_result`, `batch_done`, `monitoring`, `settings_changed`, `services_changed`. Тело ответа и заголовки из `service_result` вырезаются (`_public_batches`), чтобы не отдавать лишние данные.

## Правила разработки

### Стиль кода

- Каждый модуль начинается с однострочного докстринга на **английском** языке; комментарии внутри кода — тоже на английском. Пользовательские строки, сообщения об ошибках и текст панели — на **русском**.
- Во всех модулях Python: `from __future__ import annotations` и аннотации типов, включая `Optional[...]` и `dict[str, Any]`.
- Классы и функции разделены секционными комментариями вида `# ── Lifecycle ─────…` (юникод-черта + пробелы). Соблюдайте этот разделитель при добавлении блоков.
- Константы верхнего регистра на уровне модуля (`DEFAULT_PORT`, `MAX_TEXT`, `PERSIST_THROTTLE_SEC`, `RAW_READ_LIMIT`).
- Синглтоны уровня модуля для глобального состояния: `storage = Storage()`, `monitor = Monitor()`.
- Широкие `except Exception` допустимы и ожидаемы в точках отказоустойчивости (проверка сервиса, отправка уведомления, операции с треем и реестром), но всегда с `# noqa: BLE001` и логированием. Исключения планировщика не должны ронять цикл.
- Никакого стороннего кода в фронтенде: `app.js` пишется на vanilla JS, функции объявляются на верхнем уровне файла, состояние хранится в объекте `state`. Иконки — SVG-спрайт прямо в `index.html`.

### Важные практики

- **Совместимость форматов данных.** При изменении `Service` или `Settings` добавляйте нормализацию старого формата в `model_validator(mode="before")` (`Service._legacy`, `WebhookSettings._headers`), а не требуйте перезаписи файлов у пользователя.
- **Валидация в pydantic**, а не в ручных проверках обработчиков. Сообщения `ValueError` формулируются по-русски — они напрямую показываются в панели.
- **Атомарная запись через `storage`.** Не пишите JSON-файлы в обход `Storage._write_json()`.
- **Не трогайте event-loop блокирующими вызовами.** Почта отправляется через `asyncio.to_thread`, трей обращается к серверу по HTTP.
- **Троттлинг записи.** Состояния пишутся не чаще раза в 3 секунды, кроме финальной записи пакета (`force=True`).
- **Версия приложения задана в пяти местах** и должна меняться синхронно: `servicemonitor/config.py` (`APP_VERSION`), `tools/version_info.txt` (`filevers`/`prodvers`/`FileVersion`/`ProductVersion`), `README.md` (заголовок), `setup_and_run.bat` (текст баннера), `servicemonitor/web/static/index.html` (`v3.2.0` в `app-version` и в query-параметрах `styles.css?v=` / `app.js?v=` — это сброс кэша браузера).
- **Блокировка экземпляра** использует мьютекс `Local\ServiceMonitor_Instance`; при уже запущенном экземпляре процесс открывает браузер и завершается с кодом 0. Для отладки нескольких процессов используйте `--allow-multi`.
- **CORS открыт на `*`**, аутентификации нет — это осознанное проектное решение для локальной сети, не «исправляйте» его без запроса.
- **Смена host/port применяется только после перезапуска** (`restart_required` в ответе `PUT /api/settings`).

### Особенности сборки

- `build.ps1` сам создаёт `.venv` и ставит `pyinstaller==6.18.0`, если его нет.
- Обязательные флаги: `--onefile --windowed --name ServiceMonitor --icon assets\icon.ico --version-file tools\version_info.txt`.
- Статика добавляется параметром `--add-data "servicemonitor\web\static;web\static"` (разделитель `;` — для Windows). Пути к ней разрешаются через `config.resource_path()`, который учитывает `sys._MEIPASS` в собранном виде.
- `ServiceMonitor.spec` после сборки удаляется — он временный артефакт.
- В `.gitignore` намеренно исключены `data/`, `build/`, `dist/`, `assets/`-артефакты, `*.spec`, `__pycache__/`, `.venv/`, а также старые имена файлов данных (`BASE.json`, `result.json`, `passwords.json`) и даже глобальные маски `*json`, `*jsonl` — **не коммитьте** новые JSON-файлы, не проверив, не игнорируются ли они.

## Рабочие заметки

- Проверка считается успешной, если код ответа входит в `expected_status` (по умолчанию `200-299`) и, при задании `body_contains`, ожидаемый текст присутствует в теле.
- Формат `expected_status`: `200`, `200,201`, `200-299`, `2xx`, комбинации через запятую/точку с запятой/пробел (`parse_expected_status`).
- Тело ответа читается максимум 64 КБ (`RAW_READ_LIMIT`), в историю сохраняется 2000 символов (`STORED_BODY_LIMIT`), в превью — 20000 (`PREVIEW_BODY_LIMIT`).
- Уведомление об ошибке отправляется на переходе `успех → ошибка`, а также при `repeat_interval_minutes > 0` по истечении интервала. Сообщение о восстановлении — на переходе `ошибка → успех`, если включён `notify_on_recovery`.
- Отключённый сервис (`enabled=False`) попадает в пакет как `success=None`, `error_kind="disabled"` и не вызывает уведомлений.
- Изменение критических полей сервиса при `PUT` сбрасывает его состояние (`monitor.reset_state`), чтобы не показывать устаревший статус.
- При инициализации хранилища невалидная запись сервиса логируется и пропускается, а не роняет приложение.
- Интерфейс имеет пять страниц: `overview`, `history`, `services`, `notifications`, `settings`, плюс светлая/тёмная тема с сохранением в `localStorage` под ключом `service-monitor-theme`.
