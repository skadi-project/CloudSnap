/**
 * Точка входа main-процесса Electron.
 *
 * Заменяет монолитный src/main.ts (~1800 строк). Разбит на модули в Фазе 2.1:
 *   - src/main/config.ts          — константы
 *   - src/main/types.ts           — общие типы
 *   - src/main/logging.ts         — логгер
 *   - src/main/security.ts        — валидация URL, magic bytes, decrypt
 *   - src/main/store.ts           — (зарезервировано для typed wrapper)
 *   - src/main/services/          — connection-monitor, upload-orchestrator,
 *                                   tray-controller, shortcut-controller,
 *                                   menu-controller, recording-controller
 *   - src/main/windows/           — main-window, monitor-picker, capture-window
 *   - src/main/ipc/               — credentials, upload, capture, recording,
 *                                   history, settings, index
 *   - src/recording/recording-manager.ts
 *   - src/webdav/uploader.ts, share.ts
 *
 * Здесь только оркестрация: создание объектов, инъекция зависимостей,
 * регистрация IPC и обработчиков lifecycle.
 */

import { app, globalShortcut, screen } from 'electron';
import * as path from 'path';
import Store from 'electron-store';

import { RecordingManager } from '../recording/recording-manager';
import {
    ElectronNotifier,
    ElectronDisplaySource,
    ElectronBrowserWindowFactory,
    wrapBrowserWindow
} from '../recording/electron-adapters';
import { generateFileId } from '../filename-utils';

import {
    createMainWindow,
    getMainWindow,
    setMainWindow
} from './windows/main-window';
import {
    createCaptureWindow,
    createCaptureWindowWithDelay,
    attachDisplayChangeListeners,
    warmupDisplayCache,
    checkMacOSPermissions,
    pickDisplay,
    resolveTargetDisplay,
    buildFilename,
    getCachedDisplaySources
} from './windows/capture-window';
import { setDisplaySourcesGetter } from './windows/monitor-picker';

import {
    buildAppMenu
} from './services/menu-controller';
import {
    createTray,
    rebuildTrayMenu
} from './services/tray-controller';
import {
    registerShortcuts
} from './services/shortcut-controller';
import {
    initConnectionMonitor,
    stopHeartbeat,
    stopReconnectTimer
} from './services/connection-monitor';
import {
    processQueue
} from './services/upload-orchestrator';
import {
    setUploadStore,
    setUploadMainWindowGetter,
    setBuildFilename
} from './services/upload-orchestrator';
import {
    setShortcutStore,
    setShortcutCreateCaptureWindow,
    setShortcutCreateCaptureWindowWithDelay,
    setShortcutStartRecordingFromTray,
    setShortcutStartRecordingFromHotkey,
    setShortcutStopRecording,
    setShortcutTogglePause,
    setShortcutGetRecordingState
} from './services/shortcut-controller';
import {
    setMenuStore,
    setMenuMainWindowGetter,
    setMenuCreateCaptureWindow,
    setMenuStartRecordingFromTray,
    runUpdateCheck,
    openAboutWindow
} from './services/menu-controller';
import {
    setTrayMainWindowGetter,
    setTrayRecordingManagerGetter,
    setTrayCaptureWindowFn,
    setTrayStartRecordingFn,
    setTrayUpdateCheckFn,
    setTrayOpenAboutWindowFn
} from './services/tray-controller';
import {
    setConnectionStore,
    setConnectionMainWindowGetter
} from './services/connection-monitor';
import {
    setCaptureStore,
    setScreenshotT0Getter,
    setScreenshotT0Setter,
    setCaptureMainWindowGetter,
    setGetWindowBoundsFn
} from './windows/capture-window';
import { getWindowBoundsUniversal } from './services/window-bounds';
import {
    setRecordingStore,
    setRecordingManagerGetter,
    setRecordingMainWindowGetter,
    setRecordingT0Getter,
    setQuitAfterRecordingRef,
    setRecordingBuildFilename,
    startNewRecordingSession,
    resetRecordingSession,
    registerRecordingIpc
} from './ipc/recording';
import {
    setRecordingManagerGetter as setRcRecordingManagerGetter,
    setPickDisplayFn,
    setResolveTargetDisplayFn
} from './services/recording-controller';
import {
    startRecordingFromTray,
    startRecordingFromHotkey,
    stopRecording,
    togglePause,
    getRecordingState
} from './services/recording-controller';
import {
    registerAllIpcHandlers
} from './ipc';

const isMac = process.platform === 'darwin';

if (!isMac) app.disableHardwareAcceleration();

// === Глобальное состояние для index.ts ===
let screenshotT0 = 0;
let recordingT0 = 0;
const quitAfterRecordingRef: { value: boolean } = { value: false };

// === Recording Manager ===

const recordingManager = new RecordingManager((state: string) => {
    if ((app as any).isQuitting) return;
    rebuildTrayMenu();
    const win = getMainWindow();
    if (win && !win.isDestroyed()) {
        win.webContents.send('recording-state-changed', {
            state,
            elapsed: recordingManager.getElapsedSeconds()
        });
    }
}, {
    notifier: new ElectronNotifier(),
    displaySource: new ElectronDisplaySource(),
    windowFactory: new ElectronBrowserWindowFactory()
});

// === Store ===

const store = new Store();

// === Dependency injection ===

function wireDependencies(): void {
    // Store
    setUploadStore(store);
    setConnectionStore(store);
    setCaptureStore(store);
    setShortcutStore(store);
    setMenuStore(store);
    setRecordingStore(store);

    // Main window getter
    const mainGetter = () => getMainWindow();
    setConnectionMainWindowGetter(mainGetter);
    setUploadMainWindowGetter(mainGetter);
    setCaptureMainWindowGetter(mainGetter);
    setMenuMainWindowGetter(mainGetter);
    setTrayMainWindowGetter(mainGetter);
    setRecordingMainWindowGetter(mainGetter);
    setDisplaySourcesGetter(() => getCachedDisplaySources());

    // Recording manager
    const rmGetter = () => recordingManager;
    setTrayRecordingManagerGetter(rmGetter);
    setRcRecordingManagerGetter(rmGetter);
    setRecordingManagerGetter(rmGetter);

    // Capture / recording orchestration
    setPickDisplayFn(pickDisplay);
    setResolveTargetDisplayFn(resolveTargetDisplay);
    setScreenshotT0Getter(() => screenshotT0);
    setScreenshotT0Setter((v) => { screenshotT0 = v; });
    setRecordingT0Getter(() => recordingT0);

    // Filename
    setBuildFilename(buildFilename);
    setRecordingBuildFilename(buildFilename);

    // Shortcut wiring
    setShortcutCreateCaptureWindow(() => createCaptureWindow());
    setShortcutCreateCaptureWindowWithDelay((delay) => createCaptureWindowWithDelay(delay));
    setShortcutStartRecordingFromTray(startRecordingFromTray);
    setShortcutStartRecordingFromHotkey(startRecordingFromHotkey);
    setShortcutStopRecording(stopRecording);
    setShortcutTogglePause(togglePause);
    setShortcutGetRecordingState(getRecordingState);

    // Menu wiring
    setMenuCreateCaptureWindow(() => createCaptureWindow());
    setMenuStartRecordingFromTray(startRecordingFromTray);

    // Tray wiring
    setTrayCaptureWindowFn(() => createCaptureWindow());
    setTrayStartRecordingFn(startRecordingFromTray);
    // Хелперы из menu-controller — для пунктов в контекстном меню трея.
    setTrayUpdateCheckFn(() => runUpdateCheck());
    setTrayOpenAboutWindowFn(() => openAboutWindow());

    // Quit-after-recording flag
    setQuitAfterRecordingRef(quitAfterRecordingRef);
}

// === Window bounds helper (для selector / window-mode) ===

/**
 * Делегирует в платформо-зависимую реализацию:
 *  - Windows: PowerShell + EnumWindows/GetWindowRect (физические координаты)
 *  - macOS:   JXA/AppleScript (логические координаты)
 *  - Linux:   [] — desktopCapturer всё равно даст sourceId по клику
 *
 * Используется:
 *  - RecordingManager.startAreaSelection — для подсветки окна под курсором
 *    в area-selector (выбор области записи)
 *  - capture-window.openCaptureOnDisplay — для подсветки окон в режиме
 *    «Окно» и для per-window capture через desktopCapturer
 */
function getWindowBounds() {
    return getWindowBoundsUniversal();
}

// === App lifecycle ===

app.whenReady().then(async () => {
    // IPC handlers нужно регистрировать ДО createMainWindow(): рендерер
    // может слать IPC сразу после загрузки страницы (load-credentials,
    // get-history и т.п.), и если обработчиков ещё нет — получаем
    // "No handler registered for ...".
    // registerAllIpcHandlers внутри сам вызывает registerRecordingIpc(),
    // так что отдельный вызов НЕ нужен (иначе — "Attempted to register
    // a second handler for 'start-video-recording'").
    registerAllIpcHandlers({
        store,
        getMainWindow,
        buildFilename
    });

    wireDependencies();

    setGetWindowBoundsFn(getWindowBounds);

    // Старт в свёрнутом виде
    // Решение о скрытии принимается ДО createMainWindow, чтобы окно
    // создавалось сразу с show: false (без «вспышки» на экране при загрузке ОС).
    // Ориентируемся на два независимых признака автозапуска:
    //   1) process.argv содержит --hidden (Windows: передаётся в args у
    //      setLoginItemSettings в src/main/ipc/settings.ts).
    //   2) app.getLoginItemSettings().wasOpenedAtLogin (на macOS — флаг
    //      openAsHidden; на Linux — зависит от .desktop-файла).
    // Если оба не сработали, окно откроется нормально, как и при ручном запуске.
    const startMinimized = !!store.get('startMinimized', false);
    const launchedWithHiddenFlag = process.argv.some((a) => a === '--hidden');
    const loginSettings = app.getLoginItemSettings();
    const launchedAtLogin = !!loginSettings.wasOpenedAtLogin;
    const shouldStartHidden = startMinimized && (launchedWithHiddenFlag || launchedAtLogin);

    // Главное окно
    createMainWindow({ startHidden: shouldStartHidden });

    // Передаём recordingManager в RecordingManager.setGetWindowBounds и т.п.
    recordingManager.setStore(store);
    const mainWin = getMainWindow();
    if (mainWin) recordingManager.setMainWindow(wrapBrowserWindow(mainWin));
    recordingManager.setGetWindowBounds(getWindowBounds);
    recordingManager.setOnBeforeStart(() => {
        return startNewRecordingSession();
    });

    // Меню и трей
    buildAppMenu();
    createTray();
    registerShortcuts();

    // На случай, если на платформе сработал только wasOpenedAtLogin, но не
    // --hidden — дополнительно гарантируем скрытие. При shouldStartHidden
    // окно уже создано скрытым, hide() — no-op, безвредно.
    if (shouldStartHidden && mainWin && mainWin.isVisible()) {
        mainWin.hide();
    }

    // macOS permissions
    await checkMacOSPermissions();

    // Display cache listeners + warmup
    attachDisplayChangeListeners();
    warmupDisplayCache();

    // Queue + connection monitor
    processQueue();
    await initConnectionMonitor();

    app.on('browser-window-focus', () => {
        processQueue();
    });
});

app.on('before-quit', (event) => {
    const recState = recordingManager.getState();
    if (recState === 'recording' || recState === 'paused') {
        event.preventDefault();
        quitAfterRecordingRef.value = true;
        recordingManager.stop();
    } else if (recState === 'stopping') {
        event.preventDefault();
        quitAfterRecordingRef.value = true;
    }
});

app.on('will-quit', () => {
    globalShortcut.unregisterAll();
    stopHeartbeat();
    stopReconnectTimer();
    recordingManager.forceStop();
    resetRecordingSession();
});

// Экспорт для unit-тестов
export { store, recordingManager };