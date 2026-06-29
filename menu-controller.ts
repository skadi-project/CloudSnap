/**
 * Главное меню приложения. Вызывается из buildAppMenu(), обновляется
 * при изменении настроек (вызов registerShortcuts внутри save-app-settings).
 *
 * Также экспортирует переиспользуемые хелперы `runUpdateCheck()` и
 * `openAboutWindow()` — ими пользуется контекстное меню трея, чтобы
 * избежать дублирования логики.
 */

import { app, BrowserWindow, ipcMain, Menu, Notification, shell } from 'electron';
import * as path from 'path';
import Store from 'electron-store';
import { checkForUpdates } from './update-checker';

const isMac = process.platform === 'darwin';

let store: Store | null = null;
let mainWindowGetter: () => BrowserWindow | null = () => null;
let createCaptureWindowFn: () => Promise<void> = async () => {};
let startRecordingFromTrayFn: (mode: 'fullscreen' | 'area') => Promise<void> = async () => {};

/**
 * Переиспользуемый обработчик «Проверить обновления»:
 * показывает уведомление о начале проверки, по результату выдаёт
 * ошибку / редирект на страницу релиза / сообщение об актуальной версии.
 */
export async function runUpdateCheck(): Promise<void> {
    new Notification({
        title: 'CloudSnap',
        body: 'Проверка обновлений…'
    }).show();

    const result = await checkForUpdates();

    if (result.error) {
        new Notification({
            title: 'CloudSnap — ошибка обновления',
            body: `Не удалось проверить обновления: ${result.error}`
        }).show();
        return;
    }

    if (result.hasUpdate) {
        // Сразу открываем страницу релиза в системном браузере.
        void shell.openExternal(result.releaseUrl);
        new Notification({
            title: 'Доступно обновление CloudSnap',
            body: `Установлена ${result.currentVersion}, доступна ${result.latestVersion}. Открываю страницу загрузки…`
        }).show();
    } else {
        new Notification({
            title: 'CloudSnap актуален',
            body: `Установлена актуальная версия ${result.currentVersion}. Обновлений нет.`
        }).show();
    }
}

/**
 * Переиспользуемый обработчик «О программе»:
 * открывает независимое окно «О программе» — НЕ модальное и без
 * привязки к parent, чтобы оно вело себя как обычное окно ОС со
 * своим набором стандартных кнопок управления (закрыть/свернуть/
 * развернуть на Windows, traffic lights на macOS) и не блокировало
 * взаимодействие с главным окном. Если такое окно уже открыто —
 * фокусирует его, а не плодит дубликаты.
 */
let aboutWindowRef: BrowserWindow | null = null;

let ipcAboutCloseRegistered = false;

export function openAboutWindow(): void {
    if (!ipcAboutCloseRegistered) {
        ipcMain.on('about-window:close', (event) => {
            const senderWindow = BrowserWindow.fromWebContents(event.sender);
            senderWindow?.close();
        });
        ipcAboutCloseRegistered = true;
    }

    // Используем явную ссылку на окно вместо поиска по заголовку:
    // после loadFile() заголовок может быть переопределён содержимым
    // about.html, и поиск по getTitle() перестаёт находить окно —
    // из-за этого на повторных вызовах мог создаваться ещё один
    // инстанс окна вместо фокусировки уже открытого.
    if (aboutWindowRef && !aboutWindowRef.isDestroyed()) {
        aboutWindowRef.show();
        aboutWindowRef.focus();
        return;
    }

    const aboutWindow = new BrowserWindow({
        width: 440,
        height: 230,
        resizable: false,
        // minimizable оставлен включённым (по умолчанию true), чтобы
        // окно вело себя как полноценное независимое окно со всеми
        // стандартными кнопками управления, включая «свернуть».
        maximizable: false,
        closable: true,
        title: 'О программе CloudSnap',
        // Без parent и modal — окно полностью независимо: не блокирует
        // главное окно, не превращается в sheet на macOS и получает
        // обычный titlebar с полным набором traffic-light кнопок.
        titleBarStyle: 'default',
        icon: path.join(__dirname, '..', '..', '..', 'icon.ico'),
        webPreferences: {
            contextIsolation: true,
            nodeIntegration: false,
            preload: path.join(__dirname, '..', '..', 'ui', 'about-window', 'about-preload.js')
        }
    });

    aboutWindowRef = aboutWindow;
    aboutWindow.on('closed', () => {
        if (aboutWindowRef === aboutWindow) {
            aboutWindowRef = null;
        }
    });
    // Открывать внешние ссылки (GitHub/Telegram) в системном браузере,
    // а не внутри окна about-window или в новом окне Electron.
    aboutWindow.webContents.setWindowOpenHandler(({ url }) => {
        if (/^https?:\/\//i.test(url)) {
            void shell.openExternal(url);
        }
        return { action: 'deny' };
    });
    // Страховка: если ссылка всё-таки триггерит обычную навигацию
    // (например, target="_self" или открытие в том же webContents),
    // тоже открываем её в системном браузере.
    aboutWindow.webContents.on('will-navigate', (event, url) => {
        if (/^https?:\/\//i.test(url)) {
            event.preventDefault();
            void shell.openExternal(url);
        }
    });
    aboutWindow.setMenu(null);
    aboutWindow.loadFile(path.join(__dirname, '..', '..', 'ui', 'about-window', 'about.html'));
}

export function setMenuStore(s: Store): void { store = s; }
export function setMenuMainWindowGetter(fn: () => BrowserWindow | null): void {
    mainWindowGetter = fn;
}
export function setMenuCreateCaptureWindow(fn: () => Promise<void>): void {
    createCaptureWindowFn = fn;
}
export function setMenuStartRecordingFromTray(fn: (mode: 'fullscreen' | 'area') => Promise<void>): void {
    startRecordingFromTrayFn = fn;
}

export function buildAppMenu(): void {
    if (!store) return;

    const modifier = store.get('shortcutModifier', isMac ? 'Command+Shift' : 'Control+Shift') as string;
    const key = store.get('shortcutKey', 'A') as string;
    const screenshotShortcut = `${modifier}+${key}`;

    const recModifier = store.get('recordShortcutModifier', isMac ? 'Command+Shift' : 'Control+Shift') as string;
    const recKey = store.get('recordShortcutKey', 'V') as string;
    const recordShortcut = `${recModifier}+${recKey}`;

    const template: any[] = [
        {
            label: 'Файл',
            submenu: [
                { label: 'Сделать снимок', accelerator: screenshotShortcut, click: () => createCaptureWindowFn() },
                { type: 'separator' },
                { label: 'Записать экран', accelerator: recordShortcut, click: () => startRecordingFromTrayFn('fullscreen') },
                { label: 'Записать область', click: () => startRecordingFromTrayFn('area') },
                { type: 'separator' },
                { label: 'Скрыть в трей', accelerator: 'CmdOrCtrl+Q', click: () => { const w = mainWindowGetter(); if (w) w.hide(); } }
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
                            icon: path.join(__dirname, '..', '..', '..', 'icon.ico'),
                            webPreferences: {
                                contextIsolation: true,
                                nodeIntegration: false
                            }
                        });
                        docsWindow.loadFile(path.join(__dirname, '..', '..', 'ui', 'docs-window', 'docs.html'));
                    }
                },
                {
                    label: 'Сообщить об ошибке',
                    click: () => { void shell.openExternal('https://github.com/skadi-project/CloudSnap/issues'); }
                },
                {
                    label: 'Проверить обновления',
                    click: () => { void runUpdateCheck(); }
                },
                { type: 'separator' },
                {
                    label: 'О программе CloudSnap',
                    click: () => openAboutWindow()
                }
            ]
        }
    ];

    const menu = Menu.buildFromTemplate(template);
    Menu.setApplicationMenu(menu);
}