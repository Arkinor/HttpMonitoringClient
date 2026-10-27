"use strict";

// ── Utilities ────────────────────────────────────────────────────────────
const $ = (selector, root = document) => root.querySelector(selector);
const $$ = (selector, root = document) => Array.from(root.querySelectorAll(selector));

const CHANNEL_IDS = ["telegram", "max", "email", "webhook"];
const CHANNEL_NAMES = {
    telegram: "Telegram",
    max: "MAX",
    email: "Почта",
    webhook: "Webhook",
};

const state = {
    services: [],
    states: {},
    results: [],
    status: {},
    counts: { total: 0, enabled: 0, ok: 0, error: 0, unknown: 0, disabled: 0 },
    channels: [],
    system: {},
    preferences: {},
    settings: null,
    editingId: null,
    formDirty: false,
    settingsDirty: false,
    testBody: "",
    testHeaders: "",
    testResponse: null,
    testFormat: "json",
    testTab: "body",
    codeLang: "python",
    historyVisible: 3,
    fullHistory: [],
    historyLoaded: false,
    history: {
        visible: 200,
        query: "",
        status: "all",
        trigger: "all",
        period: "all",
    },
    log: [],
    theme: "light",
    eventSource: null,
    connection: "connecting",
    wasOffline: false,
    pendingCheckToast: false,
    confirmResolver: null,
};

const THEME_KEY = "service-monitor-theme";
const timeFormatter = new Intl.DateTimeFormat("ru-RU", {
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
});
const shortFormatter = new Intl.DateTimeFormat("ru-RU", {
    day: "2-digit",
    month: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
});
const fullFormatter = new Intl.DateTimeFormat("ru-RU", {
    day: "2-digit",
    month: "2-digit",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
});

function icon(name, className = "icon") {
    return `<svg class="${className}" aria-hidden="true"><use href="#i-${name}"/></svg>`;
}

function escapeHtml(value) {
    return String(value == null ? "" : value).replace(/[&<>"']/g, (character) => {
        switch (character) {
            case "&": return "&amp;";
            case "<": return "&lt;";
            case ">": return "&gt;";
            case '"': return "&quot;";
            case "'": return "&#39;";
            default: return character;
        }
    });
}

function deepClone(value) {
    return typeof structuredClone === "function"
        ? structuredClone(value)
        : JSON.parse(JSON.stringify(value));
}

function clampInt(value, fallback, min, max) {
    const parsed = Number.parseInt(value, 10);
    if (!Number.isFinite(parsed)) return fallback;
    return Math.min(max, Math.max(min, parsed));
}

function clampNumber(value, fallback, min, max) {
    const parsed = Number.parseFloat(value);
    if (!Number.isFinite(parsed)) return fallback;
    return Math.min(max, Math.max(min, parsed));
}

function parseDate(value) {
    if (!value) return null;
    const date = new Date(value);
    return Number.isNaN(date.getTime()) ? null : date;
}

function formatTime(value) {
    const date = parseDate(value);
    return date ? timeFormatter.format(date) : "—";
}

function formatDateTime(value) {
    const date = parseDate(value);
    if (!date) return "—";
    const now = new Date();
    const sameDay = date.getFullYear() === now.getFullYear()
        && date.getMonth() === now.getMonth()
        && date.getDate() === now.getDate();
    return sameDay ? timeFormatter.format(date) : shortFormatter.format(date);
}

function formatFull(value) {
    const date = parseDate(value);
    return date ? fullFormatter.format(date) : "—";
}

function formatRelative(value) {
    const date = parseDate(value);
    if (!date) return "—";
    const diff = Date.now() - date.getTime();
    if (diff < 45_000) return "только что";
    if (diff < 3_600_000) {
        const minutes = Math.max(1, Math.round(diff / 60_000));
        return `${minutes} ${plural(minutes, "минуту", "минуты", "минут")} назад`;
    }
    if (diff < 86_400_000) {
        const hours = Math.max(1, Math.round(diff / 3_600_000));
        return `${hours} ${plural(hours, "час", "часа", "часов")} назад`;
    }
    if (diff < 7 * 86_400_000) {
        const days = Math.max(1, Math.round(diff / 86_400_000));
        return `${days} ${plural(days, "день", "дня", "дней")} назад`;
    }
    return shortFormatter.format(date);
}

function relativeHtml(value) {
    return `<span data-relative="${escapeHtml(value)}" title="${escapeHtml(formatFull(value))}">${escapeHtml(formatRelative(value))}</span>`;
}

function plural(count, one, few, many) {
    const value = Math.abs(count) % 100;
    const last = value % 10;
    if (value > 10 && value < 20) return many;
    if (last > 1 && last < 5) return few;
    if (last === 1) return one;
    return many;
}

function formatDuration(milliseconds) {
    if (milliseconds == null || !Number.isFinite(Number(milliseconds))) return "—";
    const value = Math.max(0, Number(milliseconds));
    if (value < 1000) return `${Math.round(value)} мс`;
    return `${(value / 1000).toFixed(value < 10_000 ? 1 : 0)} с`;
}

function humanInterval(seconds) {
    const value = Number(seconds) || 0;
    if (value % 3600 === 0 && value >= 3600) {
        const hours = value / 3600;
        return `${hours} ${plural(hours, "час", "часа", "часов")}`;
    }
    if (value % 60 === 0 && value >= 60) {
        const minutes = value / 60;
        return `${minutes} ${plural(minutes, "минуту", "минуты", "минут")}`;
    }
    return `${value} ${plural(value, "секунду", "секунды", "секунд")}`;
}

function formatIntervalShort(seconds) {
    const value = Number(seconds) || 0;
    if (value % 3600 === 0 && value >= 3600) return `${value / 3600} ч`;
    if (value % 60 === 0 && value >= 60) return `${value / 60} мин`;
    return `${value} с`;
}

function displayName(service) {
    return (service.name || service.comment || service.url || "Без названия").trim();
}

function deepValue(value) {
    return value == null ? "" : String(value);
}

// ── API ─────────────────────────────────────────────────────────────────
function validationMessage(detail) {
    if (typeof detail === "string") return detail;
    if (Array.isArray(detail)) {
        return detail.map((item) => {
            const field = Array.isArray(item.loc) ? item.loc.filter((part) => part !== "body").join(".") : "";
            return field ? `${field}: ${item.msg}` : item.msg;
        }).join("; ");
    }
    return "Не удалось выполнить запрос";
}

async function api(path, options = {}) {
    const request = { ...options, headers: { ...(options.headers || {}) } };
    if (request.body != null && !(request.body instanceof FormData)) {
        request.headers["Content-Type"] = "application/json";
        request.body = JSON.stringify(request.body);
    }
    let response;
    try {
        response = await fetch(path, request);
    } catch (error) {
        throw new Error("Нет связи с приложением");
    }
    const text = await response.text();
    let data = null;
    if (text) {
        try {
            data = JSON.parse(text);
        } catch (error) {
            data = text;
        }
    }
    if (!response.ok) {
        const detail = data && typeof data === "object" ? data.detail : null;
        throw new Error(validationMessage(detail) || `Ошибка запроса (HTTP ${response.status})`);
    }
    return data;
}

// ── Theme ───────────────────────────────────────────────────────────────
function applyTheme(theme, persist = false) {
    state.theme = theme === "dark" ? "dark" : "light";
    document.documentElement.dataset.theme = state.theme;
    const use = $("#theme-icon use");
    if (use) use.setAttribute("href", state.theme === "dark" ? "#i-sun" : "#i-moon");
    const button = $("#theme-toggle");
    if (button) button.title = state.theme === "dark" ? "Светлая тема" : "Тёмная тема";
    if (persist) {
        try {
            localStorage.setItem(THEME_KEY, state.theme);
        } catch (error) {
            /* storage can be unavailable in private mode */
        }
    }
}

function initTheme() {
    let stored = null;
    try {
        stored = localStorage.getItem(THEME_KEY);
    } catch (error) {
        stored = null;
    }
    if (stored === "light" || stored === "dark") {
        applyTheme(stored);
    } else if (window.matchMedia && window.matchMedia("(prefers-color-scheme: dark)").matches) {
        applyTheme("dark");
    } else {
        applyTheme("light");
    }
}

// ── Toasts / modal ──────────────────────────────────────────────────────
function toast(message, kind = "info", timeout = 4200) {
    const container = $("#toasts");
    if (!container) return;
    const element = document.createElement("div");
    element.className = `toast${kind === "success" ? " ok" : kind === "error" ? " err" : ""}`;
    const iconName = kind === "success" ? "check" : kind === "error" ? "alert" : "info";
    element.innerHTML = `${icon(iconName)}<span>${escapeHtml(message)}</span>`;
    container.append(element);
    window.setTimeout(() => {
        element.classList.add("hide");
        window.setTimeout(() => element.remove(), 240);
    }, timeout);
}

function confirmAction(options = {}) {
    const {
        title = "Подтверждение",
        text = "",
        okLabel = "Удалить",
        danger = true,
        iconName = "alert",
    } = options;
    return new Promise((resolve) => {
        if (state.confirmResolver) {
            state.confirmResolver(false);
            state.confirmResolver = null;
        }
        state.confirmResolver = resolve;
        $("#confirm-title").textContent = title;
        $("#confirm-text").textContent = text;
        $("#confirm-icon").innerHTML = icon(iconName);
        const okButton = $("#confirm-ok");
        okButton.textContent = okLabel;
        okButton.className = danger ? "btn btn-danger" : "btn btn-primary";
        $("#confirm-modal").hidden = false;
        okButton.focus();
    });
}

function resolveConfirm(value) {
    const modal = $("#confirm-modal");
    if (modal) modal.hidden = true;
    if (state.confirmResolver) {
        const resolver = state.confirmResolver;
        state.confirmResolver = null;
        resolver(value);
    }
}

function setButtonLoading(button, loading) {
    if (!button) return;
    button.disabled = loading;
    button.classList.toggle("loading", loading);
}

// ── Connection / server info ────────────────────────────────────────────
function setConnection(mode) {
    state.connection = mode;
    if (mode === "offline") state.wasOffline = true;
    const label = mode === "online" ? "Подключено" : mode === "offline" ? "Нет связи" : "Подключение…";
    const dot = $("#conn-dot");
    if (dot) dot.className = `conn-dot${mode === "online" ? " ok" : mode === "offline" ? " err" : ""}`;
    const text = $("#conn-text");
    if (text) text.textContent = label;
    const topDot = $("#top-conn-dot");
    if (topDot) topDot.className = `conn-dot${mode === "online" ? " ok" : mode === "offline" ? " err" : ""}`;
    const topText = $("#top-conn-text");
    if (topText) topText.textContent = label;
    const topPill = $("#top-conn");
    if (topPill) topPill.title = label;
}

function preferredLanUrl() {
    const system = state.system || {};
    const urls = (Array.isArray(system.lan_urls) ? system.lan_urls : [])
        .map((url) => String(url || "").trim())
        .filter(Boolean);
    const tests = [
        /^https?:\/\/192\.168\./i,
        /^https?:\/\/10\./i,
        /^https?:\/\/172\.(1[6-9]|2\d|3[01])\./i,
    ];
    for (const test of tests) {
        const match = urls.find((url) => test.test(url));
        if (match) return match.replace(/\/+$/, "");
    }
    return "";
}

function workspaceUrl() {
    const lan = preferredLanUrl();
    if (lan) return lan;
    if (location.protocol.startsWith("http") && location.origin) return location.origin;
    const system = state.system || {};
    return String(system.local_url || "").replace(/\/+$/, "");
}

function serverAddress() {
    const url = workspaceUrl();
    const host = url.replace(/^https?:\/\//, "").replace(/\/.*$/, "");
    return host || "—";
}

function renderServerInfo() {
    const host = serverAddress();
    const hostElement = $("#server-host");
    if (hostElement) hostElement.textContent = host;
    const lan = preferredLanUrl();
    const url = workspaceUrl();
    const link = $("#server-link");
    if (link) {
        link.title = lan
            ? `Адрес в локальной сети: ${url} — нажмите, чтобы скопировать`
            : `Скопировать адрес: ${url || "—"}`;
        link.classList.toggle("lan", Boolean(lan));
    }
    const net = $("#sidebar-net");
    if (net) {
        net.textContent = lan ? "в локальной сети" : "только этот ПК";
        net.title = lan ? `Адрес в локальной сети: ${url}` : "Панель доступна только с этого компьютера";
        net.classList.toggle("lan", Boolean(lan));
    }
    const version = $("#app-version");
    if (version) version.textContent = `v${(state.status && state.status.version) || (state.settings && state.settings.version) || "3.2.0"}`;
}

function copyFallback(value) {
    const area = document.createElement("textarea");
    area.value = value;
    area.style.position = "fixed";
    area.style.opacity = "0";
    document.body.append(area);
    area.select();
    const copied = document.execCommand("copy");
    area.remove();
    if (!copied) throw new Error("copy failed");
}

async function copyText(text, successMessage = "Адрес скопирован") {
    const value = String(text || "");
    if (!value) return;
    try {
        if (navigator.clipboard && window.isSecureContext) {
            try {
                await navigator.clipboard.writeText(value);
            } catch (error) {
                copyFallback(value);
            }
        } else {
            copyFallback(value);
        }
        toast(successMessage, "success");
    } catch (error) {
        toast("Не удалось скопировать", "error");
    }
}

// ── Navigation ──────────────────────────────────────────────────────────
const PAGE_META = {
    overview: { title: "Обзор", subtitle: "Состояние сервисов" },
    history: { title: "История", subtitle: "Все проверки" },
    services: { title: "Сервисы", subtitle: "HTTP-проверки" },
    notifications: { title: "Уведомления", subtitle: "Каналы и правила" },
    settings: { title: "Настройки", subtitle: "Параметры приложения" },
};

function setPage(page) {
    if (!PAGE_META[page]) page = "overview";
    $$(".nav-item").forEach((item) => item.classList.toggle("active", item.dataset.page === page));
    $$(".page").forEach((section) => section.classList.toggle("active", section.id === `page-${page}`));
    $("#page-title").textContent = PAGE_META[page].title;
    $("#page-subtitle").textContent = PAGE_META[page].subtitle;
    $("#app").classList.remove("nav-open");
    $("#content").scrollTop = 0;
    history.replaceState(null, "", `#${page}`);
    if (page === "history") loadFullHistory({ silent: true });
    if (page === "notifications") loadLog();
    if (page === "settings") renderLanList();
}

// ── State / rendering ───────────────────────────────────────────────────
function computeCounts() {
    const counts = { total: state.services.length, enabled: 0, ok: 0, error: 0, unknown: 0, disabled: 0 };
    state.services.forEach((service) => {
        if (!service.enabled) {
            counts.disabled += 1;
            return;
        }
        counts.enabled += 1;
        const serviceState = state.states[service.id];
        if (!serviceState || serviceState.success == null) counts.unknown += 1;
        else if (serviceState.success === true) counts.ok += 1;
        else counts.error += 1;
    });
    return counts;
}

function applyStateData(data) {
    state.services = Array.isArray(data.services) ? data.services : [];
    state.states = data.states && typeof data.states === "object" ? data.states : {};
    state.results = Array.isArray(data.results) ? data.results : [];
    state.status = data.status && typeof data.status === "object" ? data.status : {};
    state.channels = Array.isArray(data.channels) ? data.channels : [];
    state.system = data.system && typeof data.system === "object" ? data.system : {};
    state.preferences = data.preferences && typeof data.preferences === "object" ? data.preferences : {};
    state.counts = computeCounts();
    renderAll();
}

function renderAll() {
    updateStatus();
    renderOverview();
    renderHistory();
    if (state.historyLoaded) renderHistoryPage();
    renderServices();
    renderServerInfo();
    renderLanList();
    renderSystemInfo();
    refreshRelativeTimes();
}

function refreshRelativeTimes() {
    $$("[data-relative]").forEach((element) => {
        element.textContent = formatRelative(element.dataset.relative);
    });
}

async function refreshState(options = {}) {
    const { silent = false } = options;
    try {
        const data = await api("/api/state");
        applyStateData(data);
        setConnection("online");
        if (!silent) toast("Данные обновлены", "success");
    } catch (error) {
        setConnection("offline");
        if (!silent) toast(error.message, "error");
    }
}

// ── Live events ─────────────────────────────────────────────────────────
function connectEvents() {
    if (!window.EventSource) {
        setConnection("offline");
        return;
    }
    if (state.eventSource) state.eventSource.close();
    const source = new EventSource("/api/stream");
    state.eventSource = source;

    source.onopen = () => {
        setConnection("online");
    };
    source.onerror = () => {
        setConnection("offline");
    };
    source.onmessage = (message) => {
        if (!message.data) return;
        let event;
        try {
            event = JSON.parse(message.data);
        } catch (error) {
            return;
        }
        handleEvent(event);
    };
}

function handleEvent(event) {
    const type = event && event.type;
    if (type === "connected") {
        if (event.status) state.status = { ...state.status, ...event.status };
        setConnection("online");
        updateStatus();
        if (state.wasOffline) {
            state.wasOffline = false;
            refreshState({ silent: true });
        }
        return;
    }

    if (type === "batch_start") {
        state.status.checking = true;
        state.status.progress = {
            check_id: event.check_id,
            check_time: event.check_time,
            trigger: event.trigger,
            total: event.total,
            done: 0,
            success: 0,
            failed: 0,
            skipped: 0,
        };
        updateStatus();
        renderOverview();
        return;
    }

    if (type === "service_result") {
        const result = event.result || {};
        if (result.service_id) {
            state.states[result.service_id] = event.state || state.states[result.service_id];
        }
        if (event.progress) state.status.progress = event.progress;
        state.counts = computeCounts();
        updateStatus();
        renderOverview();
        renderServices();
        return;
    }

    if (type === "batch_done") {
        state.status.checking = false;
        state.status.progress = null;
        state.status.last_check_time = event.check_time || state.status.last_check_time;
        if (state.pendingCheckToast) {
            state.pendingCheckToast = false;
            const failed = Number(event.failed_count) || 0;
            const total = Number(event.total) || 0;
            if (event.status === "error") {
                toast("Проверка завершилась с ошибкой", "error");
            } else if (failed > 0) {
                toast(`Проверка завершена: ${failed} ${plural(failed, "ошибка", "ошибки", "ошибок")} из ${total}`, "error", 6000);
            } else {
                toast(`Проверка завершена: ${total} ${plural(total, "сервис", "сервиса", "сервисов")} ${total === 1 ? "доступен" : "доступны"}`, "success");
            }
        }
        updateStatus();
        if (state.historyLoaded) loadFullHistory({ silent: true });
        refreshState({ silent: true });
        return;
    }

    if (type === "schedule") {
        state.status.next_check_time = event.next_check_time || null;
        updateCountdown();
        return;
    }

    if (type === "settings_changed" || type === "monitoring") {
        if (event.status) state.status = { ...state.status, ...event.status };
        updateStatus();
        return;
    }

    if (type === "services_changed") {
        refreshState({ silent: true });
    }
}

// ── Status / header ─────────────────────────────────────────────────────
function updateStatus() {
    const status = state.status || {};
    const auto = $("#auto-check");
    if (auto && document.activeElement !== auto) auto.checked = Boolean(status.auto_check_enabled);

    const settingsAuto = $("#set-auto");
    if (settingsAuto && !state.settingsDirty && document.activeElement !== settingsAuto) {
        settingsAuto.checked = Boolean(status.auto_check_enabled);
    }

    const button = $("#check-now");
    const checking = Boolean(status.checking);
    if (button) {
        button.classList.toggle("loading", checking);
        button.disabled = checking;
        button.innerHTML = `${icon("play")}<span>${checking ? "Проверка…" : "Проверить"}</span>`;
    }
    updateCountdown();
}

function updateCountdown() {
    const pill = $("#next-pill");
    const text = $("#next-text");
    if (!pill || !text) return;
    const status = state.status || {};
    const progress = status.progress;

    if (status.checking && progress) {
        pill.hidden = false;
        pill.classList.add("running");
        pill.title = "Проверка выполняется";
        text.textContent = `${Number(progress.done) || 0}/${Number(progress.total) || 0}`;
        return;
    }
    if (status.checking) {
        pill.hidden = false;
        pill.classList.add("running");
        pill.title = "Проверка выполняется";
        text.textContent = "Проверка…";
        return;
    }

    pill.classList.remove("running");
    if (!status.auto_check_enabled) {
        pill.hidden = true;
        text.textContent = "—";
        pill.title = "Автопроверка выключена";
        return;
    }
    pill.hidden = false;
    const next = parseDate(status.next_check_time);
    if (!next) {
        text.textContent = "—";
        pill.title = "Следующая проверка не запланирована";
        return;
    }
    const seconds = Math.max(0, Math.round((next.getTime() - Date.now()) / 1000));
    const hours = Math.floor(seconds / 3600);
    const minutes = Math.floor((seconds % 3600) / 60);
    const rest = seconds % 60;
    const formatted = hours > 0
        ? `${hours}:${String(minutes).padStart(2, "0")}:${String(rest).padStart(2, "0")}`
        : `${String(minutes).padStart(2, "0")}:${String(rest).padStart(2, "0")}`;
    text.textContent = `через ${formatted}`;
    pill.title = `Следующая проверка в ${formatTime(status.next_check_time)}`;
}

async function startCheck() {
    if (!state.services.length) {
        toast("Сначала добавьте хотя бы один сервис", "info");
        setPage("services");
        return;
    }
    state.pendingCheckToast = true;
    setButtonLoading($("#check-now"), true);
    try {
        const result = await api("/api/check", { method: "POST" });
        if (!result.started) {
            state.pendingCheckToast = false;
            toast(result.message || "Проверка уже выполняется", "info");
        }
    } catch (error) {
        state.pendingCheckToast = false;
        toast(error.message, "error");
    } finally {
        window.setTimeout(() => {
            if (!state.status.checking) setButtonLoading($("#check-now"), false);
        }, 3500);
    }
}

// ── Overview ────────────────────────────────────────────────────────────
function renderOverview() {
    state.counts = computeCounts();
    const counts = state.counts;

    setText("#ov-total", counts.total);
    setText("#ov-total-sub", counts.total
        ? `включено ${counts.enabled}${counts.disabled ? `, отключено ${counts.disabled}` : ""}`
        : "пока не добавлены");
    setText("#ov-ok", counts.ok);
    const checked = counts.ok + counts.error;
    setText("#ov-ok-sub", checked
        ? `${Math.round((counts.ok / checked) * 100)}% проверенных`
        : "нет данных");
    setText("#ov-error", counts.error);
    setText("#ov-error-sub", counts.error ? `${counts.error === 1 ? "требует" : "требуют"} внимания` : "ошибок нет");

    let durations = [];
    state.services.forEach((service) => {
        if (!service.enabled) return;
        const serviceState = state.states[service.id];
        if (serviceState && serviceState.success === true && Number.isFinite(Number(serviceState.duration_ms))) {
            durations.push(Number(serviceState.duration_ms));
        }
    });
    durations = durations.filter((value) => value >= 0);
    if (durations.length) {
        const average = Math.round(durations.reduce((sum, value) => sum + value, 0) / durations.length);
        setText("#ov-avg", formatDuration(average));
        setText("#ov-avg-sub", `${durations.length} ${plural(durations.length, "замер", "замера", "замеров")}`);
    } else {
        setText("#ov-avg", "—");
        setText("#ov-avg-sub", "нет данных");
    }

    renderProblems();
    renderLastCheck();
}

function setText(selector, value) {
    const element = $(selector);
    if (element) element.textContent = value;
}

function renderProblems() {
    const container = $("#problems-list");
    const subtitle = $("#problems-sub");
    if (!container) return;

    const problems = state.services.filter((service) => {
        if (!service.enabled) return false;
        const serviceState = state.states[service.id];
        return serviceState && serviceState.success === false;
    });

    if (subtitle) {
        subtitle.textContent = problems.length
            ? `${problems.length} ${plural(problems.length, "сервис", "сервиса", "сервисов")} с ошибкой`
            : "Сервисы с ошибкой";
    }

    if (!state.services.length) {
        container.innerHTML = `
            <div class="all-ok">
                ${icon("server")}
                <div><strong>Сервисов пока нет</strong>Добавьте HTTP-адрес, чтобы начать мониторинг.</div>
            </div>`;
        return;
    }

    if (!problems.length) {
        container.innerHTML = `
            <div class="all-ok">
                ${icon("check")}
                <div><strong>Все сервисы доступны</strong>Ошибок на последней проверке нет.</div>
            </div>`;
        return;
    }

    container.innerHTML = problems.map((service) => {
        const serviceState = state.states[service.id] || {};
        const error = serviceState.error || `HTTP ${serviceState.status_code || "—"}`;
        return `
            <div class="problem-item">
                <div class="problem-icon">${icon("alert")}</div>
                <div class="problem-main">
                    <strong>${escapeHtml(displayName(service))}</strong>
                    <span>${escapeHtml(service.url)}</span>
                </div>
                <span class="problem-error" title="${escapeHtml(error)}">${escapeHtml(error)}</span>
                <div class="problem-actions">
                    <button class="icon-btn small" data-action="test" data-id="${escapeHtml(service.id)}" title="Проверить сейчас" aria-label="Проверить сейчас: ${escapeHtml(displayName(service))}">${icon("play")}</button>
                    <button class="icon-btn small" data-action="edit" data-id="${escapeHtml(service.id)}" title="Изменить" aria-label="Изменить: ${escapeHtml(displayName(service))}">${icon("edit")}</button>
                </div>
            </div>`;
    }).join("");
}

function triggerLabel(trigger) {
    if (trigger === "auto") return "автоматически";
    if (trigger === "manual") return "вручную";
    return trigger ? String(trigger) : "—";
}

function triggerShort(trigger) {
    if (trigger === "auto") return "авто";
    if (trigger === "manual") return "вручную";
    return trigger ? String(trigger) : "—";
}

function renderLastCheck() {
    const summary = $("#last-check-summary");
    const pill = $("#last-check-pill");
    if (!summary || !pill) return;

    const progress = state.status && state.status.progress;
    let batch = null;
    if (state.status && state.status.checking && progress) {
        batch = {
            check_time: progress.check_time,
            finished_at: null,
            trigger: progress.trigger,
            total: progress.total,
            success_count: progress.success,
            failed_count: progress.failed,
            skipped_count: progress.skipped,
            status: "running",
        };
    } else if (state.results.length) {
        batch = state.results[0];
    }

    if (!batch) {
        pill.className = "pill";
        pill.textContent = "—";
        summary.innerHTML = `
            <div class="all-ok">
                ${icon("clock")}
                <div><strong>Проверок ещё не было</strong>Нажмите «Проверить», чтобы получить первый результат.</div>
            </div>`;
        return;
    }

    const total = Number(batch.total) || 0;
    const ok = Number(batch.success_count) || 0;
    const failed = Number(batch.failed_count) || 0;
    const skipped = Number(batch.skipped_count) || 0;
    const isRunning = batch.status === "running";

    if (isRunning) {
        pill.className = "pill";
        pill.textContent = "Выполняется";
    } else if (batch.status === "error" || batch.status === "cancelled") {
        pill.className = "pill err";
        pill.textContent = batch.status === "cancelled" ? "Прервано" : "Ошибка";
    } else if (failed > 0) {
        pill.className = "pill err";
        pill.textContent = "С ошибками";
    } else {
        pill.className = "pill ok";
        pill.textContent = "Успешно";
    }

    const percent = (value) => (total > 0 ? Math.max(0, Math.min(100, (value / total) * 100)) : 0);
    const started = parseDate(batch.check_time);
    const finished = parseDate(batch.finished_at);
    const duration = started ? ((finished || new Date()).getTime() - started.getTime()) : null;

    summary.innerHTML = `
        <div class="summary-row">
            <div class="summary-bar" title="${escapeHtml(`${ok} доступны, ${failed} с ошибкой, ${skipped} пропущено`)}">
                <span class="ok" style="width:${percent(ok)}%"></span>
                <span class="err" style="width:${percent(failed)}%"></span>
                <span class="skip" style="width:${percent(skipped)}%"></span>
            </div>
            <span class="muted">${total || 0}</span>
        </div>
        <div class="summary-legend">
            <span><i class="legend-dot ok"></i>${ok} доступны</span>
            <span><i class="legend-dot err"></i>${failed} с ошибкой</span>
            <span><i class="legend-dot skip"></i>${skipped} пропущено</span>
        </div>
        <div class="summary-meta">
            <span>Начало: <b>${escapeHtml(formatDateTime(batch.check_time))}</b></span>
            <span>Длительность: <b>${escapeHtml(duration == null ? "—" : formatDuration(duration))}</b></span>
            <span>Запуск: <b>${escapeHtml(triggerLabel(batch.trigger))}</b></span>
            <span>Сервисов: <b>${total}</b></span>
        </div>`;
}

// ── History ─────────────────────────────────────────────────────────────
function renderHistory() {
    const container = $("#history-list");
    const total = $("#history-total");
    const more = $("#history-more");
    if (!container) return;

    if (!state.results.length) {
        container.innerHTML = `
            <div class="all-ok">
                ${icon("activity")}
                <div><strong>История пуста</strong>Результаты проверок появятся здесь.</div>
            </div>`;
        if (total) total.textContent = "";
        if (more) more.hidden = true;
        return;
    }

    const open = new Set($$("#history-list details[open]").map((element) => element.dataset.batch));
    const visible = state.results.slice(0, state.historyVisible);
    container.innerHTML = visible.map((batch) => batchHtml(batch, open.has(batch.check_id))).join("");

    if (total) {
        total.textContent = `Показано ${Math.min(state.historyVisible, state.results.length)} из ${state.results.length}`;
    }
    if (more) more.hidden = state.results.length <= state.historyVisible;
}

function batchHtml(batch, isOpen) {
    const total = Number(batch.total) || 0;
    const ok = Number(batch.success_count) || 0;
    const failed = Number(batch.failed_count) || 0;
    const skipped = Number(batch.skipped_count) || 0;
    const running = batch.status === "running";
    const results = Array.isArray(batch.results) ? batch.results : [];

    const rows = results.length
        ? results.map((result) => {
            const rowOk = result.success === true;
            const rowError = result.success === false;
            const errorText = result.error || (rowOk ? "OK" : rowError ? "Ошибка" : "—");
            return `
                <tr>
                    <td>
                        <div class="svc-title">${escapeHtml(result.name || result.url || "Сервис")}</div>
                        <div class="cell-url">${escapeHtml(result.url || "")}</div>
                    </td>
                    <td><span class="method-badge ${escapeHtml((result.method || "GET").toUpperCase())}">${escapeHtml(result.method || "GET")}</span></td>
                    <td class="cell-code">${result.status_code == null ? "—" : escapeHtml(result.status_code)}</td>
                    <td class="cell-duration">${result.success == null ? "—" : escapeHtml(formatDuration(result.duration_ms))}</td>
                    <td class="cell-error" title="${escapeHtml(errorText)}">${escapeHtml(errorText)}</td>
                </tr>`;
        }).join("")
        : `<tr class="row-pending"><td colspan="5">${running ? "Проверка выполняется…" : "Результатов нет"}</td></tr>`;

    const badges = [
        ok ? `<span class="mini-badge ok">${ok} ок</span>` : "",
        failed ? `<span class="mini-badge err">${failed} ${plural(failed, "ошибка", "ошибки", "ошибок")}</span>` : "",
        skipped ? `<span class="mini-badge">${skipped} пропущено</span>` : "",
        running ? `<span class="mini-badge live">идёт</span>` : "",
        batch.status === "error" ? `<span class="mini-badge err">прервано</span>` : "",
    ].filter(Boolean).join("");

    return `
        <details class="batch${running ? " live" : ""}" data-batch="${escapeHtml(batch.check_id || "")}"${isOpen ? " open" : ""}>
            <summary>
                ${icon("chevron-right", "icon chev")}
                <span class="batch-time">${escapeHtml(formatDateTime(batch.check_time))}</span>
                <span class="batch-trigger">${escapeHtml(triggerLabel(batch.trigger))}</span>
                <span class="batch-badges">${badges || `<span class="mini-badge">${total}</span>`}</span>
            </summary>
            <div class="batch-body">
                <table>
                    <thead><tr><th>Сервис</th><th>Метод</th><th>Код</th><th>Ответ</th><th>Результат</th></tr></thead>
                    <tbody>${rows}</tbody>
                </table>
            </div>
        </details>`;
}

// ── Full history page ───────────────────────────────────────────────────
const HISTORY_PERIOD_MS = {
    "1h": 3_600_000,
    "24h": 86_400_000,
    "7d": 7 * 86_400_000,
    "30d": 30 * 86_400_000,
};

function historyTime(row) {
    return parseDate(row.checked_at || row.check_time);
}

function flattenHistory(batches) {
    const rows = [];
    (Array.isArray(batches) ? batches : []).forEach((batch) => {
        const results = Array.isArray(batch.results) ? batch.results : [];
        results.forEach((result) => {
            rows.push({
                ...result,
                trigger: batch.trigger,
                check_id: batch.check_id,
                check_time: batch.check_time,
                batch_status: batch.status,
            });
        });
    });
    rows.sort((left, right) => {
        const a = historyTime(left);
        const b = historyTime(right);
        return (b ? b.getTime() : 0) - (a ? a.getTime() : 0);
    });
    return rows;
}

function historyRowStatus(row) {
    if (row.success === true) return { className: "ok", text: "Успешно" };
    if (row.success === false) return { className: "err", text: "Ошибка" };
    return { className: "disabled", text: "Пропущено" };
}

function filteredHistoryRows() {
    const options = state.history;
    const query = (options.query || "").trim().toLowerCase();
    const period = HISTORY_PERIOD_MS[options.period];
    const cutoff = period ? Date.now() - period : null;

    return state.fullHistory.filter((row) => {
        if (query) {
            const haystack = `${row.name || ""} ${row.url || ""} ${row.error || ""} ${row.comment || ""}`.toLowerCase();
            if (!haystack.includes(query)) return false;
        }
        if (options.status === "ok" && row.success !== true) return false;
        if (options.status === "error" && row.success !== false) return false;
        if (options.status === "skipped" && row.success !== null) return false;
        if (options.trigger !== "all" && row.trigger !== options.trigger) return false;
        if (cutoff != null) {
            const date = historyTime(row);
            if (!date || date.getTime() < cutoff) return false;
        }
        return true;
    });
}

async function loadFullHistory(options = {}) {
    const { silent = false } = options;
    try {
        const batches = await api("/api/results?limit=1000");
        state.fullHistory = flattenHistory(batches);
        state.historyLoaded = true;
        renderHistoryPage();
        if (!silent) toast("История обновлена", "success");
        return true;
    } catch (error) {
        toast(error.message, "error");
        return false;
    }
}

function renderHistoryPage() {
    const body = $("#history-body");
    const empty = $("#history-empty");
    if (!body) return;

    const rows = filteredHistoryRows();
    const ok = rows.filter((row) => row.success === true).length;
    const failed = rows.filter((row) => row.success === false).length;
    const checkedCount = ok + failed;
    const durations = rows
        .filter((row) => row.success === true && Number.isFinite(Number(row.duration_ms)))
        .map((row) => Number(row.duration_ms));
    const average = durations.length
        ? Math.round(durations.reduce((sum, value) => sum + value, 0) / durations.length)
        : null;
    const checks = new Set(rows.map((row) => row.check_id)).size;
    const filtered = state.history.query
        || state.history.status !== "all"
        || state.history.trigger !== "all"
        || state.history.period !== "all";

    const checkWord = plural(checks, "проверка", "проверки", "проверок");
    setText("#hist-total", rows.length);
    setText("#hist-total-sub", `${checks} ${checkWord} ${filtered ? "в выборке" : "всего"}`);
    setText("#hist-ok", ok);
    setText("#hist-ok-sub", checkedCount ? `${Math.round((ok / checkedCount) * 100)}% проверенных` : "нет данных");
    setText("#hist-error", failed);
    setText("#hist-error-sub", failed ? `${failed === 1 ? "требует" : "требуют"} внимания` : "ошибок нет");
    setText("#hist-avg", average == null ? "—" : formatDuration(average));
    setText("#hist-avg-sub", durations.length ? `${durations.length} ${plural(durations.length, "замер", "замера", "замеров")}` : "нет данных");

    const count = $("#history-count");
    if (count) {
        count.textContent = filtered
            ? `${rows.length} из ${state.fullHistory.length}`
            : `${state.fullHistory.length} ${plural(state.fullHistory.length, "запись", "записи", "записей")}`;
    }

    const scroll = $(".table-scroll", $("#page-history"));
    if (!rows.length) {
        body.innerHTML = "";
        if (scroll) scroll.hidden = true;
        if (empty) {
            empty.hidden = false;
            empty.innerHTML = state.fullHistory.length
                ? `
                    <strong>Ничего не найдено</strong>
                    Измените фильтры или выберите другой период.
                    <div><button class="btn" data-history-reset>${icon("refresh")}Сбросить фильтры</button></div>`
                : `
                    <strong>История пуста</strong>
                    Результаты появятся после первой проверки сервисов.`;
        }
    } else {
        if (scroll) scroll.hidden = false;
        if (empty) {
            empty.hidden = true;
            empty.innerHTML = "";
        }
        const visible = rows.slice(0, state.history.visible);
        body.innerHTML = visible.map((row) => {
            const status = historyRowStatus(row);
            const date = historyTime(row);
            const errorText = row.error
                || (row.success === true ? "—" : row.success === null ? "Мониторинг отключён" : "Ошибка");
            return `
                <tr>
                    <td class="col-history-time">
                        <span class="svc-time" title="${escapeHtml(date ? formatFull(date) : "—")}">${escapeHtml(date ? formatDateTime(date) : "—")}</span>
                        <div class="svc-sub">${escapeHtml(triggerShort(row.trigger))} · ${escapeHtml(date ? formatRelative(date) : "—")}</div>
                    </td>
                    <td>
                        <div class="svc-title" title="${escapeHtml(row.name || row.url || "Сервис")}">${escapeHtml(row.name || row.url || "Сервис")}</div>
                        <div class="svc-url" title="${escapeHtml(row.url || "")}"><span class="history-method">${escapeHtml(row.method || "GET")}</span> ${escapeHtml(row.url || "")}</div>
                    </td>
                    <td class="col-history-status"><span class="status-pill ${status.className}"><span class="dot"></span>${escapeHtml(status.text)}</span></td>
                    <td class="col-history-code cell-code">${row.status_code == null ? "—" : escapeHtml(row.status_code)}</td>
                    <td class="col-history-duration cell-duration">${row.success == null ? "—" : escapeHtml(formatDuration(row.duration_ms))}</td>
                    <td class="history-error ${row.success === false ? "is-error" : ""}" title="${escapeHtml(errorText)}">${escapeHtml(errorText)}</td>
                </tr>`;
        }).join("");
    }

    const shown = $("#history-shown");
    if (shown) shown.textContent = rows.length ? `Показано ${Math.min(state.history.visible, rows.length)} из ${rows.length}` : "";
    const more = $("#history-load-more");
    if (more) more.hidden = rows.length <= state.history.visible;
}

function resetHistoryFilters() {
    state.history.query = "";
    state.history.status = "all";
    state.history.trigger = "all";
    state.history.period = "all";
    state.history.visible = 200;
    $("#history-search").value = "";
    $("#history-status").value = "all";
    $("#history-trigger").value = "all";
    $("#history-period").value = "all";
    renderHistoryPage();
}

function csvCell(value) {
    return `"${String(value == null ? "" : value).replace(/"/g, '""')}"`;
}

function exportHistoryCsv() {
    const rows = filteredHistoryRows();
    if (!rows.length) {
        toast("В истории нет записей для экспорта", "info");
        return;
    }
    const header = ["Время", "Сервис", "URL", "Метод", "Статус", "Код", "Ответ, мс", "Ошибка", "Запуск", "ID проверки"];
    const lines = rows.map((row) => [
        row.checked_at || row.check_time || "",
        row.name || "",
        row.url || "",
        row.method || "",
        historyRowStatus(row).text,
        row.status_code == null ? "" : row.status_code,
        row.duration_ms == null ? "" : row.duration_ms,
        row.error || "",
        triggerLabel(row.trigger),
        row.check_id || "",
    ].map(csvCell).join(";"));
    const blob = new Blob([`\ufeff${[header.map(csvCell).join(";"), ...lines].join("\r\n")}`], {
        type: "text/csv;charset=utf-8",
    });
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    link.download = `service-monitor-history-${new Date().toISOString().slice(0, 10)}.csv`;
    document.body.append(link);
    link.click();
    link.remove();
    window.setTimeout(() => URL.revokeObjectURL(url), 1000);
    toast(`Экспортировано ${rows.length} ${plural(rows.length, "запись", "записи", "записей")}`, "success");
}

// ── Services table ──────────────────────────────────────────────────────
function statusInfo(service) {
    if (!service.enabled) return { className: "disabled", text: "Отключён" };
    const serviceState = state.states[service.id];
    if (!serviceState || serviceState.success == null) {
        return state.status && state.status.checking
            ? { className: "pending", text: "Проверка" }
            : { className: "unknown", text: "Нет данных" };
    }
    if (serviceState.success === true) return { className: "ok", text: "Доступен" };
    return { className: "err", text: "Ошибка" };
}

function statusPill(service) {
    const info = statusInfo(service);
    const serviceState = state.states[service.id] || {};
    const title = serviceState.error || (serviceState.checked_at ? `Проверено ${formatFull(serviceState.checked_at)}` : "Результата пока нет");
    return `<span class="status-pill ${info.className}" title="${escapeHtml(title)}"><span class="dot"></span>${escapeHtml(info.text)}</span>`;
}

function notifyCell(service) {
    const globalEnabled = !state.settings || !state.settings.notifications || state.settings.notifications.enabled !== false;
    if (!globalEnabled) {
        return `<span class="notify-cell off" title="Уведомления выключены в настройках">${icon("bell")}Выкл.</span>`;
    }
    if (!service.notify_on_error) {
        return `<span class="notify-cell off" title="Уведомления для сервиса отключены">${icon("bell")}Выкл.</span>`;
    }
    const enabledChannels = state.channels.filter((channel) => channel.enabled);
    if (!enabledChannels.length) {
        return `<span class="notify-cell off" title="Ни один канал не включён">${icon("bell")}Нет каналов</span>`;
    }
    const selected = service.notify_channels == null
        ? enabledChannels
        : enabledChannels.filter((channel) => service.notify_channels.includes(channel.id));
    if (!selected.length) {
        return `<span class="notify-cell off" title="Каналы для сервиса не выбраны">${icon("bell")}Нет каналов</span>`;
    }
    const label = selected.length === enabledChannels.length
        ? "Все каналы"
        : selected.map((channel) => channel.label).join(", ");
    return `<span class="notify-cell on" title="${escapeHtml(selected.map((channel) => channel.label).join(", "))}">${icon("bell")}${escapeHtml(label)}</span>`;
}

function lastCheckCell(service) {
    if (!service.enabled) {
        return `<span class="svc-time">—</span><div class="svc-sub">мониторинг отключён</div>`;
    }
    const serviceState = state.states[service.id];
    if (!serviceState || !serviceState.checked_at) {
        return `<span class="svc-time">—</span><div class="svc-sub">нет данных</div>`;
    }
    if (serviceState.success == null) {
        return `<span class="svc-time">${relativeHtml(serviceState.checked_at)}</span><div class="svc-sub">пропущено</div>`;
    }
    const parts = [];
    if (serviceState.status_code != null) parts.push(`HTTP ${serviceState.status_code}`);
    if (Number.isFinite(Number(serviceState.duration_ms))) parts.push(formatDuration(serviceState.duration_ms));
    return `<span class="svc-time">${relativeHtml(serviceState.checked_at)}</span><div class="svc-sub">${escapeHtml(parts.join(" · ") || "—")}</div>`;
}

function filteredServices() {
    const query = ($("#service-search").value || "").trim().toLowerCase();
    const filter = $("#service-filter").value || "all";
    return state.services.filter((service) => {
        if (query) {
            const haystack = `${service.name || ""} ${service.url || ""} ${service.comment || ""}`.toLowerCase();
            if (!haystack.includes(query)) return false;
        }
        if (filter === "all") return true;
        if (filter === "disabled") return !service.enabled;
        if (!service.enabled) return false;
        const serviceState = state.states[service.id];
        if (filter === "error") return Boolean(serviceState && serviceState.success === false);
        if (filter === "ok") return Boolean(serviceState && serviceState.success === true);
        if (filter === "unknown") return !serviceState || serviceState.success == null;
        return true;
    });
}

function renderServices() {
    const body = $("#services-body");
    const empty = $("#services-empty");
    if (!body) return;
    const services = filteredServices();
    const count = $("#services-count");
    const filterActive = Boolean(($("#service-search").value || "").trim()) || ($("#service-filter").value || "all") !== "all";

    if (count) {
        count.textContent = filterActive
            ? `${services.length} из ${state.services.length}`
            : `${state.services.length} ${plural(state.services.length, "сервис", "сервиса", "сервисов")}`;
    }
    const navCount = $("#nav-services-count");
    if (navCount) navCount.textContent = String(state.services.length);
    const navErrors = $("#nav-errors-dot");
    if (navErrors) {
        const errorCount = state.counts.error;
        navErrors.hidden = !errorCount;
        navErrors.title = errorCount
            ? `${errorCount} ${plural(errorCount, "сервис", "сервиса", "сервисов")} с ошибкой`
            : "";
    }

    body.innerHTML = services.map((service) => {
        const channelsTitle = service.notify_channels == null
            ? "Все включённые каналы"
            : (service.notify_channels.length ? service.notify_channels.length : 0) + " " + plural(service.notify_channels.length, "канал", "канала", "каналов");
        return `
            <tr data-id="${escapeHtml(service.id)}">
                <td class="col-status">${statusPill(service)}</td>
                <td>
                    <div class="svc-title" title="${escapeHtml(displayName(service))}">${escapeHtml(displayName(service))}</div>
                    <div class="svc-url" title="${escapeHtml(service.url)}">${escapeHtml(service.url)}</div>
                    ${service.comment ? `<div class="svc-comment">${escapeHtml(service.comment)}</div>` : ""}
                </td>
                <td class="col-method"><span class="method-badge ${escapeHtml(service.method)}">${escapeHtml(service.method)}</span></td>
                <td class="col-notify" title="${escapeHtml(channelsTitle)}">${notifyCell(service)}</td>
                <td class="col-last">${lastCheckCell(service)}</td>
                <td class="col-actions">
                    <div class="cell-actions">
                        <button class="icon-btn small" data-action="test" data-id="${escapeHtml(service.id)}" title="Проверить сейчас" aria-label="Проверить сейчас: ${escapeHtml(displayName(service))}">${icon("play")}</button>
                        <button class="icon-btn small" data-action="edit" data-id="${escapeHtml(service.id)}" title="Изменить" aria-label="Изменить: ${escapeHtml(displayName(service))}">${icon("edit")}</button>
                        <button class="icon-btn small danger" data-action="delete" data-id="${escapeHtml(service.id)}" title="Удалить" aria-label="Удалить: ${escapeHtml(displayName(service))}">${icon("trash")}</button>
                        <label class="switch" title="${service.enabled ? "Отключить мониторинг" : "Включить мониторинг"}">
                            <input type="checkbox" data-action="toggle" data-id="${escapeHtml(service.id)}" aria-label="${service.enabled ? "Отключить" : "Включить"} мониторинг: ${escapeHtml(displayName(service))}"${service.enabled ? " checked" : ""}>
                            <span class="switch-track"></span>
                        </label>
                    </div>
                </td>
            </tr>`;
    }).join("");

    if (empty) {
        if (services.length === 0) {
            empty.hidden = false;
            if (!state.services.length) {
                empty.innerHTML = `
                    <strong>Сервисов пока нет</strong>
                    Добавьте первый HTTP-адрес для мониторинга.
                    <div><button class="btn btn-primary" data-action="add">${icon("plus")}Добавить сервис</button></div>`;
            } else {
                empty.innerHTML = `
                    <strong>Ничего не найдено</strong>
                    Измените запрос или сбросьте фильтр.
                    <div><button class="btn" data-action="reset-filters">${icon("refresh")}Сбросить фильтр</button></div>`;
            }
        } else {
            empty.hidden = true;
            empty.innerHTML = "";
        }
    }
}

// ── Service drawer ──────────────────────────────────────────────────────
function markFormDirty() {
    const drawer = $("#service-drawer");
    if (!drawer || drawer.hidden) return;
    state.formDirty = true;
    const indicator = $("#dirty-indicator");
    if (indicator) indicator.hidden = false;
}

function clearFormDirty() {
    state.formDirty = false;
    const indicator = $("#dirty-indicator");
    if (indicator) indicator.hidden = true;
}

function renderHeadersInto(container, headers) {
    if (!container) return;
    const list = Array.isArray(headers) ? headers : [];
    container.innerHTML = "";
    if (!list.length) {
        const empty = document.createElement("div");
        empty.className = "kv-empty";
        empty.textContent = "Заголовков нет";
        container.append(empty);
        return;
    }
    list.forEach((header) => addHeaderRow(container, header));
}

function addHeaderRow(container, header = {}) {
    if (!container) return;
    const empty = $(".kv-empty", container);
    if (empty) empty.remove();
    const row = document.createElement("div");
    row.className = "kv-row";
    row.innerHTML = `
        <input type="checkbox" class="kv-check" title="Отправлять заголовок"${header.enabled === false ? "" : " checked"}>
        <input type="text" class="kv-key" placeholder="Заголовок" value="${escapeHtml(header.key || "")}" spellcheck="false">
        <input type="text" class="kv-value" placeholder="Значение" value="${escapeHtml(header.value || "")}" spellcheck="false">
        <button type="button" class="icon-btn small danger" data-remove-header title="Удалить заголовок">${icon("trash")}</button>`;
    container.append(row);
    const keyInput = $(".kv-key", row);
    if (!header.key && keyInput) keyInput.focus();
}

function collectHeaders(container) {
    if (!container) return [];
    return $$(".kv-row", container).map((row) => ({
        key: ($(".kv-key", row)?.value || "").trim(),
        value: $(".kv-value", row)?.value || "",
        enabled: Boolean($(".kv-check", row)?.checked),
    })).filter((header) => header.key);
}

function updateAuthGroups() {
    const type = $("#f-auth-type").value;
    $("#auth-basic").hidden = type !== "basic";
    $("#auth-bearer").hidden = type !== "bearer";
}

function setChannelSelection(channels) {
    const active = new Set(channels);
    $$("#notify-channels .chip").forEach((chip) => {
        const selected = active.has(chip.dataset.channel);
        chip.classList.toggle("active", selected);
        chip.setAttribute("aria-pressed", selected ? "true" : "false");
    });
    updateChannelsHint();
}

function renderChannelChips(service) {
    const container = $("#notify-channels");
    if (!container) return;
    const available = state.channels.length
        ? state.channels
        : CHANNEL_IDS.map((id) => ({ id, label: CHANNEL_NAMES[id], enabled: false, configured: false }));
    const selected = service.notify_channels == null ? CHANNEL_IDS.slice() : service.notify_channels.slice();
    container.innerHTML = available.map((channel) => {
        const active = selected.includes(channel.id);
        const note = channel.enabled
            ? (channel.configured ? "настроен" : "нет данных для отправки")
            : "канал выключен";
        const classes = ["chip", active ? "active" : "", channel.enabled ? "" : "off"].filter(Boolean).join(" ");
        return `<button type="button" class="${classes}" data-channel="${escapeHtml(channel.id)}" aria-pressed="${active}" title="${escapeHtml(`${channel.label} — ${note}`)}"><span class="chip-dot"></span>${escapeHtml(channel.label)}</button>`;
    }).join("");
    updateChannelsHint();
    updateChipsDisabled();
}

function selectedChannels() {
    return $$("#notify-channels .chip.active").map((chip) => chip.dataset.channel);
}

function updateChannelsHint() {
    const hint = $("#notify-channels-hint");
    if (!hint) return;
    const notify = $("#f-notify");
    if (notify && !notify.checked) {
        hint.textContent = "Уведомления для этого сервиса выключены.";
        return;
    }
    const channels = state.channels || [];
    const enabledChannels = channels.filter((channel) => channel.enabled);
    const selected = selectedChannels();
    if (!enabledChannels.length) {
        hint.textContent = "Нет включённых каналов. Настройте их в разделе «Уведомления».";
        return;
    }
    if (!selected.length) {
        hint.textContent = "Сообщения об ошибке отправляться не будут.";
        return;
    }
    if (selected.length === CHANNEL_IDS.length) {
        hint.textContent = "Будут использованы все включённые каналы, включая добавленные позже.";
        return;
    }
    hint.textContent = `Выбрано ${selected.length} из ${CHANNEL_IDS.length} каналов.`;
}

function updateChipsDisabled() {
    const enabled = Boolean($("#f-notify")?.checked);
    $$("#notify-channels .chip").forEach((chip) => {
        chip.disabled = !enabled;
        chip.classList.toggle("disabled", !enabled);
    });
}

function updateMonitorHint() {
    const hint = $("#monitor-hint");
    const enabled = $("#f-enabled");
    if (!hint || !enabled) return;
    hint.textContent = enabled.checked ? "Проверять по расписанию" : "Только ручные проверки";
}

function formatSize(bytes, partial = false) {
    const value = Number(bytes);
    if (!Number.isFinite(value) || value < 0) return "—";
    let text;
    if (value < 1024) text = `${value} Б`;
    else if (value < 1024 * 1024) text = `${(value / 1024).toFixed(value < 10 * 1024 ? 1 : 0)} КБ`;
    else if (value < 1024 * 1024 * 1024) text = `${(value / (1024 * 1024)).toFixed(1)} МБ`;
    else text = `${(value / (1024 * 1024 * 1024)).toFixed(2)} ГБ`;
    return partial ? `≥ ${text}` : text;
}

function detectResponseFormat(result) {
    const type = String(result.response_content_type || "").toLowerCase();
    if (type.includes("json")) return "json";
    if (type.includes("html")) return "html";
    if (type.includes("xml")) return "xml";
    const body = String(result.response_body || "").trim();
    if (!body) return "text";
    if (/^[\[{]/.test(body)) return "json";
    if (/^(<!doctype\s+html|<html[\s>])/i.test(body)) return "html";
    if (/^(<\?xml|<[a-z][\w:.-]*[\s/>])/i.test(body)) return "xml";
    return "text";
}

const VOID_TAGS = new Set(["area", "base", "br", "col", "embed", "hr", "img", "input", "link", "meta", "param", "source", "track", "wbr"]);
const MARKUP_TOKEN = /<!--[\s\S]*?-->|<!\[CDATA\[[\s\S]*?\]\]>|<![^>]*>|<\?[\s\S]*?\?>|<(script|style|pre|textarea)\b[^>]*>[\s\S]*?<\/\1\s*>|<[^>]*>|[^<]+/gi;

function formatMarkup(source) {
    const raw = String(source || "").replace(/\r\n/g, "\n").trim();
    if (!raw || !raw.includes("<")) return raw;
    const tokens = (raw.replace(/>\s+</g, "><").match(MARKUP_TOKEN) || [])
        .map((token) => token.trim())
        .filter(Boolean);
    const lines = [];
    let depth = 0;
    const pad = (level) => "  ".repeat(Math.max(0, level));
    const pushText = (text) => {
        const clean = text.replace(/\s+/g, " ").trim();
        if (clean) lines.push(pad(depth) + clean);
    };
    for (let index = 0; index < tokens.length; index += 1) {
        const token = tokens[index];
        if (!token.startsWith("<")) {
            pushText(token);
            continue;
        }
        const isPlainTag = /^<[^>]*>$/.test(token);
        const isClosing = /^<\//.test(token);
        const isSpecial = /^<[!?]/.test(token);
        const nameMatch = token.match(/^<([a-zA-Z][\w:.-]*)/);
        const next = tokens[index + 1];
        const after = tokens[index + 2];
        if (
            isPlainTag && nameMatch && !isClosing && !isSpecial &&
            next && !next.startsWith("<") && after &&
            new RegExp(`^</${nameMatch[1].replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}>$`, "i").test(after) &&
            next.length <= 100
        ) {
            lines.push(pad(depth) + token + next.replace(/\s+/g, " ") + after);
            index += 2;
            continue;
        }
        if (isClosing) {
            depth = Math.max(0, depth - 1);
            lines.push(pad(depth) + token);
            continue;
        }
        if (isSpecial) {
            lines.push(pad(depth) + token);
            continue;
        }
        lines.push(pad(depth) + token);
        const voidTag = nameMatch && VOID_TAGS.has(nameMatch[1].toLowerCase());
        if (!/\/>$/.test(token) && !voidTag && !/^<(script|style|pre|textarea)\b/i.test(token)) depth += 1;
    }
    return lines.join("\n");
}

function responseBodyText() {
    const response = state.testResponse;
    const box = $("#test-body");
    if (!response || !box) return "";
    return box.textContent || "";
}

function renderResponseBody() {
    const box = $("#test-body");
    if (!box) return;
    const response = state.testResponse;
    if (!response) {
        box.textContent = "";
        return;
    }
    if (response.response_binary) {
        const size = formatSize(response.response_size, response.response_size_partial);
        const type = response.response_content_type || "не указан";
        const canSave = Boolean(response.response_body_base64);
        box.textContent = [
            `Двоичный ответ · ${size}`,
            `Content-Type: ${type}`,
            "",
            canSave
                ? "Тело ответа не отображается как текст. Нажмите «Скачать», чтобы сохранить файл."
                : "Тело ответа не сохранено, скачивание недоступно.",
        ].join("\n");
        return;
    }
    let body = String(state.testBody || "");
    if (!body) {
        box.textContent = "Ответ без тела";
        return;
    }
    if (state.testFormat === "json") {
        const trimmed = body.trim();
        if (trimmed.startsWith("{") || trimmed.startsWith("[")) {
            try {
                body = JSON.stringify(JSON.parse(trimmed), null, 2);
            } catch (error) {
                /* keep the original body */
            }
        }
    } else if (state.testFormat === "html" || state.testFormat === "xml") {
        body = formatMarkup(body);
    }
    if (response.body_truncated) body += "\n\n— ответ обрезан —";
    box.textContent = body;
}

function syncFormatSwitch() {
    const switcher = $("#format-switch");
    if (switcher) {
        const response = state.testResponse;
        switcher.hidden = !response || Boolean(response.response_binary) || state.testTab !== "body";
        $$(".format-btn", switcher).forEach((button) => {
            const active = button.dataset.format === state.testFormat;
            button.classList.toggle("active", active);
            button.setAttribute("aria-pressed", active ? "true" : "false");
        });
    }
    const download = $("#test-download");
    if (download) {
        const response = state.testResponse;
        const canDownload = Boolean(response) && (Boolean(response.response_body_base64) || !response.response_binary);
        download.hidden = !canDownload;
    }
}

function setResponseFormat(format) {
    const allowed = ["json", "html", "xml", "text"];
    state.testFormat = allowed.includes(format) ? format : "text";
    renderResponseBody();
    syncFormatSwitch();
    const body = $("#test-body");
    if (body) body.scrollTop = 0;
}

function resetResponsePanel() {
    const box = $("#test-result");
    if (!box) return;
    box.hidden = true;
    state.testResponse = null;
    state.testFormat = "json";
    setResponseTab("body");
    const summary = $("#test-summary");
    if (summary) summary.innerHTML = "";
    const error = $("#test-error");
    if (error) {
        error.hidden = true;
        error.textContent = "";
    }
    const body = $("#test-body");
    if (body) body.textContent = "";
    const headers = $("#test-headers");
    if (headers) headers.textContent = "";
    state.testBody = "";
    state.testHeaders = "";
    syncFormatSwitch();
}

function setResponseTab(tab) {
    state.testTab = tab === "headers" ? "headers" : "body";
    $$(".response-tab").forEach((button) => {
        const active = button.dataset.responseTab === state.testTab;
        button.classList.toggle("active", active);
        button.setAttribute("aria-selected", active ? "true" : "false");
    });
    const body = $("#test-body");
    const headers = $("#test-headers");
    if (body) body.hidden = state.testTab !== "body";
    if (headers) headers.hidden = state.testTab !== "headers";
    syncFormatSwitch();
}

function openDrawer(serviceId = null) {
    const service = serviceId ? state.services.find((item) => item.id === serviceId) : null;
    if (serviceId && !service) {
        toast("Сервис не найден", "error");
        return;
    }

    state.editingId = service ? service.id : null;
    state.formDirty = false;

    $("#drawer-title").textContent = service ? "Изменить сервис" : "Новый сервис";
    $("#drawer-sub").textContent = service
        ? "Измените запрос и сохраните изменения"
        : "Соберите запрос, отправьте его и сохраните сервис";

    const value = service || {};
    const auth = value.auth || {};
    $("#f-enabled").checked = value.enabled !== false;
    $("#f-name").value = value.name || "";
    $("#f-method").value = value.method || "GET";
    $("#f-url").value = value.url || "";
    $("#f-comment").value = value.comment || "";
    $("#f-auth-type").value = auth.type || "none";
    $("#f-auth-user").value = auth.username || "";
    $("#f-auth-pass").value = auth.password || "";
    $("#f-auth-token").value = auth.token || "";
    $("#f-body").value = value.body || "";
    $("#f-expected").value = value.expected_status || "200-299";
    $("#f-timeout").value = value.timeout_seconds == null ? "" : value.timeout_seconds;
    $("#f-body-contains").value = value.body_contains || "";
    $("#f-redirects").value = value.follow_redirects == null ? "" : String(value.follow_redirects);
    $("#f-ssl").value = value.verify_ssl == null ? "" : String(value.verify_ssl);
    $("#f-notify").checked = value.notify_on_error !== false;

    renderHeadersInto($("#headers-list"), value.headers || []);
    renderChannelChips(value);
    updateAuthGroups();
    updateChipsDisabled();
    updateMonitorHint();

    resetResponsePanel();

    $("#drawer-overlay").hidden = false;
    const drawer = $("#service-drawer");
    drawer.hidden = false;
    drawer.setAttribute("aria-hidden", "false");
    document.body.style.overflow = "hidden";
    const body = $(".drawer-body");
    if (body) body.scrollTop = 0;
    clearFormDirty();
    requestAnimationFrame(() => {
        const target = service ? $("#f-name") : $("#f-url");
        if (target) target.focus();
    });
}

async function closeDrawer(force = false) {
    const drawer = $("#service-drawer");
    if (!drawer || drawer.hidden) return;
    if (!force && state.formDirty) {
        const confirmed = await confirmAction({
            title: "Закрыть без сохранения?",
            text: "Изменения в форме будут потеряны.",
            okLabel: "Закрыть",
            danger: false,
            iconName: "info",
        });
        if (!confirmed) return;
    }
    drawer.hidden = true;
    drawer.setAttribute("aria-hidden", "true");
    const codeModal = $("#code-modal");
    if (codeModal) codeModal.hidden = true;
    $("#drawer-overlay").hidden = true;
    document.body.style.overflow = "";
    clearFormDirty();
    state.editingId = null;
}

function isValidExpectedStatus(spec) {
    const value = String(spec || "").trim();
    if (!value) return true;
    const tokens = value.toLowerCase().split(/[,;\s]+/).filter(Boolean);
    if (!tokens.length) return false;
    return tokens.every((token) => {
        if (/^\d{3}$/.test(token)) return Number(token) >= 100 && Number(token) <= 599;
        if (/^[1-5]xx$/.test(token)) return true;
        const match = token.match(/^(\d{3})-(\d{3})$/);
        if (!match) return false;
        const start = Number(match[1]);
        const end = Number(match[2]);
        return start >= 100 && start <= end && end <= 599;
    });
}

function buildServicePayload() {
    const url = ($("#f-url").value || "").trim();
    if (!url) {
        toast("Укажите URL сервиса", "error");
        $("#f-url").focus();
        return null;
    }
    if (!/^https?:\/\//i.test(url)) {
        toast("URL должен начинаться с http:// или https://", "error");
        $("#f-url").focus();
        return null;
    }
    const expected = ($("#f-expected").value || "").trim() || "200-299";
    if (!isValidExpectedStatus(expected)) {
        toast("Ожидаемые коды: например 200-299, 2xx или 200,201", "error", 6000);
        $("#f-expected").focus();
        return null;
    }
    const timeoutText = ($("#f-timeout").value || "").trim();
    const timeout = timeoutText ? Number.parseFloat(timeoutText) : null;
    if (timeout != null && (!Number.isFinite(timeout) || timeout < 0.5 || timeout > 120)) {
        toast("Таймаут должен быть от 0,5 до 120 секунд", "error");
        $("#f-timeout").focus();
        return null;
    }

    const activeChannels = selectedChannels();
    const notifyChannels = activeChannels.length === CHANNEL_IDS.length ? null : activeChannels;
    const authType = $("#f-auth-type").value;
    const payload = {
        name: ($("#f-name").value || "").trim(),
        method: $("#f-method").value || "GET",
        url,
        comment: ($("#f-comment").value || "").trim(),
        headers: collectHeaders($("#headers-list")),
        auth: {
            type: authType,
            username: authType === "basic" ? ($("#f-auth-user").value || "") : "",
            password: authType === "basic" ? ($("#f-auth-pass").value || "") : "",
            token: authType === "bearer" ? ($("#f-auth-token").value || "") : "",
        },
        body: $("#f-body").value || "",
        expected_status: expected,
        timeout_seconds: timeout,
        follow_redirects: $("#f-redirects").value === "" ? null : $("#f-redirects").value === "true",
        verify_ssl: $("#f-ssl").value === "" ? null : $("#f-ssl").value === "true",
        body_contains: ($("#f-body-contains").value || "").trim() || null,
        enabled: $("#f-enabled").checked,
        notify_on_error: $("#f-notify").checked,
        notify_channels: notifyChannels,
    };
    if (state.editingId) payload.id = state.editingId;
    return payload;
}

function showTestResult(result) {
    const summary = $("#test-summary");
    const box = $("#test-result");
    if (!summary || !box) return;
    const ok = result.success === true;
    const errorText = result.error ? String(result.error) : "";
    const parts = [
        `<span class="test-stat ${ok ? "ok" : "err"}">${icon(ok ? "check" : "alert")}${ok ? "Успешно" : "Ошибка"}</span>`,
        `<span class="test-stat ${ok ? "" : "err"}">HTTP ${result.status_code == null ? "—" : escapeHtml(result.status_code)}</span>`,
        `<span class="test-stat">${escapeHtml(formatDuration(result.duration_ms))}</span>`,
    ];
    if (result.response_size != null) {
        parts.push(`<span class="test-stat" title="Размер ответа">${icon("download")}${escapeHtml(formatSize(result.response_size, result.response_size_partial))}</span>`);
    }
    parts.push(`<span class="test-stat">${escapeHtml(result.method || "GET")}</span>`);
    summary.innerHTML = parts.join("");

    const error = $("#test-error");
    if (error) {
        error.hidden = !errorText;
        error.textContent = errorText;
    }

    const headers = result.response_headers && typeof result.response_headers === "object"
        ? Object.entries(result.response_headers).map(([key, value]) => `${key}: ${value}`).join("\n")
        : "";
    const headersBox = $("#test-headers");
    if (headersBox) headersBox.textContent = headers || "Заголовки не получены";

    state.testResponse = result;
    state.testBody = String(result.response_body || "");
    state.testHeaders = headers || "Заголовки не получены";
    state.testFormat = detectResponseFormat(result);

    renderResponseBody();
    setResponseTab("body");
    box.hidden = false;
    syncFormatSwitch();
}

function base64ToBytes(value) {
    const binary = atob(String(value || ""));
    const bytes = new Uint8Array(binary.length);
    for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
    return bytes;
}

function responseFilename(response, type) {
    const mime = String(type || "").split(";")[0].trim().toLowerCase();
    const subtype = mime.split("/")[1] || "";
    const extensions = {
        json: ".json",
        "ld+json": ".json",
        html: ".html",
        xml: ".xml",
        plain: ".txt",
        csv: ".csv",
        javascript: ".js",
        "x-javascript": ".js",
        pdf: ".pdf",
        png: ".png",
        jpeg: ".jpg",
        gif: ".gif",
        "svg+xml": ".svg",
        zip: ".zip",
        gzip: ".gz",
        "octet-stream": ".bin",
    };
    let extension = extensions[subtype] || (subtype ? `.${subtype.split("+")[0]}` : ".bin");
    let name = "";
    try {
        const parsed = new URL(String(response.url || ""));
        name = parsed.pathname.split("/").filter(Boolean).pop() || "";
    } catch (error) {
        name = "";
    }
    name = name.replace(/[^\w.\-]+/g, "_").slice(0, 64);
    if (!name) name = "response";
    if (!/\.[a-z0-9]{1,5}$/i.test(name)) name += extension;
    return name;
}

function downloadTestResponse() {
    const response = state.testResponse;
    if (!response) return;
    let bytes = null;
    if (response.response_body_base64) {
        try {
            bytes = base64ToBytes(response.response_body_base64);
        } catch (error) {
            bytes = null;
        }
    } else if (!response.response_binary) {
        bytes = new TextEncoder().encode(state.testBody || "");
    }
    if (!bytes) {
        toast("Тело ответа недоступно", "error");
        return;
    }
    const type = response.response_content_type || "application/octet-stream";
    const blob = new Blob([bytes], { type });
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    link.download = responseFilename(response, type);
    document.body.append(link);
    link.click();
    link.remove();
    window.setTimeout(() => URL.revokeObjectURL(url), 5000);
    if (response.body_truncated) toast("Скачана только часть ответа", "info");
    else toast("Ответ скачан", "success", 2600);
}

// ── Request code generation ──────────────────────────────────────────────
const CODE_LANGS = ["python", "javascript", "1c", "curl"];

function urlParts(url) {
    try {
        const parsed = new URL(url);
        return {
            scheme: parsed.protocol.replace(":", ""),
            host: parsed.hostname,
            port: parsed.port || (parsed.protocol === "https:" ? "443" : "80"),
            path: `${parsed.pathname || "/"}${parsed.search || ""}`,
        };
    } catch (error) {
        return { scheme: "http", host: String(url || ""), port: "80", path: "/" };
    }
}

function currentRequestDetails() {
    const authType = $("#f-auth-type") ? $("#f-auth-type").value : "none";
    const method = ($("#f-method") && $("#f-method").value) || "GET";
    const details = {
        method,
        url: (($("#f-url") && $("#f-url").value) || "").trim(),
        headers: collectHeaders($("#headers-list")).filter((header) => header.enabled !== false),
        body: ($("#f-body") && $("#f-body").value) || "",
        authType,
        username: authType === "basic" ? ($("#f-auth-user") && $("#f-auth-user").value) || "" : "",
        password: authType === "basic" ? ($("#f-auth-pass") && $("#f-auth-pass").value) || "" : "",
        token: authType === "bearer" ? ($("#f-auth-token") && $("#f-auth-token").value) || "" : "",
    };
    details.hasBody = Boolean(details.body) && method !== "GET" && method !== "HEAD";
    return details;
}

function pythonString(value) {
    return JSON.stringify(String(value == null ? "" : value));
}

function buildPythonCode(details) {
    const lines = ["import requests", "", `url = ${pythonString(details.url || "http://localhost/")}`];
    const headerLines = details.headers.map((header) => `    ${pythonString(header.key)}: ${pythonString(header.value)},`);
    if (details.token) headerLines.push(`    "Authorization": ${pythonString(`Bearer ${details.token}`)},`);
    if (headerLines.length) {
        lines.push("", "headers = {", ...headerLines, "}");
    }
    const args = ["    " + pythonString(details.method), "    url,"];
    if (headerLines.length) args.push("    headers=headers,");
    if (details.authType === "basic") {
        args.push(`    auth=(${pythonString(details.username)}, ${pythonString(details.password)}),`);
    }
    if (details.hasBody) args.push(`    data=${pythonString(details.body)}.encode("utf-8"),`);
    args.push("    timeout=30,");
    lines.push("", "response = requests.request(", ...args, ")", "");
    lines.push("print(response.status_code, response.reason)", "print(response.text)");
    return lines.join("\n");
}

function buildJavaScriptCode(details) {
    const lines = [`const url = ${JSON.stringify(details.url || "http://localhost/")};`, ""];
    const headerLines = details.headers.map((header) => `    ${JSON.stringify(header.key)}: ${JSON.stringify(header.value)},`);
    if (details.token) headerLines.push(`    "Authorization": "Bearer ${details.token}",`);
    lines.push("const options = {", `  method: ${JSON.stringify(details.method)},`);
    if (headerLines.length) lines.push("  headers: {", ...headerLines.map((line) => "  " + line), "  },");
    if (details.hasBody) {
        let bodyLine = JSON.stringify(details.body);
        try {
            const parsed = JSON.parse(details.body);
            bodyLine = `JSON.stringify(${JSON.stringify(parsed, null, 2).replace(/\n/g, "\n  ")}, null, 2)`;
        } catch (error) {
            /* keep the raw string */
        }
        lines.push(`  body: ${bodyLine},`);
    }
    lines.push("};", "");
    if (details.authType === "basic") {
        const credentials = `${details.username}:${details.password}`;
        lines.push(`options.headers = { ...options.headers, Authorization: "Basic " + btoa(${JSON.stringify(credentials)}) };`, "");
    }
    lines.push(
        "const response = await fetch(url, options);",
        "console.log(`HTTP ${response.status} ${response.statusText}`);",
        "console.log(await response.text());",
    );
    return lines.join("\n");
}

function build1CCode(details) {
    const parts = urlParts(details.url || "http://localhost/");
    const useSsl = parts.scheme === "https";
    const lines = [
        "// 1С:Предприятие 8.3",
        `Сервер  = ${JSON.stringify(parts.host)};`,
        `Порт    = ${Number(parts.port) || (useSsl ? 443 : 80)};`,
        `Ресурс  = ${JSON.stringify(parts.path)};`,
        "Таймаут = 30;",
        "",
        "Запрос = Новый HTTPЗапрос(Ресурс);",
    ];
    details.headers.forEach((header) => {
        lines.push(`Запрос.Заголовки.Вставить(${JSON.stringify(header.key)}, ${JSON.stringify(header.value)});`);
    });
    if (details.token) {
        lines.push(`Запрос.Заголовки.Вставить("Authorization", ${JSON.stringify(`Bearer ${details.token}`)});`);
    }
    if (details.hasBody) {
        lines.push(`Запрос.УстановитьТелоИзСтроки(${JSON.stringify(details.body)}, "UTF-8");`);
    }
    lines.push("");
    if (useSsl) {
        lines.push("Соединение = Новый HTTPСоединение(");
        lines.push("    Сервер, Порт,");
        if (details.authType === "basic") {
            lines.push(`    ${JSON.stringify(details.username)}, ${JSON.stringify(details.password)},`);
        } else {
            lines.push("    , ,");
        }
        lines.push("    , Таймаут,");
        lines.push("    Новый ЗащищенноеСоединениеOpenSSL());");
    } else {
        const authArgs = details.authType === "basic"
            ? `${JSON.stringify(details.username)}, ${JSON.stringify(details.password)}`
            : ", ";
        lines.push(`Соединение = Новый HTTPСоединение(Сервер, Порт, ${authArgs}, , Таймаут);`);
    }
    lines.push(
        "",
        `Ответ = Соединение.ВызватьHTTPМетод(${JSON.stringify(details.method)}, Запрос);`,
        "",
        'Сообщить("HTTP " + Ответ.КодСостояния);',
        'Сообщить(Ответ.ПолучитьТелоКакСтроку("UTF-8"));',
    );
    return lines.join("\n");
}

function shellQuote(value) {
    return `'${String(value == null ? "" : value).replace(/'/g, "'\\''")}'`;
}

function buildCurlCode(details) {
    const parts = [["curl"], ["  -X " + details.method], ["  " + shellQuote(details.url || "http://localhost/")]];
    details.headers.forEach((header) => {
        parts.push([`  -H ${shellQuote(`${header.key}: ${header.value}`)}`]);
    });
    if (details.token) parts.push([`  -H ${shellQuote(`Authorization: Bearer ${details.token}`)}`]);
    if (details.authType === "basic") parts.push([`  -u ${shellQuote(`${details.username}:${details.password}`)}`]);
    if (details.hasBody) parts.push([`  --data-raw ${shellQuote(details.body)}`]);
    return parts.map((line) => line[0]).join(" \\\n");
}

function generateRequestCode(lang) {
    const details = currentRequestDetails();
    switch (lang) {
        case "javascript":
            return buildJavaScriptCode(details);
        case "1c":
            return build1CCode(details);
        case "curl":
            return buildCurlCode(details);
        default:
            return buildPythonCode(details);
    }
}

function renderCodeModal() {
    const lang = CODE_LANGS.includes(state.codeLang) ? state.codeLang : "python";
    state.codeLang = lang;
    const details = currentRequestDetails();
    const sub = $("#code-sub");
    if (sub) sub.textContent = `${details.method} ${details.url || "укажите URL"}`;
    $$(".code-tab").forEach((button) => {
        const active = button.dataset.codeLang === lang;
        button.classList.toggle("active", active);
        button.setAttribute("aria-selected", active ? "true" : "false");
    });
    const output = $("#code-output");
    if (output) {
        output.textContent = generateRequestCode(lang);
        output.scrollTop = 0;
    }
}

function openCodeModal() {
    const modal = $("#code-modal");
    if (!modal) return;
    state.codeLang = CODE_LANGS.includes(state.codeLang) ? state.codeLang : "python";
    renderCodeModal();
    modal.hidden = false;
    const active = $(".code-tab.active");
    if (active) active.focus();
}

function closeCodeModal() {
    const modal = $("#code-modal");
    if (!modal || modal.hidden) return;
    modal.hidden = true;
    $("#generate-code")?.focus();
}

async function testServiceFromForm(button) {
    const payload = buildServicePayload();
    if (!payload) return;
    const previousText = button ? button.innerHTML : "";
    if (button) {
        button.setAttribute("aria-busy", "true");
        const label = button.querySelector("span");
        if (label) label.textContent = "Отправка…";
    }
    setButtonLoading(button, true);
    try {
        const result = await api("/api/services/test", { method: "POST", body: payload });
        showTestResult(result);
    } catch (error) {
        toast(error.message, "error");
    } finally {
        setButtonLoading(button, false);
        if (button) {
            button.innerHTML = previousText;
            button.removeAttribute("aria-busy");
        }
    }
}

async function saveService(event) {
    event.preventDefault();
    const payload = buildServicePayload();
    if (!payload) return;
    const button = $("#save-service");
    setButtonLoading(button, true);
    const isEdit = Boolean(state.editingId);
    try {
        await api(isEdit ? `/api/services/${encodeURIComponent(state.editingId)}` : "/api/services", {
            method: isEdit ? "PUT" : "POST",
            body: payload,
        });
        state.formDirty = false;
        toast(isEdit ? "Сервис обновлён" : "Сервис добавлен", "success");
        await closeDrawer(true);
        await refreshState({ silent: true });
    } catch (error) {
        toast(error.message, "error");
    } finally {
        setButtonLoading(button, false);
    }
}

async function deleteService(serviceId) {
    const service = state.services.find((item) => item.id === serviceId);
    if (!service) return;
    const confirmed = await confirmAction({
        title: "Удалить сервис?",
        text: `«${displayName(service)}» и история его состояния будут удалены.`,
        okLabel: "Удалить",
    });
    if (!confirmed) return;
    try {
        await api(`/api/services/${encodeURIComponent(serviceId)}`, { method: "DELETE" });
        if (state.editingId === serviceId) await closeDrawer(true);
        toast("Сервис удалён", "success");
        await refreshState({ silent: true });
    } catch (error) {
        toast(error.message, "error");
    }
}

async function toggleService(serviceId, enabled) {
    const service = state.services.find((item) => item.id === serviceId);
    if (!service) return;
    try {
        await api(`/api/services/${encodeURIComponent(serviceId)}`, {
            method: "PUT",
            body: { ...service, enabled },
        });
        toast(enabled ? "Мониторинг включён" : "Мониторинг отключён", "success", 2600);
        await refreshState({ silent: true });
    } catch (error) {
        toast(error.message, "error");
        renderServices();
    }
}

async function quickTest(serviceId, button) {
    const service = state.services.find((item) => item.id === serviceId);
    if (!service) return;
    setButtonLoading(button, true);
    try {
        const result = await api(`/api/services/${encodeURIComponent(serviceId)}/test`, { method: "POST" });
        if (result.success === true) {
            toast(`HTTP ${result.status_code} · ${formatDuration(result.duration_ms)}`, "success");
        } else {
            toast(result.error || `HTTP ${result.status_code || "—"}`, "error", 6000);
        }
    } catch (error) {
        toast(error.message, "error");
    } finally {
        setButtonLoading(button, false);
    }
}

// ── Notifications ───────────────────────────────────────────────────────
function fillNotificationsForm(notifications) {
    const value = notifications || {};
    const telegram = value.telegram || {};
    const max = value.max || {};
    const email = value.email || {};
    const webhook = value.webhook || {};

    $("#notify-enabled").checked = value.enabled !== false;
    $("#notify-recovery").checked = value.notify_on_recovery !== false;
    $("#notify-repeat").value = Number(value.repeat_interval_minutes) || 0;

    $("#tg-enabled").checked = Boolean(telegram.enabled);
    $("#tg-token").value = telegram.bot_token || "";
    $("#tg-chat").value = telegram.chat_id || "";
    $("#tg-silent").checked = Boolean(telegram.silent);

    $("#max-enabled").checked = Boolean(max.enabled);
    $("#max-token").value = max.token || "";
    $("#max-chat").value = max.chat_id || "";
    $("#max-user").value = max.user_id || "";

    $("#email-enabled").checked = Boolean(email.enabled);
    $("#email-host").value = email.smtp_host || "";
    $("#email-port").value = email.smtp_port || 465;
    $("#email-security").value = email.security || "ssl";
    $("#email-user").value = email.username || "";
    $("#email-password").value = email.password || "";
    $("#email-from").value = email.from_addr || "";
    $("#email-to").value = Array.isArray(email.to_addrs) ? email.to_addrs.join(", ") : (email.to_addrs || "");
    $("#email-subject").value = email.subject_prefix || "";

    $("#hook-enabled").checked = Boolean(webhook.enabled);
    $("#hook-url").value = webhook.url || "";
    $("#hook-method").value = webhook.method || "POST";
    renderHeadersInto($("#hook-headers"), webhook.headers || []);
    $("#hook-template").value = webhook.payload_template || "";
    $("#hook-timeout").value = webhook.timeout_seconds || 10;
    $("#hook-ssl").checked = webhook.verify_ssl !== false;

    renderNotificationsSummary();
    $$(".test-status").forEach((element) => {
        element.textContent = "";
        element.className = "test-status";
    });
}

function buildNotificationsFromForm() {
    const base = state.settings && state.settings.notifications
        ? deepClone(state.settings.notifications)
        : { telegram: {}, max: {}, email: {}, webhook: {} };
    const repeat = clampInt($("#notify-repeat").value, 0, 0, 1440);
    return {
        ...base,
        enabled: $("#notify-enabled").checked,
        notify_on_recovery: $("#notify-recovery").checked,
        repeat_interval_minutes: repeat,
        telegram: {
            ...(base.telegram || {}),
            enabled: $("#tg-enabled").checked,
            bot_token: ($("#tg-token").value || "").trim(),
            chat_id: ($("#tg-chat").value || "").trim(),
            silent: $("#tg-silent").checked,
        },
        max: {
            ...(base.max || {}),
            enabled: $("#max-enabled").checked,
            token: ($("#max-token").value || "").trim(),
            chat_id: ($("#max-chat").value || "").trim(),
            user_id: ($("#max-user").value || "").trim(),
        },
        email: {
            ...(base.email || {}),
            enabled: $("#email-enabled").checked,
            smtp_host: ($("#email-host").value || "").trim(),
            smtp_port: clampInt($("#email-port").value, 465, 1, 65535),
            security: $("#email-security").value || "ssl",
            username: ($("#email-user").value || "").trim(),
            password: $("#email-password").value || "",
            from_addr: ($("#email-from").value || "").trim(),
            to_addrs: ($("#email-to").value || "").split(/[,;\s]+/).map((item) => item.trim()).filter(Boolean),
            subject_prefix: $("#email-subject").value || "",
        },
        webhook: {
            ...(base.webhook || {}),
            enabled: $("#hook-enabled").checked,
            url: ($("#hook-url").value || "").trim(),
            method: $("#hook-method").value || "POST",
            headers: collectHeaders($("#hook-headers")),
            payload_template: $("#hook-template").value || "",
            timeout_seconds: clampNumber($("#hook-timeout").value, 10, 1, 60),
            verify_ssl: $("#hook-ssl").checked,
        },
    };
}

function buildChannelConfig(channel) {
    const notifications = buildNotificationsFromForm();
    return notifications[channel] || {};
}

function renderNotificationsSummary() {
    const pill = $("#notify-summary");
    if (!pill) return;
    const master = $("#notify-enabled").checked;
    const enabledSelectors = {
        telegram: "#tg-enabled",
        max: "#max-enabled",
        email: "#email-enabled",
        webhook: "#hook-enabled",
    };
    const enabledChannels = CHANNEL_IDS.filter((channel) => $(enabledSelectors[channel])?.checked);
    if (!master) {
        pill.className = "pill err";
        pill.textContent = "Выключены";
        pill.title = "Общие уведомления выключены";
        return;
    }
    if (!enabledChannels.length) {
        pill.className = "pill";
        pill.textContent = "Нет каналов";
        pill.title = "Ни один канал не включён";
        return;
    }
    pill.className = "pill ok";
    pill.textContent = `${enabledChannels.length} из ${CHANNEL_IDS.length}`;
    pill.title = enabledChannels.map((channel) => CHANNEL_NAMES[channel]).join(", ");
}

async function saveNotifications() {
    if (!state.settings) {
        toast("Настройки ещё загружаются", "info");
        return;
    }
    const button = $("#save-notifications");
    setButtonLoading(button, true);
    try {
        const settings = deepClone(state.settings);
        settings.notifications = buildNotificationsFromForm();
        const response = await api("/api/settings", { method: "PUT", body: settings });
        state.settings = response.settings || settings;
        fillNotificationsForm(state.settings.notifications);
        toast("Уведомления сохранены", "success");
        if (response.autostart_error) toast(response.autostart_error, "error", 7000);
        await refreshState({ silent: true });
    } catch (error) {
        toast(error.message, "error");
    } finally {
        setButtonLoading(button, false);
    }
}

const TEST_STATUS_IDS = {
    telegram: "tg-test",
    max: "max-test",
    email: "email-test",
    webhook: "hook-test",
};

async function testChannel(button) {
    const channel = button.dataset.test;
    if (!channel) return;
    const statusElement = $(`#${TEST_STATUS_IDS[channel]}`);
    if (statusElement) {
        statusElement.className = "test-status";
        statusElement.textContent = "Отправка…";
    }
    setButtonLoading(button, true);
    try {
        const result = await api("/api/settings/test-notification", {
            method: "POST",
            body: { channel, config: buildChannelConfig(channel) },
        });
        if (statusElement) {
            statusElement.textContent = result.message || (result.success ? "Отправлено" : "Ошибка");
            statusElement.className = `test-status ${result.success ? "ok" : "err"}`;
        }
        loadLog({ silent: true });
    } catch (error) {
        if (statusElement) {
            statusElement.textContent = error.message;
            statusElement.className = "test-status err";
        }
        toast(error.message, "error", 7000);
    } finally {
        setButtonLoading(button, false);
    }
}

function eventLabel(event) {
    if (event === "failure") return "ошибка";
    if (event === "recovery") return "восстановление";
    if (event === "test") return "тест";
    return event || "";
}

async function loadLog(options = {}) {
    const { silent = false } = options;
    try {
        const entries = await api("/api/notifications/log?limit=50");
        state.log = Array.isArray(entries) ? entries : [];
        renderLog();
    } catch (error) {
        if (!silent) toast(error.message, "error");
    }
}

function renderLog() {
    const container = $("#notif-log");
    if (!container) return;
    if (!state.log.length) {
        container.innerHTML = `
            <div class="all-ok">
                ${icon("bell")}
                <div><strong>Отправок пока не было</strong>Проверьте канал, чтобы убедиться, что сообщения доставляются.</div>
            </div>`;
        return;
    }
    container.innerHTML = state.log.map((entry) => {
        const success = entry.success === true;
        const label = entry.channel_label || CHANNEL_NAMES[entry.channel] || entry.channel || "—";
        const service = entry.service_name || entry.url || "—";
        return `
            <div class="log-row">
                <span class="log-time" title="${escapeHtml(formatFull(entry.time))}">${escapeHtml(formatDateTime(entry.time))}</span>
                <span class="log-channel">${escapeHtml(label)}</span>
                <span class="log-service" title="${escapeHtml(entry.url || service)}">${escapeHtml(service)} <span class="muted">· ${escapeHtml(eventLabel(entry.event))}</span></span>
                <span class="log-result ${success ? "ok" : "err"}">${success ? "отправлено" : "ошибка"}</span>
                ${entry.error ? `<span class="log-error" title="${escapeHtml(entry.error)}">${escapeHtml(entry.error)}</span>` : ""}
            </div>`;
    }).join("");
}

// ── Settings ────────────────────────────────────────────────────────────
function updateIntervalHint() {
    const hint = $("#interval-hint");
    if (!hint) return;
    const value = clampInt($("#set-interval").value, 600, 10, 86400);
    hint.textContent = `Каждые ${formatIntervalShort(value)}`;
}

function fillSettingsForm(settings) {
    if (!settings) return;
    const app = settings.app || {};
    const monitoring = settings.monitoring || {};

    $("#set-interval").value = monitoring.interval_seconds ?? 600;
    $("#set-timeout").value = monitoring.timeout_seconds ?? 15;
    $("#set-concurrency").value = monitoring.concurrency ?? 8;
    $("#set-history").value = monitoring.history_limit ?? 100;
    $("#set-auto").checked = monitoring.auto_check_enabled !== false;
    $("#set-ssl").checked = Boolean(monitoring.verify_ssl);
    $("#set-redirects").checked = monitoring.follow_redirects !== false;

    const hostSelect = $("#set-host");
    if (app.host && !Array.from(hostSelect.options).some((option) => option.value === app.host)) {
        const option = document.createElement("option");
        option.value = app.host;
        option.textContent = `Другой адрес (${app.host})`;
        hostSelect.append(option);
    }
    hostSelect.value = app.host || "0.0.0.0";
    $("#set-port").value = app.port ?? 8062;
    $("#set-open-browser").checked = app.open_browser_on_start !== false;
    $("#set-start-minimized").checked = Boolean(app.start_minimized);
    $("#set-autostart").checked = Boolean(app.start_with_windows);
    $("#set-tray-notify").checked = app.tray_notifications !== false;

    updateIntervalHint();
    state.settingsDirty = false;
    renderLanList();
    renderSystemInfo();
}

function collectSettings() {
    const base = deepClone(state.settings);
    const app = base.app || {};
    const monitoring = base.monitoring || {};
    base.app = {
        ...app,
        host: $("#set-host").value || "0.0.0.0",
        port: clampInt($("#set-port").value, app.port || 8062, 1, 65535),
        open_browser_on_start: $("#set-open-browser").checked,
        start_minimized: $("#set-start-minimized").checked,
        start_with_windows: $("#set-autostart").checked,
        tray_notifications: $("#set-tray-notify").checked,
    };
    base.monitoring = {
        ...monitoring,
        interval_seconds: clampInt($("#set-interval").value, monitoring.interval_seconds || 600, 10, 86400),
        timeout_seconds: clampNumber($("#set-timeout").value, monitoring.timeout_seconds || 15, 1, 120),
        concurrency: clampInt($("#set-concurrency").value, monitoring.concurrency || 8, 1, 32),
        history_limit: clampInt($("#set-history").value, monitoring.history_limit || 100, 10, 1000),
        auto_check_enabled: $("#set-auto").checked,
        verify_ssl: $("#set-ssl").checked,
        follow_redirects: $("#set-redirects").checked,
    };
    return base;
}

async function saveSettings() {
    if (!state.settings) {
        toast("Настройки ещё загружаются", "info");
        return;
    }
    const button = $("#save-settings");
    setButtonLoading(button, true);
    try {
        const response = await api("/api/settings", { method: "PUT", body: collectSettings() });
        state.settings = response.settings || state.settings;
        fillSettingsForm(state.settings);
        toast("Настройки сохранены", "success");
        if (response.restart_required) {
            toast("Адрес или порт изменятся после перезапуска приложения", "info", 8000);
        }
        if (response.autostart_error) toast(response.autostart_error, "error", 8000);
        await refreshState({ silent: true });
    } catch (error) {
        toast(error.message, "error", 7000);
    } finally {
        setButtonLoading(button, false);
    }
}

function renderLanList() {
    const container = $("#lan-list");
    if (!container) return;
    const system = state.system || {};
    const urls = [];
    if (system.local_url) urls.push(system.local_url);
    (Array.isArray(system.lan_urls) ? system.lan_urls : []).forEach((url) => {
        if (!urls.includes(url)) urls.push(url);
    });

    const info = state.settings && state.settings.app ? state.settings.app : {};
    const localOnly = info.host === "127.0.0.1";
    const rows = urls.map((url) => `
        <div class="lan-row">
            <code title="${escapeHtml(url)}">${escapeHtml(url)}</code>
            <button class="icon-btn small" data-copy-url="${escapeHtml(url)}" title="Скопировать адрес">${icon("copy")}</button>
        </div>`).join("");

    container.innerHTML = `
        ${localOnly ? `<p class="hint">Панель принимает подключения только с этого компьютера. Выберите «Все интерфейсы», чтобы открывать её из локальной сети.</p>` : ""}
        ${rows || `<p class="hint">Адреса не найдены. Проверьте сетевые подключения компьютера.</p>`}`;
}

function renderSystemInfo() {
    const system = state.system || {};
    const version = (state.status && state.status.version) || "3.2.0";
    setText("#about-version", `v${version}`);
    setText("#about-data", system.data_dir || "—");
    setText("#about-history", system.history_file || "—");
    setText("#about-log", system.log_file || "—");
    setText("#app-version", `v${version}`);
}

async function exportBackup() {
    const button = $("#export-backup");
    setButtonLoading(button, true);
    try {
        const response = await fetch("/api/backup");
        if (!response.ok) throw new Error("Не удалось сформировать резервную копию");
        const blob = await response.blob();
        const disposition = response.headers.get("Content-Disposition") || "";
        const match = disposition.match(/filename="?([^";]+)"?/i);
        const filename = match ? match[1] : "service-monitor-backup.json";
        const url = URL.createObjectURL(blob);
        const link = document.createElement("a");
        link.href = url;
        link.download = filename;
        document.body.append(link);
        link.click();
        link.remove();
        window.setTimeout(() => URL.revokeObjectURL(url), 1000);
        toast("Резервная копия сохранена", "success");
    } catch (error) {
        toast(error.message, "error");
    } finally {
        setButtonLoading(button, false);
    }
}

async function importBackupFile(file) {
    if (!file) return;
    let payload;
    try {
        payload = JSON.parse(await file.text());
        if (!payload || typeof payload !== "object" || !Array.isArray(payload.services)) {
            throw new Error("В файле нет списка сервисов");
        }
    } catch (error) {
        toast(`Некорректный файл копии: ${error.message}`, "error", 7000);
        return;
    }

    const confirmed = await confirmAction({
        title: "Восстановить из копии?",
        text: `Текущие сервисы и настройки будут заменены данными из файла. В копии ${payload.services.length} ${plural(payload.services.length, "сервис", "сервиса", "сервисов")}.`,
        okLabel: "Восстановить",
        danger: true,
        iconName: "upload",
    });
    if (!confirmed) return;

    try {
        await api("/api/restore", {
            method: "POST",
            body: {
                version: payload.version || "",
                exported_at: payload.exported_at || "",
                services: payload.services,
                settings: payload.settings || null,
            },
        });
        toast("Резервная копия восстановлена", "success");
        const settings = await api("/api/settings");
        state.settings = settings;
        fillNotificationsForm(settings.notifications);
        fillSettingsForm(settings);
        await refreshState({ silent: true });
        await loadLog({ silent: true });
    } catch (error) {
        toast(error.message, "error", 7000);
    }
}

async function openDataDirectory() {
    try {
        const result = await api("/api/open-data-dir");
        if (result.success) {
            toast("Папка данных открыта", "success");
        } else {
            toast(`Папка данных: ${result.path}`, "info", 7000);
        }
    } catch (error) {
        toast(error.message, "error");
    }
}

// ── Events ──────────────────────────────────────────────────────────────
function bindEvents() {
    $$(".nav-item").forEach((button) => {
        button.addEventListener("click", () => setPage(button.dataset.page));
    });
    window.addEventListener("hashchange", () => {
        const page = (location.hash || "").replace("#", "");
        if (PAGE_META[page]) setPage(page);
    });

    $("#menu-toggle").addEventListener("click", () => {
        $("#app").classList.toggle("nav-open");
    });
    $("#content").addEventListener("click", () => {
        $("#app").classList.remove("nav-open");
    });

    $("#theme-toggle").addEventListener("click", () => {
        applyTheme(state.theme === "dark" ? "light" : "dark", true);
    });

    $("#check-now").addEventListener("click", startCheck);

    $("#auto-check").addEventListener("change", async (event) => {
        const checkbox = event.currentTarget;
        const enabled = checkbox.checked;
        checkbox.disabled = true;
        try {
            const result = await api("/api/monitoring", { method: "POST", body: { enabled } });
            if (result.status) state.status = { ...state.status, ...result.status };
            if (state.settings && state.settings.monitoring) {
                state.settings.monitoring.auto_check_enabled = enabled;
            }
            const settingsToggle = $("#set-auto");
            if (settingsToggle) settingsToggle.checked = enabled;
            updateStatus();
            toast(enabled ? "Автопроверка включена" : "Автопроверка выключена", "success", 2600);
        } catch (error) {
            checkbox.checked = !enabled;
            toast(error.message, "error");
        } finally {
            checkbox.disabled = false;
        }
    });

    $("#refresh-state").addEventListener("click", async (event) => {
        const button = event.currentTarget;
        setButtonLoading(button, true);
        await refreshState();
        setButtonLoading(button, false);
    });

    $("#history-more").addEventListener("click", () => {
        state.historyVisible += 5;
        renderHistory();
    });
    $("#open-history").addEventListener("click", () => setPage("history"));

    $("#history-refresh").addEventListener("click", async (event) => {
        const button = event.currentTarget;
        setButtonLoading(button, true);
        await loadFullHistory();
        setButtonLoading(button, false);
    });
    $("#history-export").addEventListener("click", exportHistoryCsv);
    $("#history-load-more").addEventListener("click", () => {
        state.history.visible += 200;
        renderHistoryPage();
    });
    $("#history-search").addEventListener("input", (event) => {
        state.history.query = event.currentTarget.value;
        state.history.visible = 200;
        renderHistoryPage();
    });
    const historyFilterKeys = {
        "#history-status": "status",
        "#history-trigger": "trigger",
        "#history-period": "period",
    };
    Object.entries(historyFilterKeys).forEach(([selector, key]) => {
        $(selector).addEventListener("change", (event) => {
            state.history[key] = event.currentTarget.value;
            state.history.visible = 200;
            renderHistoryPage();
        });
    });
    $("#history-empty").addEventListener("click", (event) => {
        if (event.target.closest("[data-history-reset]")) resetHistoryFilters();
    });

    $("#add-service").addEventListener("click", () => openDrawer());
    $("#service-search").addEventListener("input", renderServices);
    $("#service-filter").addEventListener("change", renderServices);

    $("#services-body").addEventListener("click", (event) => {
        const actionElement = event.target.closest("[data-action]");
        if (!actionElement) return;
        const action = actionElement.dataset.action;
        const serviceId = actionElement.dataset.id;
        if (!serviceId || action === "toggle") return;
        if (action === "edit") openDrawer(serviceId);
        else if (action === "delete") deleteService(serviceId);
        else if (action === "test") quickTest(serviceId, actionElement);
    });

    $("#services-body").addEventListener("change", (event) => {
        const target = event.target;
        if (!target.matches('[data-action="toggle"]')) return;
        toggleService(target.dataset.id, target.checked);
    });

    $("#services-empty").addEventListener("click", (event) => {
        const actionElement = event.target.closest("[data-action]");
        if (!actionElement) return;
        if (actionElement.dataset.action === "add") {
            openDrawer();
        } else if (actionElement.dataset.action === "reset-filters") {
            $("#service-search").value = "";
            $("#service-filter").value = "all";
            renderServices();
        }
    });

    $("#problems-list").addEventListener("click", (event) => {
        const actionElement = event.target.closest("[data-action]");
        if (!actionElement) return;
        const serviceId = actionElement.dataset.id;
        if (actionElement.dataset.action === "edit") openDrawer(serviceId);
        else if (actionElement.dataset.action === "test") quickTest(serviceId, actionElement);
    });

    $("#add-header").addEventListener("click", () => {
        addHeaderRow($("#headers-list"));
        markFormDirty();
    });
    $("#headers-list").addEventListener("click", (event) => {
        const button = event.target.closest("[data-remove-header]");
        if (!button) return;
        const container = $("#headers-list");
        button.closest(".kv-row").remove();
        if (!container.querySelector(".kv-row")) renderHeadersInto(container, []);
        markFormDirty();
    });
    $("#hook-add-header").addEventListener("click", () => {
        addHeaderRow($("#hook-headers"));
    });
    $("#hook-headers").addEventListener("click", (event) => {
        const button = event.target.closest("[data-remove-header]");
        if (!button) return;
        const container = $("#hook-headers");
        button.closest(".kv-row").remove();
        if (!container.querySelector(".kv-row")) renderHeadersInto(container, []);
    });

    $("#f-auth-type").addEventListener("change", () => {
        updateAuthGroups();
        markFormDirty();
    });
    $("#f-notify").addEventListener("change", () => {
        updateChipsDisabled();
        updateChannelsHint();
        markFormDirty();
    });
    $("#notify-channels").addEventListener("click", (event) => {
        const chip = event.target.closest(".chip");
        if (!chip || chip.disabled) return;
        chip.classList.toggle("active");
        chip.setAttribute("aria-pressed", chip.classList.contains("active") ? "true" : "false");
        updateChannelsHint();
        markFormDirty();
    });

    $("#service-form").addEventListener("input", markFormDirty);
    $("#service-form").addEventListener("change", markFormDirty);
    $("#service-form").addEventListener("submit", saveService);

    $("#close-drawer").addEventListener("click", () => closeDrawer());
    $("#cancel-service").addEventListener("click", () => closeDrawer());
    $("#drawer-overlay").addEventListener("click", () => closeDrawer());
    $("#test-top").addEventListener("click", (event) => testServiceFromForm(event.currentTarget));
    $("#test-close").addEventListener("click", () => {
        $("#test-result").hidden = true;
    });
    $$(".response-tab").forEach((button) => {
        button.addEventListener("click", () => setResponseTab(button.dataset.responseTab || "body"));
    });
    $$("#format-switch .format-btn").forEach((button) => {
        button.addEventListener("click", () => setResponseFormat(button.dataset.format || "text"));
    });
    $("#test-download").addEventListener("click", downloadTestResponse);
    $("#test-copy").addEventListener("click", async (event) => {
        const text = state.testTab === "headers" ? state.testHeaders : responseBodyText();
        if (!text) return;
        await copyText(text, "Ответ скопирован");
        const button = event.currentTarget;
        button.classList.add("copied");
        window.setTimeout(() => button.classList.remove("copied"), 1200);
    });
    $("#generate-code").addEventListener("click", openCodeModal);
    $$(".code-tab").forEach((button) => {
        button.addEventListener("click", () => {
            state.codeLang = button.dataset.codeLang || "python";
            renderCodeModal();
        });
    });
    $("#code-copy").addEventListener("click", async (event) => {
        const output = $("#code-output");
        if (!output || !output.textContent) return;
        await copyText(output.textContent, "Код скопирован");
        const button = event.currentTarget;
        button.classList.add("copied");
        window.setTimeout(() => button.classList.remove("copied"), 1200);
    });
    $("#code-done").addEventListener("click", closeCodeModal);
    $("#code-close").addEventListener("click", closeCodeModal);
    $("#code-modal").addEventListener("click", (event) => {
        if (event.target === event.currentTarget) closeCodeModal();
    });
    $("#f-enabled").addEventListener("change", () => {
        updateMonitorHint();
        markFormDirty();
    });

    $("#save-notifications").addEventListener("click", saveNotifications);
    $$("[data-test]").forEach((button) => {
        button.addEventListener("click", () => testChannel(button));
    });
    $("#notify-enabled").addEventListener("change", renderNotificationsSummary);
    ["#tg-enabled", "#max-enabled", "#email-enabled", "#hook-enabled"].forEach((selector) => {
        $(selector).addEventListener("change", renderNotificationsSummary);
    });
    $("#refresh-log").addEventListener("click", async (event) => {
        const button = event.currentTarget;
        setButtonLoading(button, true);
        await loadLog();
        setButtonLoading(button, false);
    });

    $("#save-settings").addEventListener("click", saveSettings);
    const settingsGrid = $(".settings-grid");
    if (settingsGrid) {
        settingsGrid.addEventListener("input", () => { state.settingsDirty = true; });
        settingsGrid.addEventListener("change", () => { state.settingsDirty = true; });
    }
    $("#set-interval").addEventListener("input", updateIntervalHint);
    $("#export-backup").addEventListener("click", exportBackup);
    $("#import-backup").addEventListener("click", () => $("#backup-file").click());
    $("#backup-file").addEventListener("change", async (event) => {
        const file = event.currentTarget.files && event.currentTarget.files[0];
        event.currentTarget.value = "";
        await importBackupFile(file);
    });
    $("#open-data-dir").addEventListener("click", openDataDirectory);

    $("#server-link").addEventListener("click", () => {
        copyText(workspaceUrl() || "—", "Адрес скопирован");
    });
    $("#lan-list").addEventListener("click", (event) => {
        const button = event.target.closest("[data-copy-url]");
        if (button) copyText(button.dataset.copyUrl);
    });
    $("#page-settings").addEventListener("click", (event) => {
        const button = event.target.closest("[data-copy-path]");
        if (!button) return;
        const target = document.getElementById(button.dataset.copyPath);
        if (target) copyText(target.textContent.trim(), "Путь скопирован");
    });

    $("#confirm-cancel").addEventListener("click", () => resolveConfirm(false));
    $("#confirm-ok").addEventListener("click", () => resolveConfirm(true));
    $("#confirm-modal").addEventListener("click", (event) => {
        if (event.target === event.currentTarget) resolveConfirm(false);
    });

    document.addEventListener("keydown", (event) => {
        const drawer = $("#service-drawer");
        const drawerOpen = drawer && !drawer.hidden;
        const modal = $("#confirm-modal");
        const modalOpen = modal && !modal.hidden;
        const codeModal = $("#code-modal");
        const codeOpen = codeModal && !codeModal.hidden;
        if (drawerOpen && !modalOpen && !codeOpen && (event.ctrlKey || event.metaKey)) {
            if (event.key === "Enter") {
                event.preventDefault();
                testServiceFromForm($("#test-top"));
                return;
            }
            if (event.key.toLowerCase() === "s") {
                event.preventDefault();
                $("#service-form").requestSubmit();
                return;
            }
        }
        if (event.key !== "Escape") return;
        if (codeOpen) {
            closeCodeModal();
            return;
        }
        if (modalOpen) {
            resolveConfirm(false);
            return;
        }
        if (drawerOpen) {
            closeDrawer();
            return;
        }
        $("#app").classList.remove("nav-open");
    });

    window.addEventListener("beforeunload", (event) => {
        if (!state.formDirty) return;
        event.preventDefault();
        event.returnValue = "";
    });
    window.addEventListener("online", () => {
        setConnection("connecting");
        refreshState({ silent: true });
    });
    window.addEventListener("offline", () => setConnection("offline"));
    document.addEventListener("visibilitychange", () => {
        if (!document.hidden && state.settings) refreshState({ silent: true });
    });
}

// ── Boot ────────────────────────────────────────────────────────────────
async function loadInitial() {
    try {
        const [data, settings] = await Promise.all([api("/api/state"), api("/api/settings")]);
        state.settings = settings;
        state.bootFailed = false;
        applyStateData(data);
        fillNotificationsForm(settings.notifications);
        fillSettingsForm(settings);
        setConnection("online");
        connectEvents();
        loadLog({ silent: true });
    } catch (error) {
        setConnection("offline");
        if (!state.bootFailed) {
            state.bootFailed = true;
            toast(`Не удалось загрузить данные: ${error.message}`, "error", 6000);
        }
        connectEvents();
        window.setTimeout(() => {
            if (state.connection !== "online") loadInitial();
        }, 5000);
    }
}

function boot() {
    initTheme();
    bindEvents();
    const page = (location.hash || "").replace("#", "");
    setPage(PAGE_META[page] ? page : "overview");
    setConnection("connecting");
    updateCountdown();
    window.setInterval(updateCountdown, 1000);
    window.setInterval(refreshRelativeTimes, 30_000);
    loadInitial();
}

boot();
