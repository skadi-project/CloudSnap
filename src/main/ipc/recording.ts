/**
 * IPC: recording. Управление записью видео + приём данных от recorder'а
 * + финализация (processRecordingData).
 *
 * Защита от race conditions:
 *   - recordingActive: парный к onBeforeStart/processRecordingData, отбрасывает
 *     chunks вне сессии
 *   - sessionId: чанки с несовпадающим sessionId считаются устаревшими
 *
 * Раньше вся эта логика (~250 строк) была в main.ts.
 */

import { app, BrowserWindow, clipboard, ipcMain, Notification } from 'electron';
import * as fs from 'fs';
import * as path from 'path';
import Store from 'electron-store';

import type { RecordingManager } from '../../recording/recording-manager';

import { uploadToNextcloud } from '../../webdav/uploader';
import { createPublicShare } from '../../webdav/share';
import { getDecryptedPassword } from '../security';
import { generateFileId } from '../../filename-utils';
import {
    startRecordingFromIpc,
    togglePause,
    stopRecording,
    getRecordingState
} from '../services/recording-controller';
import {
    addToHistory,
    generateVideoThumbnail,
    getScreenshotsDir,
    getTargetUploadUrl,
    notifyExplorer,
    writeBufferToFile
} from '../services/upload-orchestrator';
import type { QueueItem } from '../types';

// === Chunks & session state ===

let recordingChunks: Buffer[] = [];
let recordingSessionId: string | null = null;
let recordingActive = false;
let pendingThumbnail: string | null = null;

let recordingT0Getter: () => number = () => 0;

let store: Store | null = null;
let recordingManagerGetter: () => RecordingManager | null = () => null;
let mainWindowGetter: () => BrowserWindow | null = () => null;
let quitAfterRecordingRef: { value: boolean } = { value: false };
let buildFilenameFn: (type: string, monitorIndex: number | null) => string = () => '';

export function setRecordingStore(s: Store): void { store = s; }
export function setRecordingManagerGetter(fn: () => RecordingManager | null): void {
    recordingManagerGetter = fn;
}
export function setRecordingMainWindowGetter(fn: () => BrowserWindow | null): void {
    mainWindowGetter = fn;
}
export function setRecordingT0Getter(fn: () => number): void { recordingT0Getter = fn; }
export function setQuitAfterRecordingRef(ref: { value: boolean }): void {
    quitAfterRecordingRef = ref;
}
export function setRecordingBuildFilename(fn: (type: string, monitorIndex: number | null) => string): void {
    buildFilenameFn = fn;
}

/** Хелпер: инициализация новой сессии. Возвращает sessionId. */
export function startNewRecordingSession(): string {
    recordingChunks = [];
    const newSessionId = `${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
    recordingSessionId = newSessionId;
    recordingActive = true;
    return newSessionId;
}

export function resetRecordingSession(): void {
    recordingActive = false;
    recordingSessionId = null;
    recordingChunks = [];
}

function hasActiveSession(): boolean {
    return recordingActive;
}

function setPendingThumbnail(base64: string): void {
    pendingThumbnail = base64;
}

function consumePendingThumbnail(): string | null {
    const t = pendingThumbnail;
    pendingThumbnail = null;
    return t;
}

// === IPC handlers ===

export function registerRecordingIpc(): void {
    ipcMain.on('recording-chunk', (_event, data: any, sessionId?: string) => {
        if (!recordingActive) return;
        if (sessionId && recordingSessionId && sessionId !== recordingSessionId) return;
        recordingChunks.push(Buffer.from(data));
    });

    ipcMain.on('recording-finished', async () => {
        if (!recordingActive) return;
        await processRecordingData();
    });

    ipcMain.on('recording-first-frame', (_event, firstFrameTs: number) => {
        const totalMs = Date.now() - recordingT0Getter();
        const rendererMs = firstFrameTs - recordingT0Getter();
        console.log(`[latency] t=${totalMs}ms  FIRST FRAME drawn in renderer (renderer delta=${rendererMs}ms)`);
        console.log(`[latency] ===> TOTAL latency (hotkey → first frame): ${totalMs}ms`);
    });

    ipcMain.on('recording-thumbnail', (_event, base64: string) => {
        setPendingThumbnail(base64);
        console.log(`[main] recording-thumbnail received: ${base64.length} chars`);
    });

    ipcMain.on('area-selected', (_event, area: any) => {
        const rm = recordingManagerGetter();
        if (rm) {
            console.log(`[latency] t=${Date.now() - recordingT0Getter()}ms  area-selected received from selector`,
                JSON.stringify({x: area.x, y: area.y, w: area.w, h: area.h, sf: area.scaleFactor}));
            rm.confirmArea(area);
        }
    });

    ipcMain.on('area-selection-cancelled', () => {
        const rm = recordingManagerGetter();
        if (rm) rm.cancelAreaSelection();
    });

    ipcMain.handle('start-video-recording', async () => {
        return await startRecordingFromIpc('fullscreen');
    });

    ipcMain.handle('start-area-recording', async () => {
        return await startRecordingFromIpc('area');
    });

    ipcMain.handle('toggle-pause-recording', async () => {
        return await togglePause();
    });

    ipcMain.handle('stop-recording', async () => {
        return await stopRecording();
    });

    ipcMain.handle('get-recording-state', async () => {
        return getRecordingState();
    });
}

// === Finalization ===

async function processRecordingData(): Promise<void> {
    if (!store) return;
    recordingActive = false;
    if (!recordingChunks || recordingChunks.length === 0) {
        recordingSessionId = null;
        const rm = recordingManagerGetter();
        if (rm) rm.cleanup();
        return;
    }

    const finalBuffer = Buffer.concat(recordingChunks);
    recordingChunks = [];
    recordingSessionId = null;
    recordingActive = false;

    const now = new Date();
    const rm = recordingManagerGetter();
    const filename = buildFilenameFn('video', rm?.getActiveDisplayIndex() ?? 0);
    const id = generateFileId(now);

    const tempDir = path.join(app.getPath('userData'), 'temp');
    if (!fs.existsSync(tempDir)) fs.mkdirSync(tempDir, { recursive: true });
    const tempPath = path.join(tempDir, filename);
    await writeBufferToFile(tempPath, finalBuffer);

    const saveLocalCopy = store.get('saveLocalCopy', false);
    let localPath: string | null = null;
    if (saveLocalCopy) {
        localPath = path.join(getScreenshotsDir(), filename);
        await writeBufferToFile(localPath, finalBuffer);
    }

    const url = store.get('url', '') as string;
    const login = store.get('login', '') as string;
    let finalLink: string | null = null;
    let uploadStatus = 'queued';
    let filePath = '';

    const password = (url && login) ? getDecryptedPassword(store) : null;
    if (url && login && password) {
        try {
            const targetUrl = getTargetUploadUrl(url);
            const result = await uploadToNextcloud(targetUrl, login, password, filename, finalBuffer);

            if (result.success) {
                uploadStatus = 'uploaded';
                finalLink = result.url || null;
                filePath = result.filePath || '';
                const linkMode = store.get('linkMode', 'internal');
                if (linkMode === 'public' && filePath) {
                    const shareResult = await createPublicShare(url, login, password, filePath);
                    if (shareResult.success) {
                        finalLink = shareResult.url || null;
                    }
                    clipboard.writeText(finalLink || '');
                }
            } else {
                const cacheDir = path.join(app.getPath('userData'), 'pending-uploads');
                if (!fs.existsSync(cacheDir)) fs.mkdirSync(cacheDir, { recursive: true });
                const queuePath = path.join(cacheDir, filename);
                await writeBufferToFile(queuePath, finalBuffer);
                const queue = store.get('uploadQueue', []) as QueueItem[];
                queue.push({ filename, localPath: queuePath, id });
                store.set('uploadQueue', queue);
            }
        } catch (err) {
            console.error('Upload video error:', err);
            const cacheDir = path.join(app.getPath('userData'), 'pending-uploads');
            if (!fs.existsSync(cacheDir)) fs.mkdirSync(cacheDir, { recursive: true });
            const queuePath = path.join(cacheDir, filename);
            await writeBufferToFile(queuePath, finalBuffer);
            const queue = store.get('uploadQueue', []) as QueueItem[];
            queue.push({ filename, localPath: queuePath, id });
            store.set('uploadQueue', queue);
        }
    }

    // Refresh иконки в Проводнике Windows
    if (process.platform === 'win32') {
        if (localPath) notifyExplorer(localPath);
        const queueItem = (store.get('uploadQueue', []) as QueueItem[])
            .find(q => q.id === id);
        if (queueItem && queueItem.localPath && queueItem.localPath !== localPath) {
            notifyExplorer(queueItem.localPath);
        }
    }

    const thumbnailBase64 = consumePendingThumbnail();
    const thumbnailPath = thumbnailBase64 ? generateVideoThumbnail(thumbnailBase64, id) : null;

    addToHistory({
        id, filename, type: 'video',
        timestamp: now.toISOString(),
        status: uploadStatus,
        thumbnailPath,
        finalLink,
        filePath,
        serverUrl: url,
        linkMode: store.get('linkMode', 'internal') as string,
        localPath
    });

    try {
        fs.unlinkSync(tempPath);
    } catch (e: any) {
        console.warn(`Не удалось удалить temp файл ${tempPath}: ${e?.message}`);
    }

    const win = mainWindowGetter();
    if (uploadStatus === 'uploaded') {
        new Notification({ title: 'CloudSnap: Видео сохранено', body: `Ссылка скопирована в буфер обмена` }).show();
        if (win) win.webContents.send('status-update', `Видео отправлено!\nСсылка: ${finalLink}`);
    } else {
        new Notification({ title: 'CloudSnap', body: `Видео сохранено в очередь отправки` }).show();
        if (win) win.webContents.send('status-update', `Видео в очереди отправки.`);
    }

    if (rm) rm.cleanup();

    if (quitAfterRecordingRef.value) {
        quitAfterRecordingRef.value = false;
        (app as any).isQuitting = true;
        app.quit();
    }
}