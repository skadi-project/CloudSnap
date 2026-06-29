import * as path from 'path';
import type { Tray, Rectangle, NativeImage } from 'electron';
import { buildCapturePayload } from '../display-utils';
import {
    RecordingState,
    RecordingEvent,
    tryTransition,
    canTransition
} from './state-machine';
import {
    INotifier,
    IDisplaySource,
    IBrowserWindowFactory,
    IRecorderWindow,
    RecordingManagerDeps
} from './types';

// Интерфейс для информации о дисплее
export interface DisplayInfo {
    id: number;
    index: number;
    sourceId: string;
    bounds: Rectangle;
    scaleFactor?: number;
    thumbnail?: NativeImage;
}

// Интерфейс для записываемой области экрана
export interface RecordingArea {
    x: number;
    y: number;
    w: number;
    h: number;
    logicalX: number;
    logicalY: number;
    logicalW: number;
    logicalH: number;
}

// Простой интерфейс для входящих координат при подтверждении области
export interface AreaCoordinates {
    x: number;
    y: number;
    w: number;
    h: number;
}

// Минимальный интерфейс для хранилища настроек (например, electron-store)
export interface AppStore {
    get(key: string, defaultValue?: any): any;
}

/** Событие, которое RecordingManager отправляет подписчикам при смене состояния. */
export type StateChangeListener = (state: RecordingState) => void;

/**
 * Менеджер записи. Зависимости от electron (Notification, screen, BrowserWindow)
 * инжектируются через конструктор — это позволяет покрывать state-machine
 * и orchestration unit-тестами без моков electron.
 *
 * Если deps не переданы — поля зависимостей остаются undefined, и любой
 * метод, который пытается ими воспользоваться, бросит явную ошибку.
 * В src/main/index.ts зависимости создаются на основе реального electron
 * (см. ./electron-adapters.ts).
 */
export class RecordingManager {
    private state: RecordingState = 'idle';
    private recorderWindow: IRecorderWindow | null = null;
    private indicatorWindow: IRecorderWindow | null = null;
    private boundaryWindow: IRecorderWindow | null = null;
    private selectorWindow: IRecorderWindow | null = null;
    private recordingArea: RecordingArea | null = null;
    private activeDisplay: DisplayInfo | null = null;
    private startTime: number | null = null;
    private pausedDuration: number = 0;
    private pauseStartTime: number | null = null;
    private timerInterval: NodeJS.Timeout | null = null;
    private tray: Tray | null = null;
    private store: AppStore | null = null;
    private mainWindow: IRecorderWindow | null = null;
    private currentSessionId: string | null = null;

    private onStateChange: StateChangeListener | null = null;
    private onBeforeStart?: () => string;
    private getWindowBounds: (() => any[]) | null = null;
    private recordingT0: number = 0;

    private notifier: INotifier | undefined;
    private displaySource: IDisplaySource | undefined;
    private windowFactory: IBrowserWindowFactory | undefined;

    constructor(
        onStateChange?: StateChangeListener,
        deps?: RecordingManagerDeps
    ) {
        this.onStateChange = onStateChange || null;
        this.notifier = deps?.notifier;
        this.displaySource = deps?.displaySource;
        this.windowFactory = deps?.windowFactory;
    }

    /**
     * Устанавливает зависимости после конструирования. Удобно для тестов,
     * которые создают RecordingManager без deps, а потом инжектят моки.
     */
    setDeps(deps: RecordingManagerDeps): void {
        if (deps.notifier !== undefined) this.notifier = deps.notifier;
        if (deps.displaySource !== undefined) this.displaySource = deps.displaySource;
        if (deps.windowFactory !== undefined) this.windowFactory = deps.windowFactory;
    }

    /** Бросает, если хотя бы одна обязательная зависимость не инжектирована. */
    private requireDeps(): { notifier: INotifier; displaySource: IDisplaySource; windowFactory: IBrowserWindowFactory } {
        if (!this.notifier || !this.displaySource || !this.windowFactory) {
            throw new Error(
                'RecordingManager: dependencies not provided. ' +
                'Pass RecordingManagerDeps to the constructor or call setDeps().'
            );
        }
        return {
            notifier: this.notifier,
            displaySource: this.displaySource,
            windowFactory: this.windowFactory
        };
    }

    setTray(tray: Tray): void { this.tray = tray; }
    setStore(store: AppStore): void { this.store = store; }
    setMainWindow(win: IRecorderWindow): void { this.mainWindow = win; }
    /**
     * Регистрирует callback, вызываемый перед стартом записи.
     * Callback может вернуть sessionId — он будет передан в renderer
     * для защиты от race condition с устаревшими chunks.
     */
    setOnBeforeStart(cb: () => string): void { this.onBeforeStart = cb; }
    setGetWindowBounds(fn: () => any[]): void { this.getWindowBounds = fn; }
    /**
     * Устанавливает «нулевую точку» замера задержки. Прокидывается из main
     * через IPC в renderer в init-recording, чтобы все подсистемы использовали
     * единый timestamp без обращения к globalThis (который из-за
     * contextIsolation в renderer не совпадает с main).
     */
    setRecordingT0(t0: number): void { this.recordingT0 = t0; }
    getRecordingT0(): number { return this.recordingT0; }
    getCurrentSessionId(): string | null { return this.currentSessionId; }

    getState(): RecordingState { return this.state; }

    getActiveDisplayIndex(): number {
        return this.activeDisplay ? this.activeDisplay.index : 0;
    }

    getElapsedSeconds(): number {
        if (!this.startTime) return 0;
        let elapsed = (Date.now() - this.startTime - this.pausedDuration) / 1000;
        if (this.state === 'paused' && this.pauseStartTime) {
            elapsed -= (Date.now() - this.pauseStartTime) / 1000;
        }
        return Math.max(0, Math.floor(elapsed));
    }

    /**
     * Атомарная смена состояния через state machine.
     * Невалидный переход логируется и игнорируется (не бросает исключение).
     * При успехе вызывает _notify().
     */
    private setState(event: RecordingEvent): void {
        const next = tryTransition(this.state, event);
        if (next === null) {
            console.warn(`[state-machine] invalid transition: ${event.type} from '${this.state}'${event.reason ? ` (${event.reason})` : ''}`);
            return;
        }
        const prev = this.state;
        this.state = next;
        if (prev !== next) this._notify();
    }

    private _notify(): void {
        try {
            if (this.onStateChange) this.onStateChange(this.state);
        } catch (err) {
            const errorMessage = err instanceof Error ? err.message : String(err);
            console.error('Error in onStateChange callback:', errorMessage);
        }
    }

    async startFullscreen(displayInfo: DisplayInfo): Promise<void> {
        // Guard: можно стартовать только из idle
        if (!canTransition(this.state, 'START_FULLSCREEN')) {
            console.warn(`[recording] startFullscreen ignored, current state: ${this.state}`);
            return;
        }
        if (!displayInfo || !displayInfo.sourceId) {
            this.requireDeps().notifier.notify('CloudSnap', 'Источник экрана не найден');
            return;
        }

        this.activeDisplay = displayInfo;
        this.recordingArea = null;
        // Переход сразу в 'recording' (а не ждём did-finish-load) — это
        // упрощает модель: после START_FULLSCREEN состояние всегда 'recording'.
        // Защита от pause/resume в окне до загрузки MediaRecorder —
        // ответственность renderer'а.
        this.setState({ type: 'START_FULLSCREEN' });

        try {
            await this._createRecorderAndOverlay(displayInfo.sourceId);
        } catch (err) {
            console.error('Ошибка startFullscreen:', err);
            this.activeDisplay = null;
            this.setState({ type: 'EMERGENCY_STOP', reason: 'startFullscreen failed' });
        }
    }

    async startAreaSelection(displayInfo: DisplayInfo): Promise<void> {
        if (!canTransition(this.state, 'START_AREA_SELECTION')) {
            console.warn(`[recording] startAreaSelection ignored, current state: ${this.state}`);
            return;
        }
        if (!displayInfo || !displayInfo.thumbnail) return;

        this.activeDisplay = displayInfo;
        this.setState({ type: 'START_AREA_SELECTION' });

        try {
            const { bounds } = displayInfo;
            const screenImageSrc = displayInfo.thumbnail.toDataURL();
            const windowBounds = this.getWindowBounds ? this.getWindowBounds() : [];
            const { windowFactory } = this.requireDeps();

            this.selectorWindow = windowFactory.create({
                x: bounds.x,
                y: bounds.y,
                width: bounds.width,
                height: bounds.height,
                frame: false,
                transparent: true,
                backgroundColor: '#00000000',
                alwaysOnTop: true,
                skipTaskbar: true,
                webPreferences: {
                    preload: path.join(__dirname, '..', '..', 'preload.js'),
                    contextIsolation: true,
                    nodeIntegration: false
                }
            });

            this.selectorWindow.loadFile(path.join(__dirname, '..', 'ui', 'area-selector', 'selector.html'));

            const payload = buildCapturePayload(
                displayInfo as any,
                screenImageSrc,
                'area',
                windowBounds
            );

            this.selectorWindow.webContents.on('did-finish-load', () => {
                this.selectorWindow?.webContents.send('screenshot-captured', payload);
            });

            this.selectorWindow.on('closed', () => {
                this.selectorWindow = null;
                // Если мы всё ещё в 'selecting' — пользователь закрыл окно
                // крестиком, не подтвердив выбор. Возвращаемся в idle.
                if (this.state === 'selecting') {
                    this.activeDisplay = null;
                    this.setState({ type: 'CANCEL_AREA_SELECTION', reason: 'selector window closed' });
                }
            });
        } catch (err) {
            console.error('Ошибка startAreaSelection:', err);
            this.activeDisplay = null;
            this.setState({ type: 'EMERGENCY_STOP', reason: 'startAreaSelection failed' });
        }
    }

    async confirmArea(area: AreaCoordinates): Promise<void> {
        if (!canTransition(this.state, 'CONFIRM_AREA')) {
            console.warn(`[recording] confirmArea ignored, current state: ${this.state}`);
            return;
        }
        if (this.selectorWindow) {
            this.selectorWindow.close();
            this.selectorWindow = null;
        }

        const display = this.activeDisplay;
        if (!display) {
            this.setState({ type: 'CANCEL_AREA_SELECTION', reason: 'no active display' });
            return;
        }

        console.log(`[latency] t=${this.recordingT0 ? Date.now() - this.recordingT0 : 0}ms  confirmArea:`, JSON.stringify({x: area.x, y: area.y, w: area.w, h: area.h}));
        // Используем scaleFactor из renderer — он соответствует реальному
        // масштабу thumbnail, а не абстрактному display.scaleFactor
        const sf = (area as any).scaleFactor || display.scaleFactor || 1;
        const offsetX = display.bounds.x;
        const offsetY = display.bounds.y;

        this.recordingArea = {
            x: Math.round(area.x * sf),
            y: Math.round(area.y * sf),
            w: Math.round(area.w * sf),
            h: Math.round(area.h * sf),
            logicalX: offsetX + area.x,
            logicalY: offsetY + area.y,
            logicalW: area.w,
            logicalH: area.h
        };

        this.setState({ type: 'CONFIRM_AREA' });

        try {
            await this._createRecorderAndOverlay(display.sourceId);
        } catch (err) {
            console.error('Ошибка confirmArea:', err);
            this.activeDisplay = null;
            this.recordingArea = null;
            this.setState({ type: 'EMERGENCY_STOP', reason: 'confirmArea failed' });
        }
    }

    cancelAreaSelection(): void {
        if (this.selectorWindow) {
            this.selectorWindow.close();
            this.selectorWindow = null;
        }
        this.activeDisplay = null;
        this.setState({ type: 'CANCEL_AREA_SELECTION', reason: 'user cancel' });
    }

    private async _createRecorderAndOverlay(sourceId: string): Promise<void> {
        const tRecMgr = Date.now();
        if (this.onBeforeStart) this.currentSessionId = this.onBeforeStart();
        this.startTime = Date.now();
        this.pausedDuration = 0;
        this.pauseStartTime = null;
        console.log(`[latency] t=${this.recordingT0 ? tRecMgr - this.recordingT0 : 0}ms  _createRecorderAndOverlay start, recordingArea=${this.recordingArea ? JSON.stringify({x: this.recordingArea.x, y: this.recordingArea.y, w: this.recordingArea.w, h: this.recordingArea.h}) : 'null (fullscreen)'}`);

        const bitrate = this.store ? this.store.get('videoBitrate', 2500000) : 2500000;
        const recordAudio = this.store ? this.store.get('recordAudio', true) : true;
        console.log('[bitrate] _createRecorderAndOverlay → store.videoBitrate =', bitrate,
            `(${(bitrate / 1_000_000).toFixed(2)} Мбит/с)`, 'audio=', recordAudio);

        const { notifier, displaySource, windowFactory } = this.requireDeps();

        this.recorderWindow = windowFactory.create({
            show: false,
            width: 320, height: 240,
            webPreferences: {
                preload: path.join(__dirname, '..', '..', 'preload.js'),
                contextIsolation: true,
                nodeIntegration: false
            }
        });
        this.recorderWindow.loadFile(path.join(__dirname, '..', 'ui', 'recorder-window', 'recorder.html'));
        this.recorderWindow.setBackgroundThrottling(false);

        this.recorderWindow.webContents.on('did-finish-load', () => {
            const tLoad = Date.now();
            console.log(`[latency] t=${this.recordingT0 ? tLoad - this.recordingT0 : 0}ms  recorderWindow did-finish-load → sending init-recording`);
            this.recorderWindow?.webContents.send('init-recording', {
                sourceId,
                cropRect: this.recordingArea,
                bitrate,
                fps: 30,
                audio: recordAudio,
                sessionId: this.currentSessionId,
                t0: this.recordingT0
            });
        });

        this.recorderWindow.on('closed', () => {
            this.recorderWindow = null;
            if (this.state === 'recording' || this.state === 'paused') {
                this._emergencyStop('Recorder window unexpectedly closed');
            }
        });

        const targetDisplay = this.activeDisplay
            ? displaySource.getAllDisplays().find(d => d.id === this.activeDisplay?.id) || displaySource.getPrimaryDisplay()
            : displaySource.getPrimaryDisplay();

        const iw = 240, ih = 50;
        this.indicatorWindow = windowFactory.create({
            width: iw, height: ih,
            x: targetDisplay.bounds.x + targetDisplay.bounds.width - iw - 10,
            y: targetDisplay.bounds.y + 10,
            frame: false, transparent: true, alwaysOnTop: true,
            skipTaskbar: true, resizable: false,
            webPreferences: {
                preload: path.join(__dirname, '..', '..', 'preload.js'),
                contextIsolation: true,
                nodeIntegration: false
            }
        });
        this.indicatorWindow.loadFile(path.join(__dirname, '..', 'ui', 'recording-overlay', 'overlay.html'));

        this.indicatorWindow.webContents.on('did-finish-load', () => {
            this.indicatorWindow?.webContents.send('recording-started', {
                isFullscreen: !this.recordingArea,
                area: this.recordingArea
            });
        });
        this.indicatorWindow.on('closed', () => { this.indicatorWindow = null; });

        if (this.recordingArea) {
            const pad = 20;
            this.boundaryWindow = windowFactory.create({
                x: this.recordingArea.logicalX - pad,
                y: this.recordingArea.logicalY - pad,
                width: this.recordingArea.logicalW + pad * 2,
                height: this.recordingArea.logicalH + pad * 2,
                frame: false, transparent: true, alwaysOnTop: true,
                skipTaskbar: true, hasShadow: false, resizable: false,
                webPreferences: {
                    preload: path.join(__dirname, '..', '..', 'preload.js'),
                    contextIsolation: true,
                    nodeIntegration: false
                }
            });
            this.boundaryWindow.setIgnoreMouseEvents(true);
            this.boundaryWindow.loadFile(path.join(__dirname, '..', 'ui', 'recording-overlay', 'boundary.html'));
            this.boundaryWindow.on('closed', () => { this.boundaryWindow = null; });
        }

        this._startTimer();

        notifier.notify('CloudSnap', 'Запись видео начата');
    }

    pause(): void {
        if (!canTransition(this.state, 'PAUSE')) {
            console.warn(`[recording] pause ignored, current state: ${this.state}`);
            return;
        }
        this.setState({ type: 'PAUSE' });
        this.pauseStartTime = Date.now();
        if (this.recorderWindow) this.recorderWindow.webContents.send('pause-recording');
        if (this.indicatorWindow) this.indicatorWindow.webContents.send('recording-paused');
        this.requireDeps().notifier.notify('CloudSnap', 'Запись приостановлена');
    }

    resume(): void {
        if (!canTransition(this.state, 'RESUME')) {
            console.warn(`[recording] resume ignored, current state: ${this.state}`);
            return;
        }
        if (this.pauseStartTime) {
            this.pausedDuration += Date.now() - this.pauseStartTime;
        }
        this.pauseStartTime = null;
        this.setState({ type: 'RESUME' });
        if (this.recorderWindow) this.recorderWindow.webContents.send('resume-recording');
        if (this.indicatorWindow) this.indicatorWindow.webContents.send('recording-resumed');
        this.requireDeps().notifier.notify('CloudSnap', 'Запись продолжена');
    }

    stop(): void {
        if (!canTransition(this.state, 'STOP')) {
            console.warn(`[recording] stop ignored, current state: ${this.state}`);
            return;
        }
        if (this.pauseStartTime) {
            this.pausedDuration += Date.now() - this.pauseStartTime;
            this.pauseStartTime = null;
        }
        this.setState({ type: 'STOP' });
        this._stopTimer();

        if (this.recorderWindow) this.recorderWindow.webContents.send('stop-recording');
        if (this.indicatorWindow) { this.indicatorWindow.close(); this.indicatorWindow = null; }
        if (this.boundaryWindow) { this.boundaryWindow.close(); this.boundaryWindow = null; }
    }

    cleanup(): void {
        if (!canTransition(this.state, 'CLEANUP')) {
            // cleanup() — после processRecordingData; может вызываться из любого состояния
            // для сброса. Если состояние не 'stopping' — это force cleanup.
            console.warn(`[recording] cleanup from non-stopping state: ${this.state}, using FORCE_STOP`);
            this.forceStop();
            return;
        }
        if (this.recorderWindow) { this.recorderWindow.close(); this.recorderWindow = null; }
        this.recordingArea = null;
        this.activeDisplay = null;
        this.startTime = null;
        this.pausedDuration = 0;
        this.pauseStartTime = null;
        this.currentSessionId = null;
        this.setState({ type: 'CLEANUP' });
    }

    forceStop(): void {
        this._stopTimer();
        if (this.recorderWindow) { this.recorderWindow.destroy(); this.recorderWindow = null; }
        if (this.indicatorWindow) { this.indicatorWindow.destroy(); this.indicatorWindow = null; }
        if (this.boundaryWindow) { this.boundaryWindow.destroy(); this.boundaryWindow = null; }
        if (this.selectorWindow) { this.selectorWindow.destroy(); this.selectorWindow = null; }
        this.recordingArea = null;
        this.activeDisplay = null;
        this.startTime = null;
        this.setState({ type: 'FORCE_STOP', reason: 'forceStop()' });
    }

    private _emergencyStop(reason: string): void {
        console.error('Emergency stop:', reason);
        this._stopTimer();
        // Закрываем recorderWindow — раньше не закрывали, MediaRecorder
        // не получал сигнал stop, окно висело в памяти, chunks утекали.
        if (this.recorderWindow) { this.recorderWindow.close(); this.recorderWindow = null; }
        if (this.indicatorWindow) { this.indicatorWindow.close(); this.indicatorWindow = null; }
        if (this.boundaryWindow) { this.boundaryWindow.close(); this.boundaryWindow = null; }
        this.activeDisplay = null;
        this.currentSessionId = null;
        this.setState({ type: 'EMERGENCY_STOP', reason });
        // notifier может отсутствовать в тестах — используем опциональный вызов
        this.notifier?.notify('CloudSnap', 'Запись остановлена: ' + reason);
    }

    private _startTimer(): void {
        this.timerInterval = setInterval(() => {
            const elapsed = this.getElapsedSeconds();
            if (this.indicatorWindow) {
                this.indicatorWindow.webContents.send('recording-timer-update', elapsed);
            }
            if (this.mainWindow && !this.mainWindow.isDestroyed()) {
                this.mainWindow.webContents.send('recording-timer-update', elapsed);
            }
        }, 1000);
    }

    private _stopTimer(): void {
        if (this.timerInterval) {
            clearInterval(this.timerInterval);
            this.timerInterval = null;
        }
    }
}

// Re-export state machine helpers для удобства тестов и подписчиков.
export {
    RecordingState,
    RecordingEvent,
    tryTransition,
    canTransition,
    allowedEventsFrom,
    isTerminal,
    InvalidTransitionError
} from './state-machine';