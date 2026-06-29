/**
 * Трей: создание иконки + контекстное меню. Меню перестраивается при смене
 * состояния записи (вызывает rebuildTrayMenu из recordingManager.onStateChange).
 *
 * Зависимости (recordingManager, mainWindow, captureWindow, recording entry
 * points) передаются через setters, чтобы избежать циклов.
 */

import { app, BrowserWindow, Menu, nativeImage, Tray } from 'electron';
import * as path from 'path';

const isMac = process.platform === 'darwin';
let macosUtils: any = null;
if (isMac) {
    // Загружаем динамически, чтобы не тянуть на других платформах
    try {
        macosUtils = require('../../macos-utils');
    } catch (e) {
        console.warn('Failed to load macos-utils:', e);
    }
}

let tray: Tray | null = null;
let mainWindowGetter: () => BrowserWindow | null = () => null;
let recordingManagerGetter: () => any = () => null;
let createCaptureWindowFn: () => Promise<void> = async () => {};
let startRecordingFromTrayFn: (mode: 'fullscreen' | 'area') => Promise<void> = async () => {};
let recordingController: any = null;
// Хелперы из menu-controller — чтобы не дублировать UI-логику
// (используются пунктами «Проверить обновления» и «О программе» в
// контекстном меню трея).
let runUpdateCheckFn: () => Promise<void> = async () => {};
let openAboutWindowFn: () => void = () => {};

export function setTrayMainWindowGetter(fn: () => BrowserWindow | null): void {
    mainWindowGetter = fn;
}
export function setTrayRecordingManagerGetter(fn: () => any): void {
    recordingManagerGetter = fn;
}
export function setTrayCaptureWindowFn(fn: () => Promise<void>): void {
    createCaptureWindowFn = fn;
}
export function setTrayStartRecordingFn(fn: (mode: 'fullscreen' | 'area') => Promise<void>): void {
    startRecordingFromTrayFn = fn;
}
/** Регистрирует модуль recording-controller целиком (для hotkey-toggle записи). */
export function setTrayRecordingController(rc: any): void {
    recordingController = rc;
}
/** Регистрирует хелпер проверки обновлений из menu-controller. */
export function setTrayUpdateCheckFn(fn: () => Promise<void>): void {
    runUpdateCheckFn = fn;
}
/** Регистрирует хелпер «О программе» из menu-controller. */
export function setTrayOpenAboutWindowFn(fn: () => void): void {
    openAboutWindowFn = fn;
}

export function getTray(): Tray | null {
    return tray;
}

export function rebuildTrayMenu(): void {
    if (!tray || tray.isDestroyed()) return;

    const recState: string = recordingManagerGetter()?.getState?.() ?? 'idle';
    let recordItems: any[] = [];

    if (recState === 'idle') {
        recordItems = [
            { label: 'Записать весь экран', click: () => startRecordingFromTrayFn('fullscreen') },
            { label: 'Записать область', click: () => startRecordingFromTrayFn('area') }
        ];
    } else if (recState === 'recording') {
        recordItems = [
            { label: 'Пауза записи', click: () => recordingManagerGetter()?.pause?.() },
            { label: 'Остановить запись', click: () => recordingManagerGetter()?.stop?.() }
        ];
    } else if (recState === 'paused') {
        recordItems = [
            { label: 'Продолжить запись', click: () => recordingManagerGetter()?.resume?.() },
            { label: 'Остановить запись', click: () => recordingManagerGetter()?.stop?.() }
        ];
    } else if (recState === 'selecting') {
        recordItems = [
            { label: 'Отменить выбор области', click: () => recordingManagerGetter()?.cancelAreaSelection?.() }
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
                const win = mainWindowGetter();
                if (win) {
                    win.show();
                    win.focus();
                }
            }
        },
        { type: 'separator' },
        ...recordItems,
        { type: 'separator' },
        { label: 'Сделать снимок', click: () => createCaptureWindowFn() },
        { type: 'separator' },
        {
            label: 'Проверить обновления',
            click: () => { void runUpdateCheckFn(); }
        },
        {
            label: 'О программе CloudSnap',
            click: () => openAboutWindowFn()
        },
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

export function createTray(): void {
    if (isMac && macosUtils) {
        const size = 16;
        const appPath = app.getAppPath && app.getAppPath() ? app.getAppPath() : __dirname;
        const iconInfo = macosUtils.getTrayIconInfo(appPath);

        let trayImage: any = null;
        if (iconInfo.filePath) {
            try {
                trayImage = nativeImage.createFromPath(iconInfo.filePath);
                if (trayImage.isEmpty()) trayImage = null;
            } catch {
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
        const iconPath = path.join(__dirname, '..', '..', '..', 'tray-icon.png');
        try {
            tray = new Tray(iconPath);
        } catch {
            tray = new Tray(nativeImage.createEmpty());
        }
    }

    const rm = recordingManagerGetter();
    if (rm && typeof rm.setTray === 'function') rm.setTray(tray);

    rebuildTrayMenu();
    tray!.setToolTip('CloudSnap');

    tray!.on('double-click', () => {
        const win = mainWindowGetter();
        if (win) {
            win.show();
            win.focus();
        }
    });
}