/**
 * Capture window + display sources cache.
 *
 * Объединяет логику, которая раньше была разбросана по main.ts:
 *   - getDisplaySourcesCached() (кеш с TTL)
 *   - resolveTargetDisplay() (дисплей под курсором или указанный)
 *   - pickDisplay() (выбор через picker или авто)
 *   - createCaptureWindow() и createCaptureWindowWithDelay()
 *   - openCaptureOnDisplay()
 *
 * Зависимости (screenshotT0, store, switchCaptureDisplay event) передаются
 * через setters, чтобы избежать циклов.
 */

import { app, BrowserWindow, desktopCapturer, Notification, screen } from 'electron';
import * as path from 'path';
import Store from 'electron-store';

import {
    getDisplaySources,
    getDisplayByCursor,
    findDisplayById,
    buildCapturePayload,
    getWindowSources,
    matchWindowSourcesToBounds
} from '../../display-utils';
import { DEFAULT_TEMPLATE, generateFilename } from '../../filename-utils';
import { DISPLAY_CACHE_TTL_MS } from '../config';
import type { WindowBoundsData } from '../types';
import { showMonitorPicker } from './monitor-picker';

const isMac = process.platform === 'darwin';

let store: Store | null = null;
let captureWindow: BrowserWindow | null = null;
let captureDisplayId: string | number | null = null;
let cachedDisplaySources: any[] = [];

let displayCache: { sources: any[]; at: number } | null = null;
let displayCachePending: Promise<any[]> | null = null;

let screenshotT0Getter: () => number = () => 0;
let screenshotT0Setter: (v: number) => void = () => {};
let mainWindowGetter: () => BrowserWindow | null = () => null;
let getWindowBoundsFn: () => WindowBoundsData[] = () => [];

export function setCaptureStore(s: Store): void { store = s; }
export function setScreenshotT0Getter(fn: () => number): void { screenshotT0Getter = fn; }
export function setScreenshotT0Setter(fn: (v: number) => void): void { screenshotT0Setter = fn; }
export function setCaptureMainWindowGetter(fn: () => BrowserWindow | null): void { mainWindowGetter = fn; }
export function setGetWindowBoundsFn(fn: () => WindowBoundsData[]): void { getWindowBoundsFn = fn; }

export function getCachedDisplaySources(): any[] {
    return cachedDisplaySources;
}

export async function getDisplaySourcesCached(): Promise<any[]> {
    const now = Date.now();
    if (displayCache && (now - displayCache.at) < DISPLAY_CACHE_TTL_MS) {
        return displayCache.sources;
    }
    if (displayCachePending) return displayCachePending;
    displayCachePending = getDisplaySources()
        .then(sources => {
            displayCache = { sources, at: Date.now() };
            cachedDisplaySources = sources;
            return sources;
        })
        .catch(err => {
            console.error('getDisplaySources error:', err);
            return cachedDisplaySources;
        })
        .finally(() => {
            displayCachePending = null;
        });
    return displayCachePending;
}

export function invalidateDisplayCache(): void {
    displayCache = null;
    cachedDisplaySources = [];
}

/** Устанавливает обработчики событий screen (display-added/removed/metrics-changed). */
export function attachDisplayChangeListeners(): void {
    (screen as any).on?.('display-added', invalidateDisplayCache);
    (screen as any).on?.('display-removed', invalidateDisplayCache);
    (screen as any).on?.('display-metrics-changed', invalidateDisplayCache);
}

export async function resolveTargetDisplay(
    preferredDisplayId: string | number | null = null
): Promise<any> {
    cachedDisplaySources = await getDisplaySourcesCached();
    if (!cachedDisplaySources.length) {
        console.error('Источники экрана не найдены');
        return null;
    }
    if (cachedDisplaySources.length === 1) {
        return cachedDisplaySources[0];
    }
    if (preferredDisplayId != null) {
        const found = findDisplayById(cachedDisplaySources, preferredDisplayId);
        if (found) return found;
    }
    return findDisplayById(cachedDisplaySources, getDisplayByCursor().id) || cachedDisplaySources[0];
}

export async function pickDisplay(
    mode: string,
    preferredDisplayId: string | number | null = null
): Promise<any> {
    cachedDisplaySources = await getDisplaySourcesCached();
    if (!cachedDisplaySources.length) return null;
    if (cachedDisplaySources.length === 1) return cachedDisplaySources[0];

    if (preferredDisplayId != null) {
        const found = findDisplayById(cachedDisplaySources, preferredDisplayId);
        if (found) return found;
    }

    const selectedId = await showMonitorPicker(mode);
    if (!selectedId) return null;
    return findDisplayById(cachedDisplaySources, selectedId);
}

export function buildFilename(type: string, monitorIndex: number | null = null): string {
    if (!store) return '';
    const template = store.get('filenameTemplate', DEFAULT_TEMPLATE) as string;
    const login = store.get('login', 'user') as string;
    const now = new Date();
    return generateFilename(template, type, {
        user: login,
        monitor: monitorIndex != null ? monitorIndex + 1 : 1,
        date: now
    });
}

export async function openCaptureOnDisplay(displayInfo: any): Promise<void> {
    if (!displayInfo || !displayInfo.thumbnail) return;

    const currentMode = store ? store.get('screenshotMode', 'fullscreen') as string : 'fullscreen';
    const screenImageSrc = displayInfo.thumbnail.toDataURL();
    captureDisplayId = displayInfo.id;

    let windowBounds = getWindowBoundsFn();

    if (currentMode === 'window') {
        try {
            let windowSources = await getWindowSources();
            windowBounds = matchWindowSourcesToBounds(windowBounds, windowSources);
            const matchedCount = windowBounds.filter(b => b.sourceId).length;
            console.log(`[capture] Window mode: ${windowBounds.length} bounds, ${windowSources.length} sources, ${matchedCount} matched`);
            if (matchedCount === 0 && windowBounds.length > 0 && windowSources.length > 0) {
                await new Promise(resolve => setTimeout(resolve, 200));
                windowSources = await getWindowSources();
                windowBounds = matchWindowSourcesToBounds(windowBounds, windowSources);
                const retryCount = windowBounds.filter(b => b.sourceId).length;
                console.log(`[capture] Window mode retry: ${retryCount} matched`);
            }
        } catch (e) {
            console.error('[capture] getWindowSources failed:', e);
        }
    }

    const payload = buildCapturePayload(displayInfo, screenImageSrc, currentMode, windowBounds) as any;
    payload.displays = cachedDisplaySources.map(d => ({
        id: d.id,
        label: d.label,
        index: d.index,
        isPrimary: d.isPrimary
    }));
    payload.currentDisplayId = displayInfo.id;

    const { bounds } = displayInfo;

    if (captureWindow && !captureWindow.isDestroyed()) {
        captureWindow.setBounds({ x: bounds.x, y: bounds.y, width: bounds.width, height: bounds.height });
        captureWindow.webContents.send('capture-display-switched', payload);
        return;
    }

    captureWindow = new BrowserWindow({
        x: bounds.x,
        y: bounds.y,
        width: bounds.width,
        height: bounds.height,
        frame: false,
        transparent: true,
        backgroundColor: '#00000000',
        alwaysOnTop: true,
        skipTaskbar: true,
        show: false,
        paintWhenInitiallyHidden: true,
        webPreferences: {
            preload: path.join(__dirname, '..', '..', '..', 'preload.js'),
            contextIsolation: true,
            nodeIntegration: false
        }
    });

    captureWindow.loadFile(path.join(__dirname, '..', '..', 'ui', 'capture-window', 'capture.html'));

    captureWindow.webContents.once('did-finish-load', () => {
        const t0 = screenshotT0Getter();
        if (t0) console.log(`[latency][shot] t=${Date.now() - t0}ms  captureWindow did-finish-load → sending screenshot-captured`);
        if (screenImageSrc.startsWith('data:image')) {
            captureWindow?.webContents.send('screenshot-captured', payload);
        }
        if (captureWindow && !captureWindow.isDestroyed()) {
            captureWindow.show();
            const t02 = screenshotT0Getter();
            if (t02) console.log(`[latency][shot] t=${Date.now() - t02}ms  captureWindow shown (visible to user)`);
        }
    });

    captureWindow.on('closed', () => {
        captureWindow = null;
        captureDisplayId = null;
    });
}

export async function createCaptureWindow(preferredDisplayId: string | number | null = null): Promise<void> {
    if (captureWindow) return;

    try {
        const displayInfo = await resolveTargetDisplay(preferredDisplayId);
        if (!displayInfo) {
            const t0 = screenshotT0Getter();
            if (t0) console.log(`[latency][shot] t=${Date.now() - t0}ms  resolveTargetDisplay returned null`);
            return;
        }
        const t0 = screenshotT0Getter();
        if (t0) console.log(`[latency][shot] t=${Date.now() - t0}ms  display resolved: id=${displayInfo.id} label="${displayInfo.label}"`);
        await openCaptureOnDisplay(displayInfo);
    } catch (e) {
        console.error('Критическая ошибка desktopCapturer в главном процессе:', e);
    }
}

export async function createCaptureWindowWithDelay(delaySeconds: number): Promise<void> {
    screenshotT0Setter(Date.now());
    const t0 = screenshotT0Getter();
    console.log(`[latency][shot] t=0ms  createCaptureWindowWithDelay delay=${delaySeconds}s`);
    const win = mainWindowGetter();
    if (win && win.isVisible()) win.hide();
    if (delaySeconds > 0) {
        new Notification({
            title: 'CloudSnap',
            body: `Приготовиться! Снимок экрана через ${delaySeconds} сек...`
        }).show();
        await new Promise(resolve => setTimeout(resolve, delaySeconds * 1000));
    }
    await createCaptureWindow();
}

export function getCaptureWindow(): BrowserWindow | null {
    return captureWindow;
}

export function getCaptureDisplayId(): string | number | null {
    return captureDisplayId;
}

/** Прогрев кеша desktopCapturer (запускается из app.whenReady через index.ts). */
export function warmupDisplayCache(): void {
    setTimeout(() => { getDisplaySourcesCached().catch(() => {}); }, 1000);
    // Прогрев window sources — на первом вызове Chromium-часть ещё не
    // закончила enumeration окон; делаем холостые вызовы.
    setTimeout(() => { getWindowSources().catch(() => {}); }, 1500);
    setTimeout(() => { getWindowSources().catch(() => {}); }, 4000);
}

/** Проверка разрешений macOS: Screen Recording + Accessibility. */
export async function checkMacOSPermissions(): Promise<void> {
    if (!isMac) return;
    let macosUtils: any = null;
    try { macosUtils = require('../../macos-utils'); } catch { return; }
    const win = mainWindowGetter();

    const hasPermission = macosUtils.checkAccessibilityPermission();
    if (!hasPermission) {
        macosUtils.requestAccessibilityPermission();
        if (win) {
            win.webContents.send('status-update',
                '⚠ Для режима «Окно» и записи области на macOS\nнеобходимо разрешить CloudSnap в Системных настройках → Универсный доступ.');
        }
    }

    try {
        const sources = await desktopCapturer.getSources({ types: ['screen'], thumbnailSize: { width: 300, height: 300 } });
        const hasEmptyThumb = sources.length > 0 && sources.every(s => {
            const size = s.thumbnail.getSize();
            return size.width === 0 || size.height === 0;
        });
        if (hasEmptyThumb || sources.length === 0) {
            macosUtils.requestScreenRecordingPermission();
            if (win) {
                win.webContents.send('status-update',
                    '⚠ Для скриншотов и записи экрана на macOS\nнеобходимо разрешить CloudSnap в Системных настройках → Запись экрана.');
            }
        }
    } catch (e: any) {
        console.error('[macOS] Ошибка проверки Screen Recording:', e.message);
    }
}