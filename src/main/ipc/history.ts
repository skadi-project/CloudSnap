/**
 * IPC: history. Чтение истории, копирование ссылок, открытие в Nextcloud,
 * удаление и очистка.
 */

import { BrowserWindow, clipboard, ipcMain, shell } from 'electron';
import * as fs from 'fs';
import * as path from 'path';
import Store from 'electron-store';

import { validateServerUrl } from '../security';
import { getHistoryDir } from '../services/upload-orchestrator';
import type { HistoryEntry } from '../types';

export function registerHistoryIpc(store: Store, mainWindowGetter: () => BrowserWindow | null): void {
    ipcMain.handle('get-history', async () => {
        return store.get('screenshotHistory', []);
    });

    ipcMain.handle('copy-history-link', async (_event, id: string) => {
        const history = store.get('screenshotHistory', []) as HistoryEntry[];
        const item = history.find(h => h.id === id);
        if (item && item.finalLink) {
            clipboard.writeText(item.finalLink);
            return { success: true };
        }
        return { success: false, error: 'Ссылка отсутствует' };
    });

    ipcMain.handle('open-in-nextcloud', async (_event, id: string) => {
        const history = store.get('screenshotHistory', []) as HistoryEntry[];
        const item = history.find(h => h.id === id);
        if (!item || !item.filePath) return { success: false, error: 'Путь файла отсутствует' };
        const urlValidation = validateServerUrl(item.serverUrl || '');
        if (!urlValidation.ok) {
            return { success: false, error: 'Сохранённый URL сервера невалиден' };
        }
        const urlObj = new URL(urlValidation.url);
        const parentDir = item.filePath.substring(0, item.filePath.lastIndexOf('/') + 1);
        const ncUrl = `${urlObj.origin}/apps/files/?dir=${encodeURIComponent(parentDir)}`;
        shell.openExternal(ncUrl);
        return { success: true };
    });

    ipcMain.handle('delete-history-item', async (_event, id: string) => {
        const history = store.get('screenshotHistory', []) as HistoryEntry[];
        const item = history.find(h => h.id === id);
        if (item && item.thumbnailPath && fs.existsSync(item.thumbnailPath)) {
            try { fs.unlinkSync(item.thumbnailPath); } catch { /* ignore */ }
        }
        store.set('screenshotHistory', history.filter(h => h.id !== id));
        const win = mainWindowGetter();
        if (win) win.webContents.send('history-updated');
        return { success: true };
    });

    ipcMain.handle('clear-history', async () => {
        const historyDir = getHistoryDir();
        if (fs.existsSync(historyDir)) {
            for (const file of fs.readdirSync(historyDir)) {
                try { fs.unlinkSync(path.join(historyDir, file)); } catch { /* ignore */ }
            }
        }
        store.set('screenshotHistory', []);
        const win = mainWindowGetter();
        if (win) win.webContents.send('history-updated');
        return { success: true };
    });
}