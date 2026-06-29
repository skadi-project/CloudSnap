console.log("Renderer.ts загружен");

// === Интерфейсы для Electron API ===
interface Credentials {
    url: string;
    login: string;
    password?: string;
    rememberMe: boolean;
    hasPassword?: boolean;
}

interface AppSettings {
    remoteFolder: string;
    folderStructure: string;
    linkMode: string;
    filenameTemplate: string;
    defaultDelay: number;
    autoStart: boolean;
    startMinimized: boolean;
    saveLocalCopy: boolean;
    shortcutModifier: string;
    shortcutKey: string;
    recordShortcutModifier: string;
    recordShortcutKey: string;
    stopShortcutModifier: string;
    stopShortcutKey: string;
    videoBitrate: number;
    recordAudio: boolean;
}

interface HistoryItem {
    id: string;
    type: 'image' | 'video';
    filename: string;
    timestamp: number | string | Date;
    status: 'uploaded' | 'queued' | 'error';
    thumbnailPath?: string;
    finalLink?: string;
    filePath?: string;
}

interface RecordingStatePayload {
    state: 'idle' | 'selecting' | 'recording' | 'paused' | 'stopping';
    elapsed?: number;
}

// Расширяем глобальный объект Window для работы с контекстным мостом Electron
interface Window {
    electronAPI: {
        openScreenshotsFolder: () => Promise<void>;
        saveCredentials: (config: Credentials) => Promise<{ success: boolean; error?: string }>;
        loadCredentials: () => Promise<Credentials & { hasPassword?: boolean }>;
        loadAppSettings: () => Promise<Partial<AppSettings>>;
        saveAppSettings: (settings: AppSettings) => Promise<{ success: boolean; error?: string }>;
        getScreenshotMode: () => Promise<string>;
        setScreenshotMode: (mode: string) => Promise<void>;
        testConnection: (config: Credentials) => Promise<{ success: boolean; error?: string }>;
        getHistory: () => Promise<HistoryItem[]>;
        copyHistoryLink: (id: string) => Promise<{ success: boolean }>;
        openInNextcloud: (id: string) => Promise<void>;
        deleteHistoryItem: (id: string) => Promise<void>;
        clearHistory: () => Promise<void>;
        startVideoRecording: () => Promise<void>;
        startAreaRecording: () => Promise<void>;
        getRecordingState: () => Promise<RecordingStatePayload>;
        togglePauseRecording: () => Promise<void>;
        stopRecording: () => Promise<void>;
        onScreenshotModeChanged: (callback: (mode: string) => void) => void;
        onStatusUpdate: (callback: (message: string) => void) => void;
        onConnectionStatus: (callback: (data: { status: string; message: string }) => void) => void;
        getConnectionStatus: () => Promise<{ status: string; message: string }>;
        onRecordingStateChanged: (callback: (data: RecordingStatePayload) => void) => void;
        onRecordingTimerUpdate: (callback: (seconds: number) => void) => void;
        onHistoryUpdated: (callback: () => void) => void;
    };
}

// === SVG-иконки ===
const SVG: Record<string, string> = {
    link: '<svg class="icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M10 13a5 5 0 007.54.54l3-3a5 5 0 00-7.07-7.07l-1.72 1.71"/><path d="M14 11a5 5 0 00-7.54-.54l-3 3a5 5 0 007.07 7.07l1.71-1.71"/></svg>',
    cloud: '<svg class="icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M18 10h-1.26A8 8 0 109 20h9a5 5 0 000-10z"/></svg>',
    x: '<svg class="icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>',
    film: '<svg class="icon icon-lg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linejoin="round"><rect x="2" y="2" width="20" height="20" rx="2"/><polygon points="10,7 17,12 10,17" fill="currentColor"/></svg>',
    stop: '<svg class="icon" viewBox="0 0 24 24" fill="currentColor"><rect x="6" y="6" width="12" height="12" rx="1.5"/></svg>',
    play: '<svg class="icon" viewBox="0 0 24 24" fill="currentColor"><polygon points="6,3 20,12 6,21"/></svg>'
};

// === DOM-элементы ===
const tabBar = document.getElementById('tabBar') as HTMLElement | null;
const tabBtns = document.querySelectorAll('.tab-btn') as NodeListOf<HTMLButtonElement>;
const settingsTab = document.getElementById('settingsTab') as HTMLElement | null;
const historyTab = document.getElementById('historyTab') as HTMLElement | null;

const authForm = document.getElementById('authForm') as HTMLElement | null;
const profileView = document.getElementById('profileView') as HTMLElement | null;
const statusContainer = document.getElementById('statusContainer') as HTMLElement | null;
const statusLog = document.getElementById('statusLog') as HTMLElement | null;

const urlInput = document.getElementById('url') as HTMLInputElement | null;
const loginInput = document.getElementById('login') as HTMLInputElement | null;
const passwordInput = document.getElementById('password') as HTMLInputElement | null;
const rememberMeCheckbox = document.getElementById('rememberMe') as HTMLInputElement | null;

const activeUser = document.getElementById('activeUser') as HTMLElement | null;
const activeServer = document.getElementById('activeServer') as HTMLElement | null;

const saveBtn = document.getElementById('saveBtn') as HTMLButtonElement | null;

const hotkeyModifierSelect = document.getElementById('hotkeyModifier') as HTMLSelectElement | null;
const hotkeyKeySelect = document.getElementById('hotkeyKey') as HTMLSelectElement | null;

const recordHotkeyModifierSelect = document.getElementById('recordHotkeyModifier') as HTMLSelectElement | null;
const recordHotkeyKeySelect = document.getElementById('recordHotkeyKey') as HTMLSelectElement | null;
const stopHotkeyModifierSelect = document.getElementById('stopHotkeyModifier') as HTMLSelectElement | null;
const stopHotkeyKeySelect = document.getElementById('stopHotkeyKey') as HTMLSelectElement | null;

const remoteFolderInput = document.getElementById('remoteFolder') as HTMLInputElement | null;
const folderStructureSelect = document.getElementById('folderStructure') as HTMLSelectElement | null;
const linkModeSelect = document.getElementById('linkMode') as HTMLSelectElement | null;
const filenameTemplateInput = document.getElementById('filenameTemplate') as HTMLInputElement | null;
const defaultDelaySelect = document.getElementById('defaultDelay') as HTMLSelectElement | null;
const autoStartCheckbox = document.getElementById('autoStart') as HTMLInputElement | null;
const startMinimizedCheckbox = document.getElementById('startMinimized') as HTMLInputElement | null;
const startMinimizedGroup = document.getElementById('startMinimizedGroup') as HTMLElement | null;
const saveLocalCopyCheckbox = document.getElementById('saveLocalCopy') as HTMLInputElement | null;
const openScreenshotsBtn = document.getElementById('openScreenshotsBtn') as HTMLButtonElement | null;
const saveSettingsBtn = document.getElementById('saveSettingsBtn') as HTMLButtonElement | null;


const historyList = document.getElementById('historyList') as HTMLElement | null;
const historyEmpty = document.getElementById('historyEmpty') as HTMLElement | null;
const clearHistoryBtn = document.getElementById('clearHistoryBtn') as HTMLButtonElement | null;

// === Запись видео: DOM-элементы ===
const recordingBar = document.getElementById('recordingBar') as HTMLElement | null;
const recordingStatusText = document.getElementById('recordingStatusText') as HTMLElement | null;
const recordingTimerText = document.getElementById('recordingTimerText') as HTMLElement | null;
const recordBtns = document.getElementById('recordBtns') as HTMLElement | null;
const recordStopBtns = document.getElementById('recordStopBtns') as HTMLElement | null;
const recordFullscreenBtn = document.getElementById('recordFullscreenBtn') as HTMLButtonElement | null;
const recordAreaBtn = document.getElementById('recordAreaBtn') as HTMLButtonElement | null;
const recordStopBtn = document.getElementById('recordStopBtn') as HTMLButtonElement | null;
const videoBitrateSelect = document.getElementById('videoBitrate') as HTMLSelectElement | null;
const recordAudioCheckbox = document.getElementById('recordAudio') as HTMLInputElement | null;

// === Вкладки ===

function switchTab(tabName: string): void {
    tabBtns.forEach(b => b.classList.remove('active'));
    const targetedBtn = document.querySelector(`.tab-btn[data-tab="${tabName}"]`);
    if (targetedBtn) targetedBtn.classList.add('active');

    if (settingsTab) settingsTab.classList.remove('active');
    if (historyTab) historyTab.classList.remove('active');
    
    if (tabName === 'settings' && settingsTab) settingsTab.classList.add('active');
    else if (tabName === 'history' && historyTab) historyTab.classList.add('active');
    
    if (tabName === 'history') renderHistory();
}

tabBtns.forEach(btn => {
    btn.addEventListener('click', () => switchTab(btn.dataset.tab || ''));
});

function showTabBar(): void {
    if (tabBar) tabBar.style.display = 'flex';
}

// === Чекбокс saveLocalCopy ===

function updateOpenScreenshotsBtn(): void {
    if (!openScreenshotsBtn || !saveLocalCopyCheckbox) return;
    openScreenshotsBtn.classList.toggle('hidden', !saveLocalCopyCheckbox.checked);
}

function updateStartMinimizedVisibility(): void {
    if (!startMinimizedGroup || !autoStartCheckbox) return;
    startMinimizedGroup.classList.toggle('hidden', !autoStartCheckbox.checked);
}

if (autoStartCheckbox) {
    autoStartCheckbox.addEventListener('change', updateStartMinimizedVisibility);
}

if (saveLocalCopyCheckbox) {
    saveLocalCopyCheckbox.addEventListener('change', updateOpenScreenshotsBtn);
}

if (openScreenshotsBtn) {
    openScreenshotsBtn.addEventListener('click', async () => {
        await window.electronAPI.openScreenshotsFolder();
    });
}

// === Авторизация ===

function showAuthenticatedState(config: Credentials): void {
    if (!authForm || !profileView || !statusContainer) return;
    authForm.classList.add('hidden');
    profileView.classList.remove('hidden');
    statusContainer.style.display = 'block';
    showTabBar();

    let logoutBtn = document.getElementById('logoutBtn') as HTMLButtonElement | null;
    if (!logoutBtn) {
        logoutBtn = document.createElement('button');
        logoutBtn.id = 'logoutBtn';
        logoutBtn.className = 'logout-btn';
        logoutBtn.textContent = 'Выйти из аккаунта';
        profileView.appendChild(logoutBtn);

        logoutBtn.addEventListener('click', async () => {
            const logoutConfig: Credentials = {
                url: urlInput ? urlInput.value : '',
                login: loginInput ? loginInput.value : '',
                password: '',
                rememberMe: rememberMeCheckbox ? rememberMeCheckbox.checked : true
            };
            await window.electronAPI.saveCredentials(logoutConfig);
            showLoginState();
        });
    }

    if (activeUser) activeUser.innerText = config.login || 'Пользователь';

    try {
        if (config.url) {
            const urlObj = new URL(config.url);
            if (activeServer) activeServer.innerText = urlObj.host;
        } else {
            if (activeServer) activeServer.innerText = 'Локальный сервер';
        }
    } catch (e) {
        if (activeServer) activeServer.innerText = config.url || 'localhost';
    }
}

function showLoginState(): void {
    if (authForm && profileView && statusContainer) {
        authForm.classList.remove('hidden');
        profileView.classList.add('hidden');
        statusContainer.style.display = 'none';
    }
    const logoutBtn = document.getElementById('logoutBtn');
    if (logoutBtn) logoutBtn.remove();
    if (tabBar) tabBar.style.display = 'none';
}

// === Настройки ===

async function initAppSettings(): Promise<void> {
    if (window.electronAPI && typeof window.electronAPI.loadAppSettings === 'function') {
        try {
            const settings = await window.electronAPI.loadAppSettings();
            if (remoteFolderInput) remoteFolderInput.value = settings.remoteFolder || '';
            if (folderStructureSelect) folderStructureSelect.value = settings.folderStructure || 'none';
            if (linkModeSelect) linkModeSelect.value = settings.linkMode || 'internal';
            if (filenameTemplateInput) filenameTemplateInput.value = settings.filenameTemplate || 'CS_{type}_{datetime}';
            if (defaultDelaySelect) defaultDelaySelect.value = String(settings.defaultDelay ?? "0");
            if (autoStartCheckbox) autoStartCheckbox.checked = !!settings.autoStart;
            if (startMinimizedCheckbox) startMinimizedCheckbox.checked = !!settings.startMinimized;
            updateStartMinimizedVisibility();
            if (saveLocalCopyCheckbox) saveLocalCopyCheckbox.checked = !!settings.saveLocalCopy;
            updateOpenScreenshotsBtn();
            if (hotkeyModifierSelect) hotkeyModifierSelect.value = settings.shortcutModifier || "Control+Shift";
            if (hotkeyKeySelect) hotkeyKeySelect.value = settings.shortcutKey || "A";
            if (recordHotkeyModifierSelect) recordHotkeyModifierSelect.value = settings.recordShortcutModifier || "Control+Shift";
            if (recordHotkeyKeySelect) recordHotkeyKeySelect.value = settings.recordShortcutKey || "V";
            if (stopHotkeyModifierSelect) stopHotkeyModifierSelect.value = settings.stopShortcutModifier || "Control+Shift";
            if (stopHotkeyKeySelect) stopHotkeyKeySelect.value = settings.stopShortcutKey || "S";
            if (videoBitrateSelect) videoBitrateSelect.value = String(settings.videoBitrate || 2500000);
            if (recordAudioCheckbox) recordAudioCheckbox.checked = !!settings.recordAudio;
        } catch (err) {
            console.error("Ошибка загрузки параметров:", err);
        }
    }
}

async function initForm(): Promise<void> {
    try {
        if (!window.electronAPI || !window.electronAPI.loadCredentials) {
            if (statusLog) statusLog.innerText = "Ошибка инициализации API.";
            return;
        }

        const savedConfig = await window.electronAPI.loadCredentials();

        if (savedConfig && savedConfig.hasPassword) {
            showAuthenticatedState(savedConfig);
            // Connection monitor will set status via onConnectionStatus
            await initAppSettings();
        } else {
            showLoginState();
            if (savedConfig) {
                if (savedConfig.url && urlInput) urlInput.value = savedConfig.url;
                if (savedConfig.login && loginInput) loginInput.value = savedConfig.login;
                if (savedConfig.rememberMe !== undefined && rememberMeCheckbox) rememberMeCheckbox.checked = savedConfig.rememberMe;
            }
        }


    } catch (err) {
        console.error("Ошибка initForm:", err);
    }
}

if (saveBtn) {
    saveBtn.addEventListener('click', async () => {
        const config: Credentials = {
            url: urlInput ? urlInput.value : '',
            login: loginInput ? loginInput.value : '',
            password: passwordInput ? passwordInput.value : '',
            rememberMe: rememberMeCheckbox ? rememberMeCheckbox.checked : true
        };

        if (!config.url || !config.login || !config.password) {
            if (statusLog) {
                statusLog.innerText = 'Заполните все поля!';
                statusLog.style.color = '#f44336';
            }
            if (statusContainer) statusContainer.style.display = 'block';
            return;
        }

        saveBtn.disabled = true;
        saveBtn.innerText = 'Проверка...';

        try {
            const testResult = await window.electronAPI.testConnection(config);

            if (!testResult.success) {
                saveBtn.disabled = false;
                saveBtn.innerText = 'Войти и подключить';
                if (statusLog) {
                    statusLog.innerText = 'Ошибка: ' + testResult.error;
                    statusLog.style.color = '#f44336';
                }
                if (statusContainer) statusContainer.style.display = 'block';
                return;
            }

            saveBtn.innerText = 'Сохранение...';
            const result = await window.electronAPI.saveCredentials(config);

            if (result && result.success) {
                if (passwordInput) passwordInput.value = '';
                showAuthenticatedState(config);
                await initAppSettings();
                if (statusLog) {
                    statusLog.innerText = 'Подключено к Nextcloud!';
                    statusLog.style.color = '#4caf50';
                }
            } else {
                if (statusLog) {
                    statusLog.innerText = 'Ошибка сохранения: ' + (result?.error ? result.error : 'неизвестно');
                    statusLog.style.color = '#f44336';
                }
                if (statusContainer) statusContainer.style.display = 'block';
            }
        } catch (ipcError: any) {
            if (statusLog) {
                statusLog.innerText = 'Критическая ошибка: ' + ipcError.message;
                statusLog.style.color = '#f44336';
            }
            if (statusContainer) statusContainer.style.display = 'block';
        } finally {
            saveBtn.disabled = false;
            saveBtn.innerText = 'Войти и подключить';
        }
    });
}



if (window.electronAPI && typeof window.electronAPI.onStatusUpdate === 'function') {
    window.electronAPI.onStatusUpdate((message) => {
        if (statusLog) {
            statusLog.innerText = message;
            if (message.includes('Успех')) {
                statusLog.style.color = '#4caf50';
            } else if (message.includes('Ошибка')) {
                statusLog.style.color = '#f44336';
            } else {
                statusLog.style.color = '';
            }
        }
    });
}


// === Connection status monitor ===
let isDisconnected = false;
const connectionStatus = document.getElementById('connectionStatus') as HTMLElement | null;

/**
 * Применяет состояние подключения к DOM. Вынесено в отдельную функцию,
 * чтобы одинаково обрабатывать push-события от main и pull-запрос
 * `getConnectionStatus` (страховка от потерянного первого события).
 */
function applyConnectionStatus(data: { status: string; message: string }): void {
    if (data.status === 'disconnected') {
        isDisconnected = true;
        if (statusLog) { statusLog.innerText = data.message; statusLog.style.color = '#f44336'; }
        if (connectionStatus) { connectionStatus.innerText = 'Соединение потеряно'; connectionStatus.classList.remove('connected', 'reconnecting', 'checking'); connectionStatus.classList.add('disconnected'); }
    } else if (data.status === 'reconnecting') {
        if (statusLog) { statusLog.innerText = data.message; statusLog.style.color = '#ff9800'; }
        if (connectionStatus) { connectionStatus.innerText = data.message; connectionStatus.classList.remove('connected', 'disconnected', 'checking'); connectionStatus.classList.add('reconnecting'); }
    } else if (data.status === 'connected') {
        isDisconnected = false;
        if (statusLog) { statusLog.innerText = data.message; statusLog.style.color = '#4caf50'; }
        if (connectionStatus) { connectionStatus.innerText = 'Подключено к облаку'; connectionStatus.classList.remove('disconnected', 'reconnecting', 'checking'); connectionStatus.classList.add('connected'); }
    } else if (data.status === 'checking') {
        if (statusLog) { statusLog.innerText = data.message; statusLog.style.color = '#aaa'; }
        if (connectionStatus) { connectionStatus.innerText = 'Проверка соединения...'; connectionStatus.classList.remove('connected', 'disconnected', 'reconnecting'); connectionStatus.classList.add('checking'); }
    }
    if (statusContainer) statusContainer.style.display = 'block';
}

if (window.electronAPI && window.electronAPI.onConnectionStatus) {
    window.electronAPI.onConnectionStatus((data: { status: string; message: string }) => {
        applyConnectionStatus(data);
    });

    // Страховка от потерянного первого события: main мог отправить «checking»
    // ещё до того, как рендерер зарегистрировал слушатель. Запрашиваем текущее
    // состояние явно, чтобы бэйдж сразу получил правильный класс/текст.
    if (typeof window.electronAPI.getConnectionStatus === 'function') {
        window.electronAPI.getConnectionStatus()
            .then((state) => { if (state) applyConnectionStatus(state); })
            .catch(() => { /* non-fatal: следующее событие приведёт состояние в норму */ });
    }
}

if (saveSettingsBtn) {
    saveSettingsBtn.addEventListener('click', async () => {
        const settingsPayload: AppSettings = {
            remoteFolder: remoteFolderInput ? remoteFolderInput.value.trim() : '',
            folderStructure: folderStructureSelect ? folderStructureSelect.value : 'none',
            linkMode: linkModeSelect ? linkModeSelect.value : 'internal',
            filenameTemplate: filenameTemplateInput ? filenameTemplateInput.value.trim() : 'CS_{type}_{datetime}',
            defaultDelay: parseInt(defaultDelaySelect ? defaultDelaySelect.value : '0', 10) || 0,
            autoStart: autoStartCheckbox ? autoStartCheckbox.checked : false,
            startMinimized: startMinimizedCheckbox ? startMinimizedCheckbox.checked : false,
            saveLocalCopy: saveLocalCopyCheckbox ? saveLocalCopyCheckbox.checked : false,
            shortcutModifier: hotkeyModifierSelect ? hotkeyModifierSelect.value : "Control+Shift",
            shortcutKey: hotkeyKeySelect ? hotkeyKeySelect.value : "A",
            recordShortcutModifier: recordHotkeyModifierSelect ? recordHotkeyModifierSelect.value : "Control+Shift",
            recordShortcutKey: recordHotkeyKeySelect ? recordHotkeyKeySelect.value : "V",
            stopShortcutModifier: stopHotkeyModifierSelect ? stopHotkeyModifierSelect.value : "Control+Shift",
            stopShortcutKey: stopHotkeyKeySelect ? stopHotkeyKeySelect.value : "S",
            videoBitrate: parseInt(videoBitrateSelect ? videoBitrateSelect.value : '2500000', 10) || 2500000,
            recordAudio: recordAudioCheckbox ? recordAudioCheckbox.checked : true
        };

        // Проверка дубликатов горячих клавиш
        interface HotkeyConfig {
            name: string;
            modifier: string;
            key: string;
            selects: (HTMLSelectElement | null)[];
        }

        const hotkeys: HotkeyConfig[] = [
            { name: 'Скриншот', modifier: settingsPayload.shortcutModifier, key: settingsPayload.shortcutKey, selects: [hotkeyModifierSelect, hotkeyKeySelect] },
            { name: 'Запись', modifier: settingsPayload.recordShortcutModifier, key: settingsPayload.recordShortcutKey, selects: [recordHotkeyModifierSelect, recordHotkeyKeySelect] },
            { name: 'Стоп', modifier: settingsPayload.stopShortcutModifier, key: settingsPayload.stopShortcutKey, selects: [stopHotkeyModifierSelect, stopHotkeyKeySelect] }
        ];

        // Снимаем предыдущую подсветку
        document.querySelectorAll('.hotkey-conflict').forEach(el => el.classList.remove('hotkey-conflict'));

        const conflicts: [HotkeyConfig, HotkeyConfig][] = [];
        for (let i = 0; i < hotkeys.length; i++) {
            for (let j = i + 1; j < hotkeys.length; j++) {
                if (hotkeys[i].modifier === hotkeys[j].modifier && hotkeys[i].key === hotkeys[j].key) {
                    conflicts.push([hotkeys[i], hotkeys[j]]);
                    hotkeys[i].selects.forEach(el => { if (el) el.classList.add('hotkey-conflict'); });
                    hotkeys[j].selects.forEach(el => { if (el) el.classList.add('hotkey-conflict'); });
                }
            }
        }

        if (conflicts.length > 0) {
            const conflictMsg = conflicts.map(([a, b]) => `"${a.name}" и "${b.name}" совпадают (${a.modifier}+${a.key})`).join('; ');
            if (statusLog) {
                statusLog.innerText = `Конфликт горячих клавиш: ${conflictMsg}`;
                statusLog.style.color = '#f44336';
            }
            return;
        }

        saveSettingsBtn.disabled = true;
        saveSettingsBtn.innerText = "Сохранение...";

        const result = await window.electronAPI.saveAppSettings(settingsPayload);

        saveSettingsBtn.disabled = false;
        saveSettingsBtn.innerText = "Сохранить параметры";

        if (result && result.success) {
            await initAppSettings();
            if (statusLog) {
                statusLog.innerText = "Параметры обновлены!";
                statusLog.style.color = '#4caf50';
            }
        } else {
            if (statusLog) {
                statusLog.innerText = `Ошибка: ${result?.error || 'неизвестно'}`;
                statusLog.style.color = '#f44336';
            }
        }
    });
}

// === История ===

const STATUS_LABELS: Record<string, string> = {
    uploaded: 'Загружено',
    queued: 'В очереди',
    error: 'Ошибка'
};

function formatTimestamp(ts: number | string | Date): string {
    try {
        const d = new Date(ts);
        const day = String(d.getDate()).padStart(2, '0');
        const month = String(d.getMonth() + 1).padStart(2, '0');
        const year = d.getFullYear();
        const hours = String(d.getHours()).padStart(2, '0');
        const minutes = String(d.getMinutes()).padStart(2, '0');
        return `${day}.${month}.${year} ${hours}:${minutes}`;
    } catch (e) {
        return String(ts);
    }
}

async function renderHistory(): Promise<void> {
    if (!window.electronAPI || !window.electronAPI.getHistory || !historyList || !historyEmpty) return;

    const history = await window.electronAPI.getHistory();

    if (!history || history.length === 0) {
        historyList.innerHTML = '';
        historyList.appendChild(historyEmpty);
        historyEmpty.style.display = 'block';
        return;
    }

    historyEmpty.style.display = 'none';
    historyList.innerHTML = '';

    for (const item of history) {
        const card = document.createElement('div');
        card.className = 'history-card';
        card.dataset.id = item.id;

        let thumbSrc = '';
        if (item.thumbnailPath) {
            try {
                thumbSrc = 'file://' + item.thumbnailPath.replace(/\\/g, '/');
            } catch (e) {
                thumbSrc = '';
            }
        }

        const hasLink = item.status === 'uploaded' && item.finalLink;
        const hasNC = item.status === 'uploaded' && item.filePath;

        const thumbContent = item.type === 'video'
            ? (thumbSrc
                ? `<div class="history-thumb history-thumb-video"><img src="${thumbSrc}" alt="" onerror="this.outerHTML='${SVG.film}'"><div class="history-thumb-play">${SVG.film}</div></div>`
                : `<div class="history-thumb" style="background:#1a1a1a; display:flex; align-items:center; justify-content:center;">${SVG.film}</div>`)
            : `<img class="history-thumb" src="${thumbSrc}" alt="" onerror="this.style.background='#eee'">`;

        card.innerHTML = `
            ${thumbContent}
            <div class="history-info">
                <div class="history-filename">${item.filename}</div>
                <div class="history-time">${formatTimestamp(item.timestamp)}</div>
                <div class="history-status">
                    <span class="status-dot ${item.status}"></span>
                    ${STATUS_LABELS[item.status] || item.status}
                </div>
                <div class="history-actions">
                    ${hasLink ? `<button class="action-copy" data-action="copy" data-id="${item.id}">${SVG.link}Ссылка</button>` : ''}
                    ${hasNC ? `<button class="action-nc" data-action="nc" data-id="${item.id}">${SVG.cloud}Nextcloud</button>` : ''}
                    <button class="action-delete" data-action="delete" data-id="${item.id}">${SVG.x}</button>
                </div>
            </div>
        `;

        historyList.appendChild(card);
    }

    // Делегирование событий для кнопок действий
    historyList.querySelectorAll('button[data-action]').forEach(element => {
        const btn = element as HTMLButtonElement;
        btn.addEventListener('click', async (e) => {
            e.stopPropagation();
            const action = btn.dataset.action;
            const id = btn.dataset.id;
            if (!id) return;

            if (action === 'copy') {
                const result = await window.electronAPI.copyHistoryLink(id);
                if (result.success && statusLog) {
                    statusLog.innerText = 'Ссылка скопирована в буфер обмена';
                    statusLog.style.color = '#4caf50';
                }
            } else if (action === 'nc') {
                await window.electronAPI.openInNextcloud(id);
            } else if (action === 'delete') {
                await window.electronAPI.deleteHistoryItem(id);
                renderHistory();
            }
        });
    });
}

if (clearHistoryBtn) {
    clearHistoryBtn.addEventListener('click', async () => {
        await window.electronAPI.clearHistory();
        renderHistory();
    });
}

// === Запись видео ===

function formatRecTime(seconds: number): string {
    const m = Math.floor(seconds / 60);
    const s = seconds % 60;
    return String(m).padStart(2, '0') + ':' + String(s).padStart(2, '0');
}

function updateRecordingUI(state: RecordingStatePayload['state'], elapsed?: number): void {
    if (!recordingBar || !recordBtns || !recordStopBtns || !recordingStatusText || !recordingTimerText || !recordStopBtn) return;

    if (state === 'recording') {
        recordingBar.classList.add('active');
        recordingBar.classList.remove('paused');
        recordingStatusText.textContent = 'Запись';
        recordingTimerText.textContent = formatRecTime(elapsed || 0);
        recordBtns.classList.add('hidden');
        recordStopBtns.classList.remove('hidden');
        recordStopBtn.innerHTML = `${SVG.stop}Остановить запись`;
    } else if (state === 'paused') {
        recordingBar.classList.add('active', 'paused');
        recordingStatusText.textContent = 'Пауза';
        recordingTimerText.textContent = formatRecTime(elapsed || 0);
        recordBtns.classList.add('hidden');
        recordStopBtns.classList.remove('hidden');
        recordStopBtn.innerHTML = `${SVG.play}Продолжить / ${SVG.stop}Стоп`;
    } else if (state === 'stopping') {
        recordingBar.classList.add('active');
        recordingBar.classList.remove('paused');
        recordingStatusText.textContent = 'Сохранение видео...';
        recordBtns.classList.add('hidden');
        recordStopBtns.classList.add('hidden');
    } else {
        recordingBar.classList.remove('active', 'paused');
        recordBtns.classList.remove('hidden');
        recordStopBtns.classList.add('hidden');
    }
}

if (recordFullscreenBtn) {
    recordFullscreenBtn.addEventListener('click', async () => {
        await window.electronAPI.startVideoRecording();
    });
}

if (recordAreaBtn) {
    recordAreaBtn.addEventListener('click', async () => {
        await window.electronAPI.startAreaRecording();
    });
}

if (recordStopBtn) {
    recordStopBtn.addEventListener('click', async () => {
        const recState = await window.electronAPI.getRecordingState();
        if (recState.state === 'paused') {
            await window.electronAPI.togglePauseRecording();
        } else if (recState.state === 'recording') {
            await window.electronAPI.stopRecording();
        }
    });
}

if (window.electronAPI && typeof window.electronAPI.onRecordingStateChanged === 'function') {
    window.electronAPI.onRecordingStateChanged((data) => {
        updateRecordingUI(data.state, data.elapsed);
    });
}

if (window.electronAPI && typeof window.electronAPI.onRecordingTimerUpdate === 'function') {
    window.electronAPI.onRecordingTimerUpdate((seconds) => {
        if (recordingTimerText) {
            recordingTimerText.textContent = formatRecTime(seconds);
        }
    });
}

// Автообновление истории при изменениях
if (window.electronAPI && typeof window.electronAPI.onHistoryUpdated === 'function') {
    window.electronAPI.onHistoryUpdated(() => {
        if (historyTab && historyTab.classList.contains('active')) {
            renderHistory();
        }
    });
}

initForm();
