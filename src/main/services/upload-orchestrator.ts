/**
 * Upload orchestration: processQueue (повторная отправка из очереди),
 * processRecordingData (финализация видео), history management, file helpers.
 *
 * Раньше всё это было в main.ts (~500 строк). Теперь изолировано и
 * получает зависимости через setters — главным образом `store` и
 * recordingManager. UI-сторона получает результаты через ipcRenderer события.
 */

import { app, BrowserWindow, clipboard, nativeImage, Notification, shell } from 'electron';
import * as fs from 'fs';
import * as path from 'path';
import { execFileSync } from 'child_process';
import Store from 'electron-store';

import { uploadToNextcloud } from '../../webdav/uploader';
import { createPublicShare } from '../../webdav/share';
import { getDecryptedPassword } from '../security';
import { MAX_HISTORY, MAX_SCREENSHOT_BYTES, FILE_WRITE_CHUNK_SIZE, STREAMING_FILE_THRESHOLD } from '../config';
import { DEFAULT_TEMPLATE, generateFileId } from '../../filename-utils';
import type { HistoryEntry, QueueItem } from '../types';

let store: Store | null = null;
let mainWindowGetter: () => BrowserWindow | null = () => null;
let buildFilenameFn: (type: string, monitorIndex: number | null) => string = () => '';
let getRecordingDisplayIndexFn: () => number = () => 0;

export function setUploadStore(s: Store): void { store = s; }
export function setUploadMainWindowGetter(fn: () => BrowserWindow | null): void {
    mainWindowGetter = fn;
}
export function setBuildFilename(fn: (type: string, monitorIndex: number | null) => string): void {
    buildFilenameFn = fn;
}
export function setRecordingDisplayIndexGetter(fn: () => number): void {
    getRecordingDisplayIndexFn = fn;
}

// === History & thumbnails ===

export function getScreenshotsDir(): string {
    const picturesPath = app.getPath('pictures');
    const dir = path.join(picturesPath, 'CloudSnap');
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    return dir;
}

export function getHistoryDir(): string {
    const dir = path.join(app.getPath('userData'), 'history');
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    return dir;
}

export function generateThumbnail(buffer: Buffer, id: string): string {
    const img = nativeImage.createFromBuffer(buffer);
    const resized = img.resize({ width: 150 });
    const jpegBuf = resized.toJPEG(60);
    const thumbPath = path.join(getHistoryDir(), `${id}_thumb.jpg`);
    fs.writeFileSync(thumbPath, jpegBuf);
    return thumbPath;
}

/**
 * Зеркало generateThumbnail для видео: recorder присылает JPEG base64 последнего
 * кадра из cropCanvas. Декодируем через nativeImage, ресайзим до 150px и
 * сохраняем в ту же historyDir с тем же шаблоном имени — UI истории один и тот же.
 */
export function generateVideoThumbnail(base64: string, id: string): string | null {
    try {
        const buf = Buffer.from(base64, 'base64');
        const img = nativeImage.createFromBuffer(buf);
        const resized = img.resize({ width: 150 });
        const jpegBuf = resized.toJPEG(60);
        const thumbPath = path.join(getHistoryDir(), `${id}_thumb.jpg`);
        fs.writeFileSync(thumbPath, jpegBuf);
        return thumbPath;
    } catch (e) {
        console.warn('generateVideoThumbnail failed:', e);
        return null;
    }
}

export function addToHistory(entry: HistoryEntry): void {
    if (!store) return;
    const history = store.get('screenshotHistory', []) as HistoryEntry[];
    history.unshift(entry);
    if (history.length > MAX_HISTORY) {
        const removed = history.splice(MAX_HISTORY);
        for (const item of removed) {
            if (item.thumbnailPath && fs.existsSync(item.thumbnailPath)) {
                try { fs.unlinkSync(item.thumbnailPath); } catch { /* ignore */ }
            }
        }
    }
    store.set('screenshotHistory', history);
    const win = mainWindowGetter();
    if (win) win.webContents.send('history-updated');
}

export function updateHistoryItem(id: string, updates: Partial<HistoryEntry>): void {
    if (!store) return;
    const history = store.get('screenshotHistory', []) as HistoryEntry[];
    const idx = history.findIndex(h => h.id === id);
    if (idx >= 0) {
        Object.assign(history[idx], updates);
        store.set('screenshotHistory', history);
        const win = mainWindowGetter();
        if (win) win.webContents.send('history-updated');
    }
}

// === Explorer thumbnail refresh (Windows) ===

/**
 * Вызывает SHChangeNotify через PowerShell. На Windows Explorer читает
 * миниатюры из in-memory кеша и не обновляет их по изменению файла, поэтому
 * без явного уведомления старая иконка держится до F5 или перезапуска.
 *   SHCNE_UPDATEITEM = 0x00000000 — обновить элемент
 *   SHCNF_PATH       = 0x00000005 — путь в wchar*
 * Дополнительно дёргаем SHCNE_ASSOCCHANGED, чтобы иконка пересобралась, если
 * система успела закешировать старую.
 */
export function notifyExplorer(filePath: string): void {
    if (process.platform !== 'win32') return;
    try {
        execFileSync('powershell.exe', [
            '-NoProfile',
            '-NonInteractive',
            '-Command',
            `$path = ${JSON.stringify(filePath)}; ` +
            `$signature = @"
using System;
using System.Runtime.InteropServices;
public class WinShell {
    [DllImport(\"shell32.dll\", CharSet=CharSet.Unicode)]
    public static extern void SHChangeNotify(int wEventId, int uFlags, IntPtr dwItem1, IntPtr dwItem2);
}
"@; ` +
            `Add-Type -TypeDefinition $signature; ` +
            `$p = [System.Runtime.InteropServices.Marshal]::StringToHGlobalUni($path); ` +
            `try { [WinShell]::SHChangeNotify(0, 5, $p, [IntPtr]::Zero) } ` +
            `finally { [System.Runtime.InteropServices.Marshal]::FreeHGlobal($p) }; ` +
            `[WinShell]::SHChangeNotify(0x08000000, 0x00001000, [IntPtr]::Zero, [IntPtr]::Zero)`
        ], { stdio: 'ignore', timeout: 5000 });
    } catch (e) {
        console.warn('[main] notifyExplorer failed:', e instanceof Error ? e.message : e);
    }
}

// === File writing ===

/**
 * Записывает Buffer в файл. Для файлов > 50 МБ использует stream,
 * чтобы не забивать память и не получать RangeError на больших аллокациях.
 */
export function writeBufferToFile(filePath: string, buffer: Buffer): Promise<void> {
    return new Promise((resolve, reject) => {
        if (buffer.length < STREAMING_FILE_THRESHOLD) {
            try {
                fs.writeFileSync(filePath, buffer);
                resolve();
            } catch (e) {
                reject(e);
            }
            return;
        }
        const stream = fs.createWriteStream(filePath);
        stream.on('error', reject);
        stream.on('finish', resolve);
        let offset = 0;
        const writeNext = (): void => {
            if (offset >= buffer.length) {
                stream.end();
                return;
            }
            const slice = buffer.subarray(offset, Math.min(offset + FILE_WRITE_CHUNK_SIZE, buffer.length));
            offset += slice.length;
            if (!stream.write(slice)) {
                stream.once('drain', writeNext);
            } else {
                setImmediate(writeNext);
            }
        };
        writeNext();
    });
}

// === Upload URL construction ===

export function getTargetUploadUrl(baseUrl: string): string {
    if (!store) return baseUrl;
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

// === Queue processing ===

let isProcessingQueue = false;

export function isQueueProcessing(): boolean {
    return isProcessingQueue;
}

export async function processQueue(): Promise<void> {
    if (isProcessingQueue || !store) return;

    const queue = store.get('uploadQueue', []) as QueueItem[];
    if (queue.length === 0) return;

    const serverUrl = store.get('url', '') as string;
    const login = store.get('login') as string;
    if (!serverUrl || !login) return;

    const password = getDecryptedPassword(store);
    if (!password) return;

    isProcessingQueue = true;
    console.log(`[Очередь] Найдено файлов для отправки: ${queue.length}`);
    const remainingQueue: QueueItem[] = [];

    for (const item of queue) {
        try {
            // Убираем TOCTOU: читаем файл напрямую, ENOENT обрабатываем
            // как «уже отправлен / удалён вручную» и тихо пропускаем.
            let buffer: Buffer;
            try {
                buffer = fs.readFileSync(item.localPath);
            } catch (readErr: any) {
                if (readErr?.code === 'ENOENT') {
                    console.warn(`[Очередь] Файл уже отсутствует, пропускаю: ${item.localPath}`);
                    continue;
                }
                throw readErr;
            }

            const win = mainWindowGetter();
            if (win) {
                win.webContents.send('status-update', `Попытка авто-догрузки: ${item.filename}`);
            }

            const targetUrl = getTargetUploadUrl(serverUrl);
            const result = await uploadToNextcloud(targetUrl, login, password, item.filename, buffer);

            if (result.success) {
                const saveLocalCopy = store.get('saveLocalCopy', false);
                if (saveLocalCopy) {
                    const localDir = getScreenshotsDir();
                    const localFilePath = path.join(localDir, item.filename);
                    fs.copyFileSync(item.localPath, localFilePath);
                }
                try { fs.unlinkSync(item.localPath); } catch { /* ignore */ }

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

                if (win) {
                    win.webContents.send('status-update', `Успешно отправлен из очереди!\nСсылка: ${finalLink}`);
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

// Re-export MAX_SCREENSHOT_BYTES for convenience of callers (upload IPC).
export { MAX_SCREENSHOT_BYTES };
// Re-export DEFAULT_TEMPLATE for callers that need to validate user templates.
export { DEFAULT_TEMPLATE };