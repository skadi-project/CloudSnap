/**
 * Главное окно приложения (настройки + история). Заменяет функцию
 * createMainWindow из старого main.ts.
 *
 * Хранит ссылку на окно в модульной переменной и предоставляет геттер
 * для других модулей (tray, monitor picker, etc.) — setter-инъекция
 * позволяет обойтись без circular deps.
 */

import { app, BrowserWindow } from 'electron';
import * as path from 'path';

let mainWindow: BrowserWindow | null = null;

export interface CreateMainWindowOptions {
    /**
     * Если true — окно создаётся со `show: false` и НЕ показывается до явного
     * вызова `mainWindow.show()` (например, из трея). Используется при
     * автозапуске: «Запускать при старте системы» + «Свернуть в трей».
     * Без этого флага окно на мгновение «вспыхивает» на экране при загрузке ОС.
     */
    startHidden?: boolean;
}

export function createMainWindow(opts: CreateMainWindowOptions = {}): BrowserWindow {
    const startHidden = !!opts.startHidden;

    mainWindow = new BrowserWindow({
        width: 500,
        height: 620,
        resizable: true,
        minWidth: 450,
        minHeight: 500,
        icon: path.join(__dirname, '..', '..', '..', 'icon.ico'),
        show: !startHidden,
        // Разрешаем рендереру работать, даже если окно скрыто — иначе
        // IPC-канал connection-status может прилететь до того, как рендерер
        // зарегистрирует слушатель, и событие потеряется.
        paintWhenInitiallyHidden: true,
        webPreferences: {
            preload: path.join(__dirname, '..', '..', '..', 'preload.js'),
            contextIsolation: true,
            nodeIntegration: false
        }
    });

    mainWindow.loadFile(path.join(__dirname, '..', '..', 'ui', 'main-window', 'index.html'));

    mainWindow.on('close', (event) => {
        if (!(app as any).isQuitting) {
            event.preventDefault();
            mainWindow?.hide();
        }
    });

    return mainWindow;
}

export function getMainWindow(): BrowserWindow | null {
    return mainWindow;
}

export function setMainWindow(win: BrowserWindow | null): void {
    mainWindow = win;
}