/**
 * Глобальные хоткеи: скриншот, запись, пауза/продолжение, остановка.
 *
 * Комбинации клавиш берутся из store (можно менять в настройках UI).
 * При изменении настроек registerShortcuts() вызывается повторно.
 */

import { globalShortcut } from 'electron';
import Store from 'electron-store';

const isMac = process.platform === 'darwin';

let store: Store | null = null;
let createCaptureWindowFn: () => Promise<void> = async () => {};
let createCaptureWindowWithDelayFn: (delaySeconds: number) => Promise<void> = async () => {};
let startRecordingFromTrayFn: (mode: 'fullscreen' | 'area') => Promise<void> = async () => {};
let startRecordingFromHotkeyFn: () => Promise<void> = async () => {};
let stopRecordingFn: () => Promise<{ success: boolean }> = async () => ({ success: false });
let togglePauseFn: () => Promise<{ success: boolean; state: string }> = async () => ({ success: false, state: 'idle' });
let getRecordingStateFn: () => { state: string; elapsed: number } = () => ({ state: 'idle', elapsed: 0 });

export function setShortcutStore(s: Store): void { store = s; }
export function setShortcutCreateCaptureWindow(fn: () => Promise<void>): void {
    createCaptureWindowFn = fn;
}
export function setShortcutCreateCaptureWindowWithDelay(fn: (delaySeconds: number) => Promise<void>): void {
    createCaptureWindowWithDelayFn = fn;
}
export function setShortcutStartRecordingFromTray(fn: (mode: 'fullscreen' | 'area') => Promise<void>): void {
    startRecordingFromTrayFn = fn;
}
export function setShortcutStartRecordingFromHotkey(fn: () => Promise<void>): void {
    startRecordingFromHotkeyFn = fn;
}
export function setShortcutStopRecording(fn: () => Promise<{ success: boolean }>): void {
    stopRecordingFn = fn;
}
export function setShortcutTogglePause(fn: () => Promise<{ success: boolean; state: string }>): void {
    togglePauseFn = fn;
}
export function setShortcutGetRecordingState(fn: () => { state: string; elapsed: number }): void {
    getRecordingStateFn = fn;
}

export function registerShortcuts(): void {
    globalShortcut.unregisterAll();
    if (!store) return;

    const modifier = store.get('shortcutModifier', isMac ? 'Command+Shift' : 'Control+Shift') as string;
    const key = store.get('shortcutKey', 'A') as string;
    const screenshotShortcut = `${modifier}+${key}`;

    const defaultDelay = store.get('defaultDelay', 0) as number;

    globalShortcut.register(screenshotShortcut, () => {
        if ((app as any).isQuitting) return;
        console.log(`[latency][shot] t=0ms  HOTKEY ${screenshotShortcut} (defaultDelay=${defaultDelay}s)`);
        if (defaultDelay > 0) {
            createCaptureWindowWithDelayFn(defaultDelay);
        } else {
            createCaptureWindowFn();
        }
    });

    const recModifier = store.get('recordShortcutModifier', isMac ? 'Command+Shift' : 'Control+Shift') as string;
    const recKey = store.get('recordShortcutKey', 'V') as string;
    const recordShortcut = `${recModifier}+${recKey}`;

    globalShortcut.register(recordShortcut, async () => {
        if ((app as any).isQuitting) return;
        console.log(`[latency] t=0ms  HOTKEY ${recordShortcut} → fullscreen recording`);
        const recState = getRecordingStateFn();
        if (recState.state === 'idle') {
            await startRecordingFromHotkeyFn();
        } else if (recState.state === 'recording') {
            await togglePauseFn();
        } else if (recState.state === 'paused') {
            await togglePauseFn();
        }
    });

    const stopModifier = store.get('stopShortcutModifier', isMac ? 'Command+Shift' : 'Control+Shift') as string;
    const stopKey = store.get('stopShortcutKey', 'S') as string;
    const stopShortcut = `${stopModifier}+${stopKey}`;

    globalShortcut.register(stopShortcut, async () => {
        if ((app as any).isQuitting) return;
        const recState = getRecordingStateFn();
        if (recState.state === 'recording' || recState.state === 'paused') {
            await stopRecordingFn();
        }
    });
}

// app импортируется через ленивое чтение, чтобы избежать циклов
import { app } from 'electron';