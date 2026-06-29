/**
 * Оркестрация записи видео: общие entry points для tray, hotkey и IPC.
 *
 * Заменяет дублированную логику из старого main.ts. Все четыре источника
 * старта записи (tray, hotkey, IPC UI, IPC overlay) теперь сходятся здесь
 * и используют единый pipeline:
 *   1. выбор/разрешение дисплея
 *   2. запуск recordingManager.startFullscreen или startAreaSelection
 *
 * `recordingT0` (нулевая точка для latency-логов) инициализируется здесь,
 * чтобы все пути старта использовали одинаковую методику замера.
 */

import type { RecordingManager } from '../../recording/recording-manager';

let recordingManagerGetter: () => RecordingManager | null = () => null;
let pickDisplayFn: (mode: string, preferredDisplayId?: string | number | null) => Promise<any> = async () => null;
let resolveTargetDisplayFn: (preferredDisplayId?: string | number | null) => Promise<any> = async () => null;

export function setRecordingManagerGetter(fn: () => RecordingManager | null): void {
    recordingManagerGetter = fn;
}
export function setPickDisplayFn(fn: typeof pickDisplayFn): void {
    pickDisplayFn = fn;
}
export function setResolveTargetDisplayFn(fn: typeof resolveTargetDisplayFn): void {
    resolveTargetDisplayFn = fn;
}

function getRm(): RecordingManager | null {
    return recordingManagerGetter();
}

export function setRecordingT0(t0: number): void {
    const rm = getRm();
    if (rm) rm.setRecordingT0(t0);
}

/** Tray / menu вызывает: пользователь выбирает дисплей через picker. */
export async function startRecordingFromTray(mode: 'fullscreen' | 'area'): Promise<void> {
    const rm = getRm();
    if (!rm) return;
    const pickerMode = mode === 'area' ? 'record-area' : 'record-fullscreen';
    const t0 = Date.now();
    rm.setRecordingT0(t0);
    console.log(`[latency] t=0ms  startRecordingFromTray mode=${mode}`);
    const displayInfo = await pickDisplayFn(pickerMode);
    if (!displayInfo) {
        console.log('[latency] pickDisplay cancelled');
        return;
    }
    console.log(`[latency] t=${Date.now() - t0}ms  display picked: id=${displayInfo.id} label="${displayInfo.label}"`);
    if (mode === 'area') {
        await rm.startAreaSelection(displayInfo);
    } else {
        await rm.startFullscreen(displayInfo);
    }
}

/** Hotkey: пропускает picker, берёт дисплей под курсором. */
export async function startRecordingFromHotkey(): Promise<void> {
    const rm = getRm();
    if (!rm) return;
    const t0 = Date.now();
    rm.setRecordingT0(t0);
    console.log(`[latency] t=0ms  HOTKEY → fullscreen recording`);
    const displayInfo = await resolveTargetDisplayFn();
    if (displayInfo) {
        console.log(`[latency] t=${Date.now() - t0}ms  display resolved`);
        await rm.startFullscreen(displayInfo);
    }
}

/** IPC: start-video-recording — пользователь нажал кнопку, picker нужен. */
export async function startRecordingFromIpc(mode: 'fullscreen' | 'area'): Promise<{ success: boolean; cancelled?: boolean }> {
    const rm = getRm();
    if (!rm) return { success: false };
    const pickerMode = mode === 'area' ? 'record-area' : 'record-fullscreen';
    const t0 = Date.now();
    rm.setRecordingT0(t0);
    console.log(`[latency] t=0ms  start-${mode}-recording (UI)`);
    const displayInfo = await pickDisplayFn(pickerMode);
    if (!displayInfo) return { success: false, cancelled: true };
    console.log(`[latency] t=${Date.now() - t0}ms  display picked`);
    if (mode === 'area') {
        await rm.startAreaSelection(displayInfo);
    } else {
        await rm.startFullscreen(displayInfo);
    }
    return { success: true };
}

export async function togglePause(): Promise<{ success: boolean; state: string }> {
    const rm = getRm();
    if (!rm) return { success: false, state: 'idle' };
    const state = rm.getState();
    if (state === 'recording') rm.pause();
    else if (state === 'paused') rm.resume();
    return { success: true, state: rm.getState() };
}

export async function stopRecording(): Promise<{ success: boolean }> {
    const rm = getRm();
    if (!rm) return { success: false };
    rm.stop();
    return { success: true };
}

export function getRecordingState(): { state: string; elapsed: number } {
    const rm = getRm();
    if (!rm) return { state: 'idle', elapsed: 0 };
    return { state: rm.getState(), elapsed: rm.getElapsedSeconds() };
}