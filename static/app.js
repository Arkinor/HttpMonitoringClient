// ============================================
// Password Manager - JavaScript
// ============================================

// Глобальные переменные для хранения данных
let passwords = [];
let encryptKey = '';

// ============================================
// Блокировка логирования ключа в консоль
// ============================================

(function protectConsole() {
    const originalLog = console.log;
    const originalWarn = console.warn;
    const originalError = console.error;
    const originalInfo = console.info;

    function maskKey(msg) {
        if (typeof msg !== 'string') return msg;
        if (!encryptKey) return msg;
        return msg.split(encryptKey).join('********');
    }

    console.log = function () {
        const args = Array.from(arguments).map(a => typeof a === 'string' ? maskKey(a) : a);
        originalLog.apply(console, args);
    };
    console.warn = function () {
        const args = Array.from(arguments).map(a => typeof a === 'string' ? maskKey(a) : a);
        originalWarn.apply(console, args);
    };
    console.error = function () {
        const args = Array.from(arguments).map(a => typeof a === 'string' ? maskKey(a) : a);
        originalError.apply(console, args);
    };
    console.info = function () {
        const args = Array.from(arguments).map(a => typeof a === 'string' ? maskKey(a) : a);
        originalInfo.apply(console, args);
    };
})();

// ============================================
// Управление ключом шифрования
// ============================================

const KEY_TIMEOUT_MS = 5 * 60 * 1000; // 5 минут
let keyTimeoutId = null;
let keyTimerIntervalId = null;
let lastActivityTime = Date.now();

// Получить текущий ключ (без логирования)
function getEncryptKey() {
    return encryptKey;
}

// Установить ключ и обновить статус
function setEncryptKey(key) {
    encryptKey = key || '';
    if (key) {
        resetKeyTimeout();
        updateKeyStatus(true);
    } else {
        clearKeyTimeout();
        updateKeyStatus(false);
    }
}

// Обновить визуальный статус ключа
function updateKeyStatus(active) {
    const el = document.getElementById('keyStatus');
    if (!el) return;
    if (active) {
        el.className = 'key-status active';
        updateKeyTimerDisplay();
    } else {
        el.className = 'key-status inactive';
        el.textContent = 'Ключ не установлен';
    }
}

// Обновить отображение таймера на статусе
function updateKeyTimerDisplay() {
    const el = document.getElementById('keyStatus');
    if (!el || !encryptKey) return;
    const remaining = Math.max(0, KEY_TIMEOUT_MS - (Date.now() - lastActivityTime));
    const mins = Math.floor(remaining / 60000);
    const secs = Math.floor((remaining % 60000) / 1000);
    el.textContent = `Ключ установлен (${mins}:${secs.toString().padStart(2, '0')})`;
}

// Сбросить таймаут неактивности
function resetKeyTimeout() {
    clearKeyTimeout();
    lastActivityTime = Date.now();

    // Основной таймаут — очистка ключа
    keyTimeoutId = setTimeout(() => {
        clearEncryptKey('Таймаут неактивности');
    }, KEY_TIMEOUT_MS);

    // Обновление отображения каждую секунду
    keyTimerIntervalId = setInterval(() => {
        updateKeyTimerDisplay();
    }, 1000);
}

// Очистить таймауты
function clearKeyTimeout() {
    if (keyTimeoutId) {
        clearTimeout(keyTimeoutId);
        keyTimeoutId = null;
    }
    if (keyTimerIntervalId) {
        clearInterval(keyTimerIntervalId);
        keyTimerIntervalId = null;
    }
}

// Очистить ключ
function clearEncryptKey(reason) {
    if (encryptKey) {
        encryptKey = '';
        clearKeyTimeout();
        updateKeyStatus(false);
        if (reason) {
            showSaveNotification(reason);
        }
    }
}

// Открыть модальное окно ключа
function openKeyModal() {
    document.getElementById('keyModal').classList.add('active');
    document.getElementById('modalKeyInput').focus();
}

// Закрыть модальное окно ключа
function closeKeyModal() {
    document.getElementById('keyModal').classList.remove('active');
}

// Показать или скрыть ключ в поле ввода
function toggleKeyVisibility() {
    const input = document.getElementById('modalKeyInput');
    const btn = event.target.closest('.icon-btn');
    if (input.type === 'password') {
        input.type = 'text';
    } else {
        input.type = 'password';
    }
}

// Сохранить ключ и загрузить пароли
async function saveKey() {
    const key = document.getElementById('modalKeyInput').value.trim();
    setEncryptKey(key);
    closeKeyModal();
    showSaveNotification('Ключ сохранён');
    if (key) {
        await loadPasswords();
    }
}

// ============================================
// Вспомогательные функции
// ============================================

// Показать уведомление о сохранении
function showSaveNotification(text) {
    const n = document.getElementById('saveNotification');
    n.textContent = text || 'Сохранено';
    n.style.display = 'block';
    setTimeout(() => { n.style.display = 'none'; }, 3000);
}

// Скопировать текст в буфер обмена
function copyToClipboard(text) {
    if (!text) return;
    if (navigator.clipboard && navigator.clipboard.writeText) {
        navigator.clipboard.writeText(text).then(() => {
            showSaveNotification('Скопировано');
        }).catch(() => {
            fallbackCopy(text);
        });
    } else {
        fallbackCopy(text);
    }
}

// Резервный метод копирования для старых браузеров
function fallbackCopy(text) {
    const ta = document.createElement('textarea');
    ta.value = text;
    ta.style.position = 'fixed';
    ta.style.left = '-9999px';
    document.body.appendChild(ta);
    ta.select();
    try {
        document.execCommand('copy');
        showSaveNotification('Скопировано');
    } catch (e) {
        // Игнорируем ошибки копирования
    }
    document.body.removeChild(ta);
}

// Экранировать HTML-символы для безопасности
function escapeHtml(text) {
    if (!text) return '';
    return String(text)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#x27;');
}

// ============================================
// Отображение паролей в таблице
// ============================================

// Создать HTML для ячейки с паролем
function passwordField(value, id) {
    if (!value) {
        return '<span class="no-auth">—</span>';
    }
    const escaped = escapeHtml(value);
    return `
        <div class="password-field">
            <input type="password" id="${id}" class="password-input" value="${escaped}" readonly>
            <button type="button" class="btn btn-sm" onclick="togglePassword(this)" title="Показать/скрыть">
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8z"/><circle cx="12" cy="12" r="3"/></svg>
            </button>
            <button type="button" class="btn btn-sm" onclick="copyFromField(this)" title="Скопировать">
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="9" y="9" width="13" height="13" rx="2" ry="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/></svg>
            </button>
        </div>
    `;
}

// Скопировать из поля ввода
function copyFromField(btn) {
    const field = btn.closest('.password-field');
    if (field) {
        const input = field.querySelector('.password-input');
        if (input) {
            copyToClipboard(input.value);
        }
    }
}

// Показать или скрыть пароль в ячейке
function togglePassword(btn) {
    const inp = btn.previousElementSibling;
    if (inp.type === 'password') {
        inp.type = 'text';
    } else {
        inp.type = 'password';
    }
}

// Скопировать из скрытого поля ввода
function copyFromSource(btn) {
    const sourceId = btn.dataset.copySource;
    if (sourceId) {
        const input = document.getElementById(sourceId);
        if (input) {
            const wasPassword = input.type === 'password';
            if (wasPassword) input.type = 'text';
            copyToClipboard(input.value);
            if (wasPassword) input.type = 'password';
            return;
        }
    }
    const text = btn.dataset.copyText || '';
    if (text) copyToClipboard(text);
}

// Скопировать текст из кнопки
function copyFromText(btn) {
    const text = btn.dataset.copyText || '';
    copyToClipboard(text);
}

// Показать или скрыть пароль в ячейке
function togglePassword(btn) {
    const inp = btn.previousElementSibling;
    if (inp.type === 'password') {
        inp.type = 'text';
    } else {
        inp.type = 'password';
    }
}

// ============================================
// ============================================
// Загрузка и отображение паролей
// ============================================

// Загрузить пароли с сервера
async function loadPasswords() {
    const refreshBtn = document.getElementById('refreshPasswordsBtn');
    const originalText = refreshBtn ? refreshBtn.textContent : '';
    if (refreshBtn) {
        refreshBtn.textContent = 'Загрузка...';
        refreshBtn.disabled = true;
    }

    try {
        const key = getEncryptKey();
        const headers = key ? { 'X-Encrypt-Key': key } : {};

        const resp = await fetch('/api/passwords', {
            headers,
            cache: 'no-cache'
        });

        if (!resp.ok) {
            const errorData = await resp.json().catch(() => ({}));
            throw new Error(errorData.detail || `HTTP ${resp.status}`);
        }

        passwords = await resp.json();

        updateGroupsDatalist();
        renderPasswords();
    } catch (e) {
        console.error('Ошибка загрузки паролей:', e);
        const tbody = document.getElementById('passwordsBody');
        if (tbody) {
            tbody.innerHTML = '<tr><td colspan="7" class="empty-state">Ошибка загрузки</td></tr>';
        }
    } finally {
        if (refreshBtn) {
            refreshBtn.textContent = originalText;
            refreshBtn.disabled = false;
        }
    }
}

// Отрисовать таблицу паролей
function renderPasswords() {
    const tbody = document.getElementById('passwordsBody');
    if (!tbody) return;

    // Если нет записей - показать сообщение
    if (passwords.length === 0) {
        tbody.innerHTML = '<tr><td colspan="7" class="empty-state">Нет записей</td></tr>';
        return;
    }

    let html = '';
    passwords.forEach((p, index) => {
        const name = escapeHtml(p.name || '');
        const login = escapeHtml(p.login || '');
        const email = escapeHtml(p.email || '');
        const password = p.password || '';
        const comment = escapeHtml(p.comment || '');
        const group = p.group || '';

// Создать кнопку копирования для текстового поля
        const copyBtn = (text) => text ? `<button type="button" class="copy-btn" data-copy-text="${escapeHtml(text)}" onclick="copyFromText(this)" title="Скопировать">
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="9" y="9" width="13" height="13" rx="2" ry="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/></svg>
        </button>` : '';

        html += `
            <tr data-index="${index}">
                <td data-col="name"><div class="cell-content">${name}${copyBtn(p.name || '')}</div></td>
                <td data-col="login"><div class="cell-content">${login}${copyBtn(p.login || '')}</div></td>
                <td data-col="email"><div class="cell-content">${email || '<span class="no-auth">—</span>'}${copyBtn(p.email || '')}</div></td>
                <td data-col="password">${passwordField(password, 'pwd-pw-' + index)}</td>
                <td data-col="comment"><div class="cell-content">${comment}${copyBtn(p.comment || '')}</div></td>
                <td data-col="group"><div class="cell-content">${group ? `<span style="font-weight: 500;">${group}</span>` : '<span class="no-auth">—</span>'}${copyBtn(group)}</div></td>
                <td class="actions-cell" data-col="actions">
                    <button class="btn btn-sm btn-edit" onclick="editPassword(${index})">
                        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"/><path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z"/></svg>
                    </button>
                    <button class="btn btn-sm btn-danger" onclick="deletePassword(${index})">
                        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="3 6 5 6 21 6"/><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/></svg>
                    </button>
                </td>
            </tr>
        `;
    });

    tbody.innerHTML = html;
    applyPasswordFilter();
}

// Применить фильтр поиска
function applyPasswordFilter() {
    const searchInput = document.getElementById('passwordSearchInput');
    const query = searchInput ? searchInput.value.trim().toLowerCase() : '';
    const tbody = document.getElementById('passwordsBody');
    if (!tbody) return;

    const rows = tbody.querySelectorAll('tr[data-index]');
    rows.forEach(row => {
        if (!query) {
            row.style.display = '';
            return;
        }
        let text = '';
        row.querySelectorAll('td:not(.actions-cell)').forEach(td => {
            text += ' ' + (td.textContent || '');
        });
        row.style.display = text.toLowerCase().includes(query) ? '' : 'none';
    });
}

// ============================================
// Модальное окно для записи
// ============================================

// Открыть модальное окно
function openPasswordModal() {
    document.getElementById('passwordModal').classList.add('active');
    document.getElementById('passwordModalNameInput').focus();
}

// Закрыть модальное окно
function closePasswordModal() {
    document.getElementById('passwordModal').classList.remove('active');
}

// Показать или скрыть пароль в модальном окне
function togglePasswordModalVisibility(btn) {
    const input = document.getElementById('passwordModalValueInput');
    if (!btn && typeof event !== 'undefined') {
        btn = event.target.closest('.icon-btn');
    }
    if (!btn) return;
    if (input.type === 'password') {
        input.type = 'text';
    } else {
        input.type = 'password';
    }
}

// Очистить форму и открыть для добавления
function showPasswordForm() {
    document.getElementById('passwordModalEditIndex').value = '-1';
    document.getElementById('passwordModalTitle').textContent = 'Добавить запись';
    document.getElementById('passwordModalNameInput').value = '';
    document.getElementById('passwordModalLoginInput').value = '';
    document.getElementById('passwordModalValueInput').value = '';
    document.getElementById('passwordModalEmailInput').value = '';
    document.getElementById('passwordModalCommentInput').value = '';
    document.getElementById('passwordModalGroupInput').value = '';
    openPasswordModal();
}

// Заполнить форму для редактирования
function editPassword(i) {
    const p = passwords[i];
    if (!p) return;

    document.getElementById('passwordModalEditIndex').value = i;
    document.getElementById('passwordModalTitle').textContent = 'Редактировать запись';
    document.getElementById('passwordModalNameInput').value = p.name || '';
    document.getElementById('passwordModalLoginInput').value = p.login || '';
    document.getElementById('passwordModalValueInput').value = p.password || '';
    document.getElementById('passwordModalEmailInput').value = p.email || '';
    document.getElementById('passwordModalCommentInput').value = p.comment || '';
    document.getElementById('passwordModalGroupInput').value = p.group || '';
    openPasswordModal();
}

// Сохранить запись из модального окна
async function savePasswordModal() {
    const key = getEncryptKey();
    if (!key) {
        alert('Установите ключ шифрования');
        openKeyModal();
        return;
    }

    const name = document.getElementById('passwordModalNameInput').value.trim();
    if (!name) {
        alert('Введите название записи');
        document.getElementById('passwordModalNameInput').focus();
        return;
    }

    // Проверить максимальную длину полей
    const MAX_FIELD_LENGTHS = {
        name: 100,
        login: 256,
        password: 1024,
        email: 256,
        comment: 2000,
        group: 100
    };

    function checkFieldLength(inputId, maxLen) {
        const val = document.getElementById(inputId).value;
        if (val.length > maxLen) {
            alert(`Слишком длинное поле (максимум ${maxLen} символов)`);
            return false;
        }
        return true;
    }

    if (!checkFieldLength('passwordModalNameInput', MAX_FIELD_LENGTHS.name)) return;
    if (!checkFieldLength('passwordModalLoginInput', MAX_FIELD_LENGTHS.login)) return;
    if (!checkFieldLength('passwordModalValueInput', MAX_FIELD_LENGTHS.password)) return;
    if (!checkFieldLength('passwordModalEmailInput', MAX_FIELD_LENGTHS.email)) return;
    if (!checkFieldLength('passwordModalCommentInput', MAX_FIELD_LENGTHS.comment)) return;
    if (!checkFieldLength('passwordModalGroupInput', MAX_FIELD_LENGTHS.group)) return;

    // Собрать данные формы
    const idx = parseInt(document.getElementById('passwordModalEditIndex').value);
    const group = document.getElementById('passwordModalGroupInput').value.trim();

    const newItem = {
        name: name,
        login: document.getElementById('passwordModalLoginInput').value.trim(),
        password: document.getElementById('passwordModalValueInput').value,
        email: document.getElementById('passwordModalEmailInput').value.trim(),
        comment: document.getElementById('passwordModalCommentInput').value.trim(),
        group: group,
        _index: idx >= 0 ? idx : null
    };

    // Отправить на сервер
    try {
        const resp = await fetch('/api/passwords/item', {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'X-Encrypt-Key': key
            },
            body: JSON.stringify(newItem)
        });

        if (resp.ok) {
            showSaveNotification('Запись сохранена');
            closePasswordModal();
            await loadPasswords();
        } else {
            const errorText = await resp.text();
            alert('Ошибка сохранения: ' + resp.status);
        }
    } catch (error) {
        alert('Ошибка сети при сохранении: ' + error.message);
    }
}

// ============================================
// Удаление записи
// ============================================

async function deletePassword(i) {
    if (!confirm('Удалить запись?')) return;

    const key = getEncryptKey();
    if (!key) {
        alert('Ключ шифрования не установлен');
        return;
    }

    try {
        const resp = await fetch('/api/passwords', {
            method: 'DELETE',
            headers: {
                'Content-Type': 'application/json',
                'X-Encrypt-Key': key
            },
            body: JSON.stringify({ index: i })
        });

        if (resp.ok) {
            showSaveNotification('Запись удалена');
            await loadPasswords();
        } else {
            alert('Ошибка удаления: ' + resp.status);
        }
    } catch (error) {
        alert('Ошибка сети при удалении: ' + error.message);
    }
}

// ============================================
// Управление группами
// ============================================

// Обновить список групп в datalist
function updateGroupsDatalist() {
    const existing = new Set();
    passwords.forEach(p => {
        if (p.group && p.group.trim()) {
            existing.add(p.group.trim());
        }
    });
    const dl = document.getElementById('groupsList');
    if (!dl) return;
    dl.innerHTML = '';
    existing.forEach(name => {
        const opt = document.createElement('option');
        opt.value = escapeHtml(name);
        dl.appendChild(opt);
    });
}

// ============================================
// Экспорт и импорт JSON
// ============================================

// Установить состояние загрузки кнопки
function setLoading(buttonId, isLoading, statusText = '') {
    try {
        const btn = document.getElementById(buttonId);
        if (btn) {
            if (isLoading) {
                btn.classList.add('loading');
                btn.disabled = true;
            } else {
                btn.classList.remove('loading');
                btn.disabled = false;
            }
        }
    } catch (e) {
        console.warn('Ошибка в setLoading:', e);
    }
}

// Выгрузить пароли в JSON файл
async function exportPasswordsJson() {
    const key = getEncryptKey();
    if (!key) {
        alert('Для выгрузки паролей в JSON необходим установленный ключ шифрования');
        openKeyModal();
        return;
    }

    setLoading('exportJsonBtn', true);

    try {
        const headers = { 'X-Encrypt-Key': key };
        const resp = await fetch('/api/passwords', { headers });
        const decryptedPasswords = await resp.json();

        // Создать файл для скачивания
        const jsonData = JSON.stringify(decryptedPasswords, null, 2);
        const blob = new Blob([jsonData], { type: 'application/json' });
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = 'passwords.json';
        document.body.appendChild(a);
        a.click();
        document.body.removeChild(a);
        URL.revokeObjectURL(url);

        showSaveNotification('Экспорт завершён');
    } catch (e) {
        console.error('Ошибка при экспорте:', e);
        alert('Ошибка при выгрузке паролей');
    } finally {
        setLoading('exportJsonBtn', false);
    }
}

// Открыть диалог выбора файла для импорта
function importPasswordsJson() {
    const input = document.getElementById('importPasswordsFile');
    if (input) {
        input.click();
    }
}

// Обработать выбранный файл для импорта
async function handlePasswordsFileImport(input) {
    const key = getEncryptKey();
    if (!key) {
        alert('Для загрузки паролей из JSON необходим установленный ключ шифрования');
        openKeyModal();
        input.value = '';
        return;
    }

    const file = input.files[0];
    if (!file) {
        input.value = '';
        return;
    }

    // Проверить размер файла (максимум 5 МБ)
    const MAX_FILE_SIZE = 5 * 1024 * 1024;
    if (file.size > MAX_FILE_SIZE) {
        alert('Файл слишком большой (максимум 5 МБ)');
        input.value = '';
        return;
    }

    setLoading('importJsonBtn', true);

    try {
        // Прочитать и распарсить файл
        const text = await file.text();
        if (!text.trim()) {
            throw new Error('Файл пуст');
        }

        let importedPasswords;
        try {
            importedPasswords = JSON.parse(text);
        } catch (parseError) {
            throw new Error('Некорректный JSON формат: ' + parseError.message);
        }

        // Проверить что это массив
        if (!Array.isArray(importedPasswords)) {
            throw new Error('Файл должен содержать массив паролей');
        }

        // Подтвердить импорт
        if (!confirm(`Импортировать ${importedPasswords.length} записей? Текущие данные будут заменены.`)) {
            input.value = '';
            setLoading('importJsonBtn', false);
            return;
        }

        // Отправить на сервер
        const resp = await fetch('/api/passwords/import', {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'X-Encrypt-Key': key
            },
            body: JSON.stringify(importedPasswords)
        });

        if (resp.ok) {
            const result = await resp.json();
            await loadPasswords();
            showSaveNotification('Импорт завершён');
            alert(`Успешно импортировано ${result.count || importedPasswords.length} записей`);
        } else {
            throw new Error('Ошибка сервера при импорте');
        }
    } catch (e) {
        console.error('Ошибка при импорте:', e);
        alert('Ошибка при импорте паролей: ' + e.message);
    } finally {
        input.value = '';
        setLoading('importJsonBtn', false);
    }
}

// ============================================
// Инициализация при загрузке страницы
// ============================================

document.addEventListener('DOMContentLoaded', () => {
    // Загрузить пароли при старте
    loadPasswords();

    // Добавить обработчик поиска
    const searchInput = document.getElementById('passwordSearchInput');
    if (searchInput) {
        searchInput.addEventListener('input', applyPasswordFilter);
    }

    // Отслеживание активности пользователя (сброс таймера)
    const activityEvents = ['mousedown', 'mousemove', 'keypress', 'scroll', 'touchstart', 'click'];
    activityEvents.forEach(evt => {
        document.addEventListener(evt, resetKeyTimeout, { passive: true });
    });

    // Очистка ключа при закрытии вкладки
    window.addEventListener('beforeunload', () => {
        clearEncryptKey(null);
    });
});

// Обработчик Enter в поле ключа
document.getElementById('modalKeyInput').addEventListener('keypress', e => {
    if (e.key === 'Enter') saveKey();
});

// Закрытие модального окна по клику на фон
document.getElementById('keyModal').addEventListener('click', e => {
    if (e.target === e.currentTarget) closeKeyModal();
});

// Обработчик Enter в поле названия записи
document.getElementById('passwordModalNameInput').addEventListener('keypress', e => {
    if (e.key === 'Enter') savePasswordModal();
});

// Закрытие модального окна записи по клику на фон
document.getElementById('passwordModal').addEventListener('click', e => {
    if (e.target === e.currentTarget) closePasswordModal();
});

// ============================================
// Глобальные функции для onclick обработчиков
// ============================================
window.saveKey = saveKey;
window.openKeyModal = openKeyModal;
window.closeKeyModal = closeKeyModal;
window.showSaveNotification = showSaveNotification;
window.toggleKeyVisibility = toggleKeyVisibility;
window.togglePassword = togglePassword;
window.showPasswordForm = showPasswordForm;
window.deletePassword = deletePassword;
window.editPassword = editPassword;
window.loadPasswords = loadPasswords;
window.openPasswordModal = openPasswordModal;
window.closePasswordModal = closePasswordModal;
window.togglePasswordModalVisibility = togglePasswordModalVisibility;
window.savePasswordModal = savePasswordModal;
window.exportPasswordsJson = exportPasswordsJson;
window.importPasswordsJson = importPasswordsJson;
window.handlePasswordsFileImport = handlePasswordsFileImport;
window.setLoading = setLoading;
window.copyToClipboard = copyToClipboard;
window.copyFromSource = copyFromSource;
window.copyFromText = copyFromText;
window.copyFromField = copyFromField;
