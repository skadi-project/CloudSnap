import {
    app,
    BrowserWindow,
    globalShortcut,
    Tray,
    Menu,
    ipcMain,
    safeStorage,
    clipboard,
    desktopCapturer,
    Notification,
    shell,
    nativeImage,
    dialog
} from 'electron';
import * as path from 'path';
import * as fs from 'fs';
import Store from 'electron-store';
import { execFileSync } from 'child_process';
import { uploadToNextcloud, testConnection, createPublicShare } from './src/webdav-uploader';
import {
    getDisplaySources,
    getDisplayByCursor,
    findDisplayById,
    buildCapturePayload,
    buildPickerPayload
} from './src/display-utils';
import { DEFAULT_TEMPLATE, generateFilename, generateFileId } from './src/filename-utils';
import { RecordingManager } from './src/recording-manager';

// Интерфейсы для типизации данных приложения
interface HistoryEntry {
    id: string;
    filename: string;
    type: string;
    timestamp: string;
    status: 'uploaded' | 'queued' | string;
    thumbnailPath: string | null;
    finalLink: string | null;
    filePath: string;
    serverUrl: string;
    linkMode: string;
    localPath: string | null;
}

interface QueueItem {
    id: string;
    filename: string;
    localPath: string;
}

interface WindowBoundsData {
    x: number;
    y: number;
    w: number;
    h: number;
}

const isMac = process.platform === 'darwin';
// Динамический импорт для macOS утилит
let macosUtils: any = null;
if (isMac) {
    macosUtils = require('./src/macos-utils');
}

if (!isMac) app.disableHardwareAcceleration();

const store = new Store();
let mainWindow: BrowserWindow | null = null;
let captureWindow: BrowserWindow | null = null;
let tray: Tray | null = null;
let isProcessingQueue = false;
const MAX_HISTORY = 50;
let recordingChunks: Buffer[] = [];
let quitAfterRecording = false;
let monitorPickerWindow: BrowserWindow | null = null;
let monitorPickerMode: string | null = null;
let monitorPickerResolve: ((value: any) => void) | null = null;
let cachedDisplaySources: any[] = [];
let captureDisplayId: string | number | null = null;

// === Connection Monitor ===
const RECONNECT_INTERVALS = [5, 15, 30, 60];
const HEARTBEAT_INTERVAL = 60;
let connectionMonitorTimer: NodeJS.Timeout | null = null;
let connectionState: 'connected' | 'disconnected' | 'checking' = 'connected';
let reconnectAttemptIndex = 0;
let reconnectTimer: NodeJS.Timeout | null = null;

function sendConnectionStatus(status: 'connected' | 'disconnected' | 'reconnecting' | 'checking', message: string) {
    if (mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.webContents.send('connection-status', { status, message });
    }
}

async function checkServerConnection(): Promise<boolean> {
    const url = store.get('url', '') as string;
    const login = store.get('login', '') as string;
    const encryptedPassword = store.get('password', '') as string;
    if (!url || !login || !encryptedPassword) return false;
    try {
        const password = safeStorage.decryptString(Buffer.from(encryptedPassword, 'base64'));
        const result = await testConnection(url, login, password);
        return result.success;
    } catch {
        return false;
    }
}

function startHeartbeat() {
    stopHeartbeat();
    connectionMonitorTimer = setInterval(async () => {
        const ok = await checkServerConnection();
        if (ok) {
            if (connectionState !== 'connected') {
                connectionState = 'connected';
                reconnectAttemptIndex = 0;
                stopReconnectTimer();
                sendConnectionStatus('connected', 'Соединение восстановлено');
            }
        } else {
            if (connectionState === 'connected') {
                connectionState = 'disconnected';
                reconnectAttemptIndex = 0;
                sendConnectionStatus('disconnected', 'Соединение потеряно');
                startReconnect();
            }
        }
    }, HEARTBEAT_INTERVAL * 1000);
}

function stopHeartbeat() {
    if (connectionMonitorTimer) {
        clearInterval(connectionMonitorTimer);
        connectionMonitorTimer = null;
    }
}

function startReconnect() {
    stopReconnectTimer();
    if (reconnectAttemptIndex >= RECONNECT_INTERVALS.length) {
        reconnectAttemptIndex = RECONNECT_INTERVALS.length - 1;
    }
    const delay = RECONNECT_INTERVALS[reconnectAttemptIndex];
    sendConnectionStatus('reconnecting', `Повторное соединение через ${delay} сек...`);
    reconnectTimer = setTimeout(async () => {
        const ok = await checkServerConnection();
        if (ok) {
            connectionState = 'connected';
            reconnectAttemptIndex = 0;
            stopReconnectTimer();
            sendConnectionStatus('connected', 'Соединение восстановлено');
        } else {
            reconnectAttemptIndex++;
            startReconnect();
        }
    }, delay * 1000);
}

function stopReconnectTimer() {
    if (reconnectTimer) {
        clearTimeout(reconnectTimer);
        reconnectTimer = null;
    }
}

async function initConnectionMonitor() {
    const hasPassword = store.has('password');
    if (!hasPassword) return;
    connectionState = 'checking';
    sendConnectionStatus('checking', 'Проверка соединения...');
    const ok = await checkServerConnection();
    if (ok) {
        connectionState = 'connected';
        reconnectAttemptIndex = 0;
        sendConnectionStatus('connected', 'Готово к работе.');
        startHeartbeat();
    } else {
        connectionState = 'disconnected';
        sendConnectionStatus('disconnected', 'Соединение потеряно');
        startReconnect();
    }
}

const recordingManager = new RecordingManager((state: string) => {
    if ((app as any).isQuitting) return;
    rebuildTrayMenu();
    if (mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.webContents.send('recording-state-changed', { 
            state, 
            elapsed: recordingManager.getElapsedSeconds() 
        });
    }
});

function getScreenshotsDir(): string {
    const picturesPath = app.getPath('pictures');
    const dir = path.join(picturesPath, 'CloudSnap');
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    return dir;
}

function getHistoryDir(): string {
    const dir = path.join(app.getPath('userData'), 'history');
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    return dir;
}

function generateThumbnail(buffer: Buffer, id: string): string {
    const img = nativeImage.createFromBuffer(buffer);
    const resized = img.resize({ width: 150 });
    const jpegBuf = resized.toJPEG(60);
    const thumbPath = path.join(getHistoryDir(), `${id}_thumb.jpg`);
    fs.writeFileSync(thumbPath, jpegBuf);
    return thumbPath;
}

function addToHistory(entry: HistoryEntry): void {
    const history = store.get('screenshotHistory', []) as HistoryEntry[];
    history.unshift(entry);
    if (history.length > MAX_HISTORY) {
        const removed = history.splice(MAX_HISTORY);
        for (const item of removed) {
            if (item.thumbnailPath && fs.existsSync(item.thumbnailPath)) {
                fs.unlinkSync(item.thumbnailPath);
            }
        }
    }
    store.set('screenshotHistory', history);
    if (mainWindow) mainWindow.webContents.send('history-updated');
}

function updateHistoryItem(id: string, updates: Partial<HistoryEntry>): void {
    const history = store.get('screenshotHistory', []) as HistoryEntry[];
    const idx = history.findIndex(h => h.id === id);
    if (idx >= 0) {
        Object.assign(history[idx], updates);
        store.set('screenshotHistory', history);
        if (mainWindow) mainWindow.webContents.send('history-updated');
    }
}

function getWindowBounds(): WindowBoundsData[] {
    if (isMac && macosUtils) {
        return macosUtils.getWindowBounds();
    }
    if (process.platform !== 'win32') return [];
    try {
        const script = `
Add-Type -TypeDefinition '
using System; using System.Runtime.InteropServices; using System.Text; using System.Collections.Generic;
public class WinBounds {
    [DllImport("user32.dll")] public static extern bool SetProcessDPIAware();
    [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr h);
    [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr h, out RECT r);
    [DllImport("dwmapi.dll")] public static extern int DwmGetWindowAttribute(IntPtr h, int dwAttribute, out RECT pvAttribute, int cbAttribute);
    [DllImport("user32.dll", CharSet = CharSet.Auto)] public static extern int GetWindowText(IntPtr h, StringBuilder t, int m);
    public struct RECT { public int Left; public int Top; public int Right; public int Bottom; }
    public delegate bool EnumProc(IntPtr h, int l);
    [DllImport("user32.dll")] public static extern int EnumWindows(EnumProc f, int l);
    public static string GetLines() {
        SetProcessDPIAware();
        var list = new List<string>();
        EnumWindows((hWnd, lp) => {
            StringBuilder sb = new StringBuilder(256); GetWindowText(hWnd, sb, 256);
            if (IsWindowVisible(hWnd) && sb.Length > 0) {
                RECT r;
                int dwmResult = DwmGetWindowAttribute(hWnd, 9, out r, Marshal.SizeOf(typeof(RECT)));
                if (dwmResult != 0) GetWindowRect(hWnd, out r);
                int w = r.Right - r.Left; int h = r.Bottom - r.Top;
                if (w > 100 && h > 100 && r.Right > 0 && r.Bottom > 0) {
                    list.Add(r.Left + "," + r.Top + "," + w + "," + h);
                }
            }
            return true;
        }, 0);
        return string.Join("|", list);
    }
}'; [WinBounds]::GetLines()`;

        const stdout = execFileSync('powershell.exe', ['-NoProfile', '-Command', script], { encoding: 'utf8' });
        const output = stdout.trim();
        if (!output) return [];

        return output.split('|').map(line => {
            const [x, y, w, h] = line.split(',').map(Number);
            return { x, y, w, h };
        });
    } catch (e) {
        console.error("Ошибка получения границ окон через PowerShell:", e);
        return [];
    }
}

function createMainWindow(): void {
    mainWindow = new BrowserWindow({
        width: 500,
        height: 620,
        resizable: true,
        minWidth: 450,
        minHeight: 500,
        icon: path.join(__dirname, 'icon.ico'),
        webPreferences: {
            preload: path.join(__dirname, 'preload.js'),
            contextIsolation: true,
            nodeIntegration: false
        }
    });

    mainWindow.loadFile(path.join(__dirname, 'src/ui/main-window/index.html'));
    
    mainWindow.on('close', (event) => {
        if (!(app as any).isQuitting) {
            event.preventDefault();
            mainWindow?.hide();
        }
    });
}

function showMonitorPicker(mode: string): Promise<any> {
    return new Promise((resolve) => {
        if (monitorPickerWindow) {
            monitorPickerWindow.close();
            monitorPickerWindow = null;
        }

        monitorPickerMode = mode;
        monitorPickerResolve = resolve;

        monitorPickerWindow = new BrowserWindow({
            width: 580,
            height: 420,
            center: true,
            resizable: false,
            minimizable: false,
            maximizable: false,
            title: 'CloudSnap — выбор монитора',
            icon: path.join(__dirname, 'icon.ico'),
            webPreferences: {
                preload: path.join(__dirname, 'preload.js'),
                contextIsolation: true,
                nodeIntegration: false
            }
        });

        // --- ДИНАМИЧЕСКИЕ ОБРАБОТЧИКИ IPC ---
        const onMonitorSelected = (event: any, displayId: string | number) => {
            if (monitorPickerResolve) {
                const cb = monitorPickerResolve;
                monitorPickerResolve = null;
                cb(displayId); // Возвращаем ID выбранного монитора
            }
            if (monitorPickerWindow) {
                monitorPickerWindow.close(); // Закрытие окна вызовет 'closed', где произойдет очистка
            }
        };

        const onMonitorCancel = () => {
            if (monitorPickerWindow) {
                monitorPickerWindow.close(); // Просто закрываем окно, логика отмены сработает в 'closed'
            }
        };

        // Регистрируем слушатели в ipcMain
        ipcMain.on('selectMonitor', onMonitorSelected);
        ipcMain.on('cancelMonitorPicker', onMonitorCancel);
        // -------------------------------------

        monitorPickerWindow.loadFile(path.join(__dirname, 'src/ui/monitor-picker/picker.html'));

        monitorPickerWindow.webContents.on('did-finish-load', () => {
            monitorPickerWindow?.webContents.send('displays-list', {
                mode,
                displays: buildPickerPayload(cachedDisplaySources)
            });
        });

        monitorPickerWindow.on('closed', () => {
            monitorPickerWindow = null;

            // ВАЖНО: Удаляем слушатели из ipcMain, чтобы не было утечки памяти
            ipcMain.removeListener('selectMonitor', onMonitorSelected);
            ipcMain.removeListener('cancelMonitorPicker', onMonitorCancel);

            if (monitorPickerResolve) {
                const cb = monitorPickerResolve;
                monitorPickerResolve = null;
                cb(null); // Если окно закрыли крестиком, возвращаем null
            }
        });
    });
}

async function resolveTargetDisplay(preferredDisplayId: string | number | null = null): Promise<any> {
    cachedDisplaySources = await getDisplaySources();
    if (!cachedDisplaySources.length) {
        console.error('Источники экрана не найдены');
        return null;
    }
    if (cachedDisplaySources.length === 1) {
        return cachedDisplaySources[0];
    }
    if (preferredDisplayId != null) {
        const found = findDisplayById(cachedDisplaySources, preferredDisplayId);
        if (found) return found;
    }
    return findDisplayById(cachedDisplaySources, getDisplayByCursor().id) || cachedDisplaySources[0];
}

async function pickDisplay(mode: string, preferredDisplayId: string | number | null = null): Promise<any> {
    cachedDisplaySources = await getDisplaySources();
    if (!cachedDisplaySources.length) return null;
    if (cachedDisplaySources.length === 1) return cachedDisplaySources[0];

    if (preferredDisplayId != null) {
        const found = findDisplayById(cachedDisplaySources, preferredDisplayId);
        if (found) return found;
    }

    const selectedId = await showMonitorPicker(mode);
    if (!selectedId) return null;
    return findDisplayById(cachedDisplaySources, selectedId);
}

function buildFilename(type: string, monitorIndex: number | null = null): string {
    const template = store.get('filenameTemplate', DEFAULT_TEMPLATE) as string;
    const login = store.get('login', 'user') as string;
    const now = new Date();
    return generateFilename(template, type, {
        user: login,
        monitor: monitorIndex != null ? monitorIndex + 1 : 1,
        date: now
    });
}

async function openCaptureOnDisplay(displayInfo: any): Promise<void> {
    if (!displayInfo || !displayInfo.thumbnail) return;

    const currentMode = store.get('screenshotMode', 'fullscreen') as string;
    const screenImageSrc = displayInfo.thumbnail.toDataURL();
    captureDisplayId = displayInfo.id;

    const payload = buildCapturePayload(displayInfo, screenImageSrc, currentMode, getWindowBounds()) as any;    // const payload = buildCapturePayload(
    //     displayInfo,
    //     screenImageSrc,
    //     currentMode,
    //     getWindowBounds()
    // );
    payload.displays = cachedDisplaySources.map(d => ({
        id: d.id,
        label: d.label,
        index: d.index,
        isPrimary: d.isPrimary
    }));
    payload.currentDisplayId = displayInfo.id;

    const { bounds } = displayInfo;

    if (captureWindow && !captureWindow.isDestroyed()) {
        captureWindow.setBounds({ x: bounds.x, y: bounds.y, width: bounds.width, height: bounds.height });
        captureWindow.webContents.send('capture-display-switched', payload);
        return;
    }

    captureWindow = new BrowserWindow({
        x: bounds.x,
        y: bounds.y,
        width: bounds.width,
        height: bounds.height,
        frame: false,
        transparent: true,
        backgroundColor: '#00000000',
        alwaysOnTop: true,
        skipTaskbar: true,
        webPreferences: {
            preload: path.join(__dirname, 'preload.js'),
            contextIsolation: true,
            nodeIntegration: false
        }
    });

    captureWindow.loadFile(path.join(__dirname, 'src/ui/capture-window/capture.html'));
    // captureWindow.loadFile(path.join(__dirname, 'src/ui/capture-window/capture.html'));

    captureWindow.webContents.once('did-finish-load', () =>{
        if (screenImageSrc.startsWith('data:image')) {
            captureWindow?.webContents.send('screenshot-captured', payload);
            // captureWindow?.webContents.send('screenshot-captured', payload);
        }
    });

    captureWindow.on('closed', () => {
        captureWindow = null;
        captureDisplayId = null;
    });
}

async function createCaptureWindow(preferredDisplayId: string | number | null = null): Promise<void> {
    if (captureWindow) return;

    try {
        const displayInfo = await resolveTargetDisplay(preferredDisplayId);
        if (!displayInfo) return;
        await openCaptureOnDisplay(displayInfo);
    } catch (e) {
        console.error('Критическая ошибка desktopCapturer в главном процессе:', e);
    }
}

async function createCaptureWindowWithDelay(delaySeconds: number): Promise<void> {
    if (mainWindow && mainWindow.isVisible()) {
        mainWindow.hide();
    }
    if (delaySeconds > 0) {
        new Notification({ 
            title: 'CloudSnap',
            body: `Приготовиться! Снимок экрана через ${delaySeconds} сек...`
        }).show();
        await new Promise(resolve => setTimeout(resolve, delaySeconds * 1000));
    }
    await createCaptureWindow();
}

async function processQueue(): Promise<void> {
    if (isProcessingQueue) return;

    const queue = store.get('uploadQueue', []) as QueueItem[];
    if (queue.length === 0) return;

    const serverUrl = store.get('url', '') as string;
    const login = store.get('login') as string;
    const encryptedPassword = store.get('password') as string;
    if (!encryptedPassword) return;

    if (!serverUrl || !login || !encryptedPassword) return;

    isProcessingQueue = true;
    console.log(`[Очередь] Найдено файлов для отправки: ${queue.length}`);

    const password = safeStorage.decryptString(Buffer.from(encryptedPassword, 'base64'));
    const remainingQueue: QueueItem[] = [];

    for (const item of queue) {
        try {
            if (!fs.existsSync(item.localPath)) {
                continue;
            }

            if (mainWindow) {
                mainWindow.webContents.send('status-update', `Попытка авто-догрузки: ${item.filename}`);
            }

            const buffer = fs.readFileSync(item.localPath);
            const targetUrl = getTargetUploadUrl(serverUrl);
            const result = await uploadToNextcloud(targetUrl, login, password, item.filename, buffer);

            if (result.success) {
                const saveLocalCopy = store.get('saveLocalCopy', false);
                if (saveLocalCopy) {
                    const localDir = getScreenshotsDir();
                    const localFilePath = path.join(localDir, item.filename);
                    fs.copyFileSync(item.localPath, localFilePath);
                }
                fs.unlinkSync(item.localPath);

                let finalLink = result.url;
                const linkMode = store.get('linkMode', 'internal') as string;
                if (linkMode === 'public' && result.filePath) {
                    const shareResult = await createPublicShare(serverUrl, login, password, result.filePath);
                    if (shareResult.success) finalLink = shareResult.url;
                }
                if (finalLink) {
                    clipboard.writeText(finalLink);
                }

                const historyLocalPath = saveLocalCopy ? path.join(getScreenshotsDir(), item.filename) : null;
                updateHistoryItem(item.id, {
                    status: 'uploaded', finalLink,
                    filePath: result.filePath || '', linkMode, localPath: historyLocalPath
                });

                if (mainWindow) {
                    mainWindow.webContents.send('status-update', `Успешно отправлен из очереди!\nСсылка: ${finalLink}`);
                }

                new Notification({ 
                    title: 'CloudSnap: Очередь обновлена', 
                    body: `Файл ${item.filename} успешно выгружен. Ссылка скопирована.` 
                }).show();
            } else {
                remainingQueue.push(item);
            }
        } catch (err) {
            console.error(`[Очередь] Ошибка отправки элемента ${item.filename}:`, err);
            remainingQueue.push(item);
        }
    }

    store.set('uploadQueue', remainingQueue);
    isProcessingQueue = false;
}

async function startRecordingFromTray(mode: 'fullscreen' | 'area'): Promise<void> {
    const pickerMode = mode === 'area' ? 'record-area' : 'record-fullscreen';
    const displayInfo = await pickDisplay(pickerMode);
    if (!displayInfo) return;
    if (mode === 'area') {
        await recordingManager.startAreaSelection(displayInfo);
    } else {
        await recordingManager.startFullscreen(displayInfo);
    }
}

function rebuildTrayMenu(): void {
    if (!tray || tray.isDestroyed()) return;

    const recState = recordingManager.getState();
    let recordItems: any[] = [];

    if (recState === 'idle') {
        recordItems = [
            { label: 'Записать весь экран', click: () => startRecordingFromTray('fullscreen') },
            { label: 'Записать область', click: () => startRecordingFromTray('area') }
        ];
    } else if (recState === 'recording') {
        recordItems = [
            { label: 'Пауза записи', click: () => recordingManager.pause() },
            { label: 'Остановить запись', click: () => recordingManager.stop() }
        ];
    } else if (recState === 'paused') {
        recordItems = [
            { label: 'Продолжить запись', click: () => recordingManager.resume() },
            { label: 'Остановить запись', click: () => recordingManager.stop() }
        ];
    } else if (recState === 'selecting') {
        recordItems = [
            { label: 'Отменить выбор области', click: () => recordingManager.cancelAreaSelection() }
        ];
    } else if (recState === 'stopping') {
        recordItems = [
            { label: 'Сохранение видео...', enabled: false }
        ];
    }

    const contextMenu = Menu.buildFromTemplate([
        {
            label: 'Показать настройки',
            click: () => {
                if (mainWindow) {
                    mainWindow.show();
                    mainWindow.focus();
                }
            }
        },
        { type: 'separator' },
        ...recordItems,
        { type: 'separator' },
        { label: 'Сделать снимок', click: () => createCaptureWindow() },
        { type: 'separator' },
        {
            label: 'Выйти из приложения',
            click: () => {
                (app as any).isQuitting = true;
                app.quit();
            }
        }
    ]);

    tray.setContextMenu(contextMenu);
}

function createTray(): void {
    if (isMac && macosUtils) {
        const size = 16;
        const appPath = app.getAppPath && app.getAppPath() ? app.getAppPath() : __dirname;
        const iconInfo = macosUtils.getTrayIconInfo(appPath);

        let trayImage: any = null;
        if (iconInfo.filePath) {
            try {
                trayImage = nativeImage.createFromPath(iconInfo.filePath);
                if (trayImage.isEmpty()) {
                    trayImage = null;
                }
            } catch (e) {
                trayImage = null;
            }
        }

        if (!trayImage) {
            const imgData = Buffer.alloc(size * size * 4);
            for (let y = 0; y < size; y++) {
                for (let x = 0; x < size; x++) {
                    const idx = (y * size + x) * 4;
                    const dx = x - size / 2;
                    const dy = y - size / 2;
                    const dist = Math.sqrt(dx * dx + dy * dy);
                    if (dist <= size / 2 - 1) {
                        imgData[idx] = 0;
                        imgData[idx + 1] = 0;
                        imgData[idx + 2] = 0;
                        imgData[idx + 3] = 255;
                    } else {
                        imgData[idx + 3] = 0;
                    }
                }
            }
            trayImage = nativeImage.createFromBuffer(imgData, { width: size, height: size });
        }

        tray = new Tray(trayImage.resize({ width: size, height: size }));
        tray.setTitle('CS');
    } else {
        const iconPath = path.join(__dirname, 'tray-icon.png');
        try {
            tray = new Tray(iconPath);
        } catch (e) {
            tray = new Tray(nativeImage.createEmpty());
        }
    }

    recordingManager.setTray(tray);
    rebuildTrayMenu();

    tray.setToolTip('CloudSnap');

    tray.on('double-click', () => {
        if (mainWindow) {
            mainWindow.show();
            mainWindow.focus();
        }
    });
}

function registerShortcuts(): void {
    globalShortcut.unregisterAll();

    const modifier = store.get('shortcutModifier', isMac ? 'Command+Shift' : 'Control+Shift') as string;
    const key = store.get('shortcutKey', 'A') as string;
    const screenshotShortcut = `${modifier}+${key}`;

    const defaultDelay = store.get('defaultDelay', 0) as number;

    globalShortcut.register(screenshotShortcut, () => {
        if (defaultDelay > 0) {
            createCaptureWindowWithDelay(defaultDelay);
        } else {
            createCaptureWindow();
        }
    });

    const recModifier = store.get('recordShortcutModifier', isMac ? 'Command+Shift' : 'Control+Shift') as string;
    const recKey = store.get('recordShortcutKey', 'V') as string;
    const recordShortcut = `${recModifier}+${recKey}`;

    globalShortcut.register(recordShortcut, async () => {
        const recState = recordingManager.getState();
        if (recState === 'idle') {
            const displayInfo = await resolveTargetDisplay();
            if (displayInfo) await recordingManager.startFullscreen(displayInfo);
        } else if (recState === 'recording') {
            recordingManager.pause();
        } else if (recState === 'paused') {
            recordingManager.resume();
        }
    });

    const stopModifier = store.get('stopShortcutModifier', isMac ? 'Command+Shift' : 'Control+Shift') as string;
    const stopKey = store.get('stopShortcutKey', 'S') as string;
    const stopShortcut = `${stopModifier}+${stopKey}`;

    globalShortcut.register(stopShortcut, () => {
        const recState = recordingManager.getState();
        if (recState === 'recording' || recState === 'paused') {
            recordingManager.stop();
        }
    });
}

ipcMain.handle('save-app-settings', async (event, settings: any) => {
    try {
        store.set('remoteFolder', settings.remoteFolder || '');
        store.set('folderStructure', settings.folderStructure || 'none');
        store.set('linkMode', settings.linkMode || 'internal');
        store.set('defaultDelay', settings.defaultDelay || 0);
        store.set('autoStart', settings.autoStart || false);
        store.set('startMinimized', settings.startMinimized || false);
        store.set('saveLocalCopy', settings.saveLocalCopy || false);
        store.set('videoBitrate', settings.videoBitrate || 2500000);
        store.set('recordAudio', settings.recordAudio !== undefined ? settings.recordAudio : true);
        store.set('filenameTemplate', settings.filenameTemplate || DEFAULT_TEMPLATE);
        
        store.set('shortcutModifier', settings.shortcutModifier);
        store.set('shortcutKey', settings.shortcutKey);
        store.set('recordShortcutModifier', settings.recordShortcutModifier);
        store.set('recordShortcutKey', settings.recordShortcutKey);
        store.set('stopShortcutModifier', settings.stopShortcutModifier);
        store.set('stopShortcutKey', settings.stopShortcutKey);

        registerShortcuts();
        buildAppMenu();

        if (process.platform === 'win32') {
            app.setLoginItemSettings({
                openAtLogin: settings.autoStart,
                path: app.getPath('exe')
            });
        } else if (isMac && macosUtils) {
            macosUtils.setAutoStartMacOS(settings.autoStart, app);
        }

        return { success: true };
    } catch (error: any) {
        return { success: false, error: error.message };
    }
});

ipcMain.handle('load-app-settings', async () => {
    return {
        remoteFolder: store.get('remoteFolder', ''),
        folderStructure: store.get('folderStructure', 'none'),
        linkMode: store.get('linkMode', 'internal'),
        defaultDelay: store.get('defaultDelay', 0),
        autoStart: store.get('autoStart', false),
        startMinimized: store.get('startMinimized', false),
        saveLocalCopy: store.get('saveLocalCopy', false),
        shortcutModifier: store.get('shortcutModifier', isMac ? 'Command+Shift' : 'Control+Shift'),
        shortcutKey: store.get('shortcutKey', 'A'),
        recordShortcutModifier: store.get('recordShortcutModifier', isMac ? 'Command+Shift' : 'Control+Shift'),
        recordShortcutKey: store.get('recordShortcutKey', 'V'),
        stopShortcutModifier: store.get('stopShortcutModifier', isMac ? 'Command+Shift' : 'Control+Shift'),
        stopShortcutKey: store.get('stopShortcutKey', 'S'),
        videoBitrate: store.get('videoBitrate', 2500000),
        recordAudio: store.get('recordAudio', true),
        filenameTemplate: store.get('filenameTemplate', DEFAULT_TEMPLATE)
    };
});

function buildAppMenu(): void {
    const modifier = store.get('shortcutModifier', isMac ? 'Command+Shift' : 'Control+Shift') as string;
    const key = store.get('shortcutKey', 'A') as string;
    const screenshotShortcut = `${modifier}+${key}`;

    const recModifier = store.get('recordShortcutModifier', isMac ? 'Command+Shift' : 'Control+Shift') as string;
    const recKey = store.get('recordShortcutKey', 'V') as string;
    const recordShortcut = `${recModifier}+${recKey}`;

    const stopModifier = store.get('stopShortcutModifier', isMac ? 'Command+Shift' : 'Control+Shift') as string;
    const stopKey = store.get('stopShortcutKey', 'S') as string;
    const stopShortcut = `${stopModifier}+${stopKey}`;

    const template: any[] = [
        {
            label: 'Файл',
            submenu: [
                { label: 'Сделать снимок', accelerator: screenshotShortcut, click: () => createCaptureWindow() },
                { type: 'separator' },
                { label: 'Записать экран', accelerator: recordShortcut, click: () => startRecordingFromTray('fullscreen') },
                { label: 'Записать область', click: () => startRecordingFromTray('area') },
                { type: 'separator' },
                { label: 'Скрыть в трей', accelerator: 'CmdOrCtrl+Q', click: () => { if (mainWindow) mainWindow.hide(); } }
            ]
        },
        ...(isMac ? [{
            label: 'Edit',
            submenu: [
                { role: 'undo', label: 'Undo' },
                { role: 'redo', label: 'Redo' },
                { type: 'separator' },
                { role: 'cut', label: 'Cut' },
                { role: 'copy', label: 'Copy' },
                { role: 'paste', label: 'Paste' },
                { role: 'selectAll', label: 'Select All' }
            ]
        }] : []),
        {
            label: 'Вид',
            submenu: [
                { role: 'reload', label: 'Перезагрузить' },
                { role: 'toggleDevTools', label: 'Инструменты разработчика' }
            ]
        },
        {
            label: 'Справка',
            submenu: [
                {
                    label: 'Документация CloudSnap',
                    click: () => {
                        const docsWindow = new BrowserWindow({
                            width: 800,
                            height: 600,
                            title: 'CloudSnap — Документация',
                            icon: path.join(__dirname, 'icon.ico'),
                            webPreferences: {
                                contextIsolation: true,
                                nodeIntegration: false
                            }
                        });
                        docsWindow.loadFile(path.join(__dirname, 'src/ui/docs-window/docs.html'));
                    }
                },
                {
                    label: 'Сообщить об ошибке',
                    click: () => new Notification({ title: 'CloudSnap', body: 'Обновления не найдены' }).show()
                },
                {
                    label: 'Проверить обновления',
                    click: () => new Notification({ title: 'CloudSnap', body: 'Обновления не найдены' }).show()
                },
                { type: 'separator' },
                {
                    label: 'О программе CloudSnap',
                    click: () => {
                        const aboutWindow = new BrowserWindow({
                            width: 460,
                            height: 280,
                            resizable: false,
                            minimizable: false,
                            maximizable: false,
                            title: 'О программе CloudSnap',
                            parent: mainWindow!,
                            modal: true,
                            icon: path.join(__dirname, 'icon.ico'),
                            webPreferences: {
                                contextIsolation: true,
                                nodeIntegration: false
                            }
                        });
                        aboutWindow.setMenu(null);
                        aboutWindow.loadFile(path.join(__dirname, 'src/ui/about-window/about.html'));
                    }
                }
            ]
        }
    ];

    const menu = Menu.buildFromTemplate(template);
    Menu.setApplicationMenu(menu);
}

app.whenReady().then(async () => {
    createMainWindow();
    buildAppMenu();
    createTray();
    registerShortcuts();

    const startMinimized = store.get('startMinimized', false);
    if (startMinimized) {
        const loginSettings = app.getLoginItemSettings();
        if (loginSettings.wasOpenedAtLogin && mainWindow) {
            mainWindow.hide();
        }
    }

    if (isMac && macosUtils) {
        const hasPermission = macosUtils.checkAccessibilityPermission();
        if (!hasPermission) {
            macosUtils.requestAccessibilityPermission();
            if (mainWindow) {
                mainWindow.webContents.send('status-update',
                    '⚠ Для режима «Окно» и записи области на macOS\nнеобходимо разрешить CloudSnap в Системных настройках → Универсный доступ.');
            }
        }
    }

    if (isMac) {
        try {
            const sources = await desktopCapturer.getSources({ types: ['screen'], thumbnailSize: { width: 300, height: 300 } });
            const hasEmptyThumb = sources.length > 0 && sources.every(s => {
                const size = s.thumbnail.getSize();
                return size.width === 0 || size.height === 0;
            });
            if (hasEmptyThumb || sources.length === 0) {
                macosUtils.requestScreenRecordingPermission();
                if (mainWindow) {
                    mainWindow.webContents.send('status-update',
                        '⚠ Для скриншотов и записи экрана на macOS\nнеобходимо разрешить CloudSnap в Системных настройках → Запись экрана.');
                }
            }
        } catch (e: any) {
            console.error('[macOS] Ошибка проверки Screen Recording:', e.message);
        }
    }

    recordingManager.setStore(store);
    if (mainWindow) {
        recordingManager.setMainWindow(mainWindow);
    }
    recordingManager.setGetWindowBounds(getWindowBounds);
    recordingManager.setOnBeforeStart(() => { recordingChunks = []; });

    processQueue();

    initConnectionMonitor();

    app.on('browser-window-focus', () => {
        processQueue();
    });
});

app.on('before-quit', (event) => {
    const recState = recordingManager.getState();
    if (recState === 'recording' || recState === 'paused') {
        event.preventDefault();
        quitAfterRecording = true;
        recordingManager.stop();
    } else if (recState === 'stopping') {
        event.preventDefault();
        quitAfterRecording = true;
    }
});

app.on('will-quit', () => {
    globalShortcut.unregisterAll();
    stopHeartbeat();
    stopReconnectTimer();
    recordingManager.forceStop();
});

ipcMain.handle('save-credentials', async (event, config: any) => {
    try {
        store.set('url', config.url || '');
        store.set('login', config.login || '');
        store.set('rememberMe', config.rememberMe ?? true);
        if (config.rememberMe && config.password) {
            const encryptedPassword = safeStorage.encryptString(config.password);
            store.set('password', encryptedPassword.toString('base64'));
        } else {
            store.delete('password');
            stopHeartbeat();
            stopReconnectTimer();
            connectionState = 'connected';
            return { success: true };
        }
        // Password saved — start connection monitor
        initConnectionMonitor();
        return { success: true };
    } catch (error: any) {
        return { success: false, error: error.message };
    }
});

ipcMain.handle('load-credentials', async () => {
    const encryptedPassword = store.get('password', '') as string;
    let password = '';
    if (encryptedPassword && safeStorage.isEncryptionAvailable()) {
        try {
            password = safeStorage.decryptString(Buffer.from(encryptedPassword, 'base64'));
        } catch (e) {
            console.error('Ошибка расшифровки пароля:', e);
        }
    }
    return {
        url: store.get('url', ''),
        login: store.get('login', ''),
        rememberMe: store.get('rememberMe', true),
        hasPassword: store.has('password')
    };
});

ipcMain.handle('upload-file', async (event, { fileData, type, monitorIndex }: { fileData: string, type: string, monitorIndex: number | null }) => {
    const url = store.get('url') as string;
    const login = store.get('login') as string;
    const encryptedPassword = store.get('password') as string;

    if (!url || !login || !encryptedPassword) return { success: false, error: 'Настройки не заполнены' };

    const password = safeStorage.decryptString(Buffer.from(encryptedPassword, 'base64'));
    const now = new Date();
    const filename = buildFilename(type, monitorIndex);
    const id = generateFileId(now);
    const buffer = Buffer.from(fileData, 'base64');
    const thumbnailPath = generateThumbnail(buffer, id);

    const targetUrl = getTargetUploadUrl(url);
    const result = await uploadToNextcloud(targetUrl, login, password, filename, buffer);
    if (result.success && mainWindow) {
        const linkMode = store.get('linkMode', 'internal') as string;
        let finalLink: string | null = result.url || null;
        // let finalLink = result.url;

        if (linkMode === 'public' && result.filePath) {
            const shareResult = await createPublicShare(url, login, password, result.filePath);
            if (shareResult.success) {
                finalLink = shareResult.url || null;
            }
            clipboard.writeText(finalLink || ''); // Или electron.clipboard.writeText(finalLink || ''), в зависимости от вашего импорта в начале файла
        }
        // if (linkMode === 'public' && result.filePath) {
        //     const shareResult = await createPublicShare(url, login, password, result.filePath);
        //     if (shareResult.success) {
        //         finalLink = shareResult.url;
        //     }
        // }

        clipboard.writeText(finalLink || '');
        // clipboard.writeText(finalLink);

        const localPath = store.get('saveLocalCopy', false) ? path.join(getScreenshotsDir(), filename) : null;
        if (localPath) fs.writeFileSync(localPath, buffer);

        addToHistory({
            id, filename, type, timestamp: now.toISOString(),
            status: 'uploaded', thumbnailPath, finalLink,
            filePath: result.filePath || '', serverUrl: url, linkMode, localPath
        });

        mainWindow.webContents.send('status-update', `Успех! Ссылка в буфере:\n${finalLink}`);
        return { ...result, url: finalLink };
    }

    if (!result.success) {
        const cacheDir = path.join(app.getPath('userData'), 'pending-uploads');
        if (!fs.existsSync(cacheDir)) fs.mkdirSync(cacheDir, { recursive: true });

        const localPath = path.join(cacheDir, filename);
        fs.writeFileSync(localPath, buffer);

        const queue = store.get('uploadQueue', []) as QueueItem[];
        queue.push({ filename, localPath, id });
        store.set('uploadQueue', queue);

        addToHistory({
            id, filename, type, timestamp: now.toISOString(),
            status: 'queued', thumbnailPath, finalLink: null,
            filePath: '', serverUrl: url, linkMode: store.get('linkMode', 'internal') as string, localPath: null
        });

        if (mainWindow) {
            mainWindow.webContents.send('status-update', `Ошибка сети. Файл сохранён в очередь отправки.`);
        }
    }

    return result;
});

ipcMain.handle('test-connection', async (event, config: any) => {
    const url = config.url || '';
    const login = config.login || '';
    const password = config.password || '';

    if (!url || !login || !password) {
        return { success: false, error: 'Заполните все поля' };
    }

    return await testConnection(url, login, password);
});

ipcMain.on('save-screenshot-mode', (event, mode: string) => store.set('screenshotMode', mode));
ipcMain.handle('get-screenshot-mode', () => store.get('screenshotMode', 'fullscreen'));
ipcMain.handle('set-screenshot-mode', (event, mode: string) => {
    store.set('screenshotMode', mode);
    if (mainWindow) mainWindow.webContents.send('screenshot-mode-changed', mode);
    return { success: true };
});

ipcMain.handle('trigger-delayed-capture', async (event, seconds: number) => {
    createCaptureWindowWithDelay(seconds);
    return { success: true };
});

ipcMain.handle('open-screenshots-folder', async () => {
    const dir = getScreenshotsDir();
    shell.openPath(dir);
    return { success: true };
});

ipcMain.on('monitor-selected', (event, displayId: any) => {
    if (monitorPickerWindow) {
        monitorPickerWindow.close();
        monitorPickerWindow = null;
    }
    if (monitorPickerResolve) {
        const cb = monitorPickerResolve;
        monitorPickerResolve = null;
        cb(displayId);
    }
});

ipcMain.on('monitor-picker-cancelled', () => {
    if (monitorPickerWindow) {
        monitorPickerWindow.close();
        monitorPickerWindow = null;
    }
    if (monitorPickerResolve) {
        const cb = monitorPickerResolve;
        monitorPickerResolve = null;
        cb(null);
    }
});

ipcMain.handle('switch-capture-display', async (event, displayId: any) => {
    try {
        cachedDisplaySources = await getDisplaySources();
        const displayInfo = findDisplayById(cachedDisplaySources, displayId);
        if (!displayInfo || !displayInfo.thumbnail) {
            return { success: false, error: 'Монитор не найден' };
        }
        await openCaptureOnDisplay(displayInfo);
        return { success: true };
    } catch (err: any) {
        return { success: false, error: err.message };
    }
});

ipcMain.handle('get-history', async () => {
    return store.get('screenshotHistory', []);
});

ipcMain.handle('copy-history-link', async (event, id: string) => {
    const history = store.get('screenshotHistory', []) as HistoryEntry[];
    const item = history.find(h => h.id === id);
    if (item && item.finalLink) {
        clipboard.writeText(item.finalLink);
        return { success: true };
    }
    return { success: false, error: 'Ссылка отсутствует' };
});

ipcMain.handle('open-in-nextcloud', async (event, id: string) => {
    const history = store.get('screenshotHistory', []) as HistoryEntry[];
    const item = history.find(h => h.id === id);
    if (!item || !item.filePath) return { success: false, error: 'Путь файла отсутствует' };
    const parentDir = item.filePath.substring(0, item.filePath.lastIndexOf('/') + 1);
    const urlObj = new URL(item.serverUrl);
    const ncUrl = `${urlObj.origin}/apps/files/?dir=${encodeURIComponent(parentDir)}`;
    shell.openExternal(ncUrl);
    return { success: true };
});

ipcMain.handle('delete-history-item', async (event, id: string) => {
    const history = store.get('screenshotHistory', []) as HistoryEntry[];
    const item = history.find(h => h.id === id);
    if (item && item.thumbnailPath && fs.existsSync(item.thumbnailPath)) {
        fs.unlinkSync(item.thumbnailPath);
    }
    store.set('screenshotHistory', history.filter(h => h.id !== id));
    if (mainWindow) mainWindow.webContents.send('history-updated');
    return { success: true };
});

ipcMain.handle('clear-history', async () => {
    const historyDir = getHistoryDir();
    if (fs.existsSync(historyDir)) {
        for (const file of fs.readdirSync(historyDir)) {
            fs.unlinkSync(path.join(historyDir, file));
        }
    }
    store.set('screenshotHistory', []);
    if (mainWindow) mainWindow.webContents.send('history-updated');
    return { success: true };
});

// === Запись видео: IPC-обработчики ===

ipcMain.on('recording-chunk', (event, data: any) => {
    recordingChunks.push(Buffer.from(data));
});

ipcMain.on('recording-finished', async () => {
    await processRecordingData();
});

ipcMain.on('area-selected', (event, area: any) => {
    recordingManager.confirmArea(area);
});

ipcMain.on('area-selection-cancelled', () => {
    recordingManager.cancelAreaSelection();
});

ipcMain.handle('start-video-recording', async () => {
    const displayInfo = await pickDisplay('record-fullscreen');
    if (!displayInfo) return { success: false, cancelled: true };
    await recordingManager.startFullscreen(displayInfo);
    return { success: true };
});

ipcMain.handle('start-area-recording', async () => {
    const displayInfo = await pickDisplay('record-area');
    if (!displayInfo) return { success: false, cancelled: true };
    await recordingManager.startAreaSelection(displayInfo);
    return { success: true };
});

ipcMain.handle('toggle-pause-recording', async () => {
    const state = recordingManager.getState();
    if (state === 'recording') recordingManager.pause();
    else if (state === 'paused') recordingManager.resume();
    return { success: true, state: recordingManager.getState() };
});

ipcMain.handle('stop-recording', async () => {
    recordingManager.stop();
    return { success: true };
});

ipcMain.handle('get-recording-state', async () => {
    return { state: recordingManager.getState(), elapsed: recordingManager.getElapsedSeconds() };
});

async function processRecordingData(): Promise<void> {
    if (!recordingChunks || recordingChunks.length === 0) {
        recordingManager.cleanup();
        return;
    }

    const finalBuffer = Buffer.concat(recordingChunks);
    recordingChunks = [];

    const now = new Date();
    const filename = buildFilename('video', recordingManager.getActiveDisplayIndex());
    const id = generateFileId(now);

    const tempDir = path.join(app.getPath('userData'), 'temp');
    if (!fs.existsSync(tempDir)) fs.mkdirSync(tempDir, { recursive: true });
    const tempPath = path.join(tempDir, filename);
    fs.writeFileSync(tempPath, finalBuffer);

    const saveLocalCopy = store.get('saveLocalCopy', false);
    let localPath: string | null = null;
    if (saveLocalCopy) {
        localPath = path.join(getScreenshotsDir(), filename);
        fs.copyFileSync(tempPath, localPath);
    }

    const url = store.get('url', '') as string;
    const login = store.get('login', '') as string;
    const encryptedPassword = store.get('password') as string;
    let finalLink: string | null = null;
    let uploadStatus = 'queued';
    let filePath = '';

    if (url && login && encryptedPassword) {
        try {
            const password = safeStorage.decryptString(Buffer.from(encryptedPassword, 'base64'));
            const targetUrl = getTargetUploadUrl(url);
            const result = await uploadToNextcloud(targetUrl, login, password, filename, finalBuffer);

            if (result.success) {
                uploadStatus = 'uploaded';
                finalLink = result.url || null; // Превращаем undefined в null
                filePath = result.filePath || '';
                const linkMode = store.get('linkMode', 'internal');
                if (linkMode === 'public' && filePath) {
                    const shareResult = await createPublicShare(url, login, password, filePath);
                    if (shareResult.success) {
                        finalLink = shareResult.url || null;
                    }    
                    clipboard.writeText(finalLink || '');}
            } else {
            // if (result.success) {
            //     uploadStatus = 'uploaded';
            //     finalLink = result.url;
            //     filePath = result.filePath || '';

            //     const linkMode = store.get('linkMode', 'internal') as string;
            //     if (linkMode === 'public' && filePath) {
            //         const shareResult = await createPublicShare(url, login, password, filePath);
            //         if (shareResult.success) finalLink = shareResult.url;
            //     }
            //     clipboard.writeText(finalLink);
            // } else {
                const cacheDir = path.join(app.getPath('userData'), 'pending-uploads');
                if (!fs.existsSync(cacheDir)) fs.mkdirSync(cacheDir, { recursive: true });
                const queuePath = path.join(cacheDir, filename);
                fs.writeFileSync(queuePath, finalBuffer);
                const queue = store.get('uploadQueue', []) as QueueItem[];
                queue.push({ filename, localPath: queuePath, id });
                store.set('uploadQueue', queue);
            }
        } catch (err) {
            console.error('Upload video error:', err);
            const cacheDir = path.join(app.getPath('userData'), 'pending-uploads');
            if (!fs.existsSync(cacheDir)) fs.mkdirSync(cacheDir, { recursive: true });
            const queuePath = path.join(cacheDir, filename);
            fs.writeFileSync(queuePath, finalBuffer);
            const queue = store.get('uploadQueue', []) as QueueItem[];
            queue.push({ filename, localPath: queuePath, id });
            store.set('uploadQueue', queue);
        }
    }

    addToHistory({
        id, filename, type: 'video',
        timestamp: now.toISOString(),
        status: uploadStatus,
        thumbnailPath: null,
        finalLink,
        filePath,
        serverUrl: url,
        linkMode: store.get('linkMode', 'internal') as string,
        localPath
    });

    try { fs.unlinkSync(tempPath); } catch {}

    if (uploadStatus === 'uploaded') {
        new Notification({ title: 'CloudSnap: Видео сохранено', body: `Ссылка скопирована в буфер обмена` }).show();
        if (mainWindow) mainWindow.webContents.send('status-update', `Видео отправлено!\nСсылка: ${finalLink}`);
    } else {
        new Notification({ title: 'CloudSnap', body: `Видео сохранено в очередь отправки` }).show();
        if (mainWindow) mainWindow.webContents.send('status-update', `Видео в очереди отправки.`);
    }

    recordingManager.cleanup();

    if (quitAfterRecording) {
        quitAfterRecording = false;
        (app as any).isQuitting = true;
        app.quit();
    }
}

function getTargetUploadUrl(baseUrl: string): string {
    const remoteFolder = (store.get('remoteFolder', '') as string).trim();
    const folderStructure = store.get('folderStructure', 'none') as string;

    if (!remoteFolder) return baseUrl;

    const cleanBase = baseUrl.endsWith('/') ? baseUrl.slice(0, -1) : baseUrl;
    const cleanFolder = remoteFolder.startsWith('/') ? remoteFolder.slice(1) : remoteFolder;

    let pathParts = cleanFolder.split('/').filter(Boolean);

    if (folderStructure === 'date') {
        const now = new Date();
        const yearMonth = now.toISOString().slice(0, 7);
        const day = now.toISOString().slice(8, 10);
        pathParts = [...pathParts, yearMonth, day];
    } else if (folderStructure === 'user') {
        const login = store.get('login', 'unknown') as string;
        pathParts = [...pathParts, login];
    }

    const encodedPath = pathParts.map(p => encodeURIComponent(p)).join('/');

    let finalUrl = `${cleanBase}/${encodedPath}`;
    if (!finalUrl.endsWith('/')) finalUrl += '/';

    return finalUrl;
}