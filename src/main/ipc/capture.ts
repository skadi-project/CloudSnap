/**
 * IPC: capture. Screenshot mode (get/set/save), trigger-delayed-capture,
 * switch-capture-display, open-screenshots-folder.
 */

import { BrowserWindow, ipcMain, shell } from 'electron';
import Store from 'electron-store';

import {
    createCaptureWindow,
    createCaptureWindowWithDelay,
    getDisplaySourcesCached,
    openCaptureOnDisplay
} from '../windows/capture-window';
import { findDisplayById } from '../../display-utils';
import { getScreenshotsDir } from '../services/upload-orchestrator';

export function registerCaptureIpc(store: Store, mainWindowGetter: () => BrowserWindow | null): void {
    ipcMain.on('save-screenshot-mode', (_event, mode: string) => store.set('screenshotMode', mode));

    ipcMain.handle('get-screenshot-mode', () => store.get('screenshotMode', 'fullscreen'));

    ipcMain.handle('set-screenshot-mode', (_event, mode: string) => {
        store.set('screenshotMode', mode);
        const win = mainWindowGetter();
        if (win) win.webContents.send('screenshot-mode-changed', mode);
        return { success: true };
    });

    ipcMain.handle('trigger-delayed-capture', async (_event, seconds: number) => {
        await createCaptureWindowWithDelay(seconds);
        return { success: true };
    });

    ipcMain.handle('open-screenshots-folder', async () => {
        const dir = getScreenshotsDir();
        shell.openPath(dir);
        return { success: true };
    });

    ipcMain.handle('switch-capture-display', async (_event, displayId: any) => {
        try {
            const cached = await getDisplaySourcesCached();
            const displayInfo = findDisplayById(cached, displayId);
            if (!displayInfo || !displayInfo.thumbnail) {
                return { success: false, error: 'Монитор не найден' };
            }
            await openCaptureOnDisplay(displayInfo);
            return { success: true };
        } catch (err: any) {
            return { success: false, error: err.message };
        }
    });
}