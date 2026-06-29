/**
 * IPC: upload-file. Загрузка скриншота от renderer'а на сервер.
 *
 * Защита:
 *   - MAX_SCREENSHOT_BYTES: лимит до аллокации (estimatedBytes = ceil(N * 3/4))
 *   - isPngOrJpeg: проверка magic bytes
 */

import { BrowserWindow, clipboard, ipcMain } from 'electron';
import Store from 'electron-store';

import { uploadToNextcloud } from '../../webdav/uploader';
import { createPublicShare } from '../../webdav/share';
import { isPngOrJpeg, getDecryptedPassword } from '../security';
import { MAX_SCREENSHOT_BYTES } from '../config';
import {
    addToHistory,
    generateThumbnail,
    getScreenshotsDir,
    getTargetUploadUrl
} from '../services/upload-orchestrator';

export function registerUploadIpc(store: Store, mainWindowGetter: () => BrowserWindow | null, buildFilenameFn: (type: string, monitorIndex: number | null) => string, generateFileIdFn: (date: Date) => string): void {
    ipcMain.handle('upload-file', async (_event, payload: { fileData: string; type: string; monitorIndex: number | null }) => {
        const { fileData, type, monitorIndex } = payload;
        const url = store.get('url') as string;
        const login = store.get('login') as string;
        if (!url || !login) return { success: false, error: 'Настройки не заполнены' };

        if (typeof fileData !== 'string' || !fileData) {
            return { success: false, error: 'Пустые данные файла' };
        }
        const estimatedBytes = Math.ceil(fileData.length * 3 / 4);
        if (estimatedBytes > MAX_SCREENSHOT_BYTES) {
            return { success: false, error: `Файл превышает лимит ${MAX_SCREENSHOT_BYTES / (1024 * 1024)} МБ` };
        }

        const password = getDecryptedPassword(store);
        if (!password) return { success: false, error: 'Не удалось получить сохранённый пароль. Возможно, требуется повторный вход.' };

        const now = new Date();
        const filename = buildFilenameFn(type, monitorIndex);
        const id = generateFileIdFn(now);
        const buffer = Buffer.from(fileData, 'base64');

        if (type === 'image' && !isPngOrJpeg(buffer)) {
            return { success: false, error: 'Недопустимый формат изображения (ожидается PNG/JPEG)' };
        }
        if (buffer.length > MAX_SCREENSHOT_BYTES) {
            return { success: false, error: `Файл превышает лимит ${MAX_SCREENSHOT_BYTES / (1024 * 1024)} МБ` };
        }

        const thumbnailPath = generateThumbnail(buffer, id);

        const targetUrl = getTargetUploadUrl(url);
        const result = await uploadToNextcloud(targetUrl, login, password, filename, buffer);
        const win = mainWindowGetter();
        if (result.success && win) {
            const linkMode = store.get('linkMode', 'internal') as string;
            let finalLink: string | null = result.url || null;

            if (linkMode === 'public' && result.filePath) {
                const shareResult = await createPublicShare(url, login, password, result.filePath);
                if (shareResult.success) {
                    finalLink = shareResult.url || null;
                }
                clipboard.writeText(finalLink || '');
            }

            clipboard.writeText(finalLink || '');

            const localPath = store.get('saveLocalCopy', false) ? require('path').join(getScreenshotsDir(), filename) : null;
            if (localPath) require('fs').writeFileSync(localPath, buffer);

            addToHistory({
                id, filename, type, timestamp: now.toISOString(),
                status: 'uploaded', thumbnailPath, finalLink,
                filePath: result.filePath || '', serverUrl: url, linkMode, localPath
            });

            win.webContents.send('status-update', `Успех! Ссылка в буфере:\n${finalLink}`);
            return { ...result, url: finalLink };
        }

        if (!result.success) {
            const cacheDir = require('path').join(require('electron').app.getPath('userData'), 'pending-uploads');
            const fs = require('fs');
            if (!fs.existsSync(cacheDir)) fs.mkdirSync(cacheDir, { recursive: true });

            const localPath = require('path').join(cacheDir, filename);
            fs.writeFileSync(localPath, buffer);

            const queue = store.get('uploadQueue', []) as any[];
            queue.push({ filename, localPath, id });
            store.set('uploadQueue', queue);

            addToHistory({
                id, filename, type, timestamp: now.toISOString(),
                status: 'queued', thumbnailPath, finalLink: null,
                filePath: '', serverUrl: url, linkMode: store.get('linkMode', 'internal') as string, localPath: null
            });

            if (win) {
                win.webContents.send('status-update', `Ошибка сети. Файл сохранён в очередь отправки.`);
            }
        }

        return result;
    });
}