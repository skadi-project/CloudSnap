/**
 * Окно выбора монитора. Используется для capture и recording, когда
 * у пользователя несколько дисплеев.
 *
 * Динамически регистрирует IPC-обработчики для selectMonitor и
 * cancelMonitorPicker — после закрытия окна слушатели снимаются, чтобы
 * не было утечек.
 */

import { BrowserWindow, ipcMain } from 'electron';
import * as path from 'path';
import { buildPickerPayload } from '../../display-utils';

let monitorPickerWindow: BrowserWindow | null = null;
let monitorPickerResolve: ((value: any) => void) | null = null;

let getCachedDisplaySourcesFn: () => any[] = () => [];

export function setDisplaySourcesGetter(fn: () => any[]): void {
    getCachedDisplaySourcesFn = fn;
}

export function showMonitorPicker(mode: string): Promise<any> {
    return new Promise((resolve) => {
        if (monitorPickerWindow) {
            monitorPickerWindow.close();
            monitorPickerWindow = null;
        }

        monitorPickerResolve = resolve;

        monitorPickerWindow = new BrowserWindow({
            width: 580,
            height: 420,
            center: true,
            resizable: false,
            minimizable: false,
            maximizable: false,
            title: 'CloudSnap — выбор монитора',
            icon: path.join(__dirname, '..', '..', '..', 'icon.ico'),
            webPreferences: {
                preload: path.join(__dirname, '..', '..', '..', 'preload.js'),
                contextIsolation: true,
                nodeIntegration: false
            }
        });

        const onMonitorSelected = (_event: any, displayId: string | number) => {
            if (monitorPickerResolve) {
                const cb = monitorPickerResolve;
                monitorPickerResolve = null;
                cb(displayId);
            }
            if (monitorPickerWindow) {
                monitorPickerWindow.close();
            }
        };

        const onMonitorCancel = () => {
            if (monitorPickerWindow) {
                monitorPickerWindow.close();
            }
        };

        ipcMain.on('selectMonitor', onMonitorSelected);
        ipcMain.on('cancelMonitorPicker', onMonitorCancel);

        monitorPickerWindow.loadFile(path.join(__dirname, '..', '..', 'ui', 'monitor-picker', 'picker.html'));

        monitorPickerWindow.webContents.on('did-finish-load', () => {
            monitorPickerWindow?.webContents.send('displays-list', {
                mode,
                displays: buildPickerPayload(getCachedDisplaySourcesFn())
            });
        });

        monitorPickerWindow.on('closed', () => {
            monitorPickerWindow = null;
            ipcMain.removeListener('selectMonitor', onMonitorSelected);
            ipcMain.removeListener('cancelMonitorPicker', onMonitorCancel);

            if (monitorPickerResolve) {
                const cb = monitorPickerResolve;
                monitorPickerResolve = null;
                cb(null);
            }
        });
    });
}

export function getMonitorPickerWindow(): BrowserWindow | null {
    return monitorPickerWindow;
}