import { BrowserWindow, screen, Notification, Tray, Rectangle, NativeImage } from 'electron';
import * as path from 'path';
import { buildCapturePayload } from './display-utils';

// Ограничиваем возможные состояния записи текстовым литералом
export type RecordingState = 'idle' | 'selecting' | 'recording' | 'paused' | 'stopping';

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

export class RecordingManager {
    private state: RecordingState = 'idle';
    private recorderWindow: BrowserWindow | null = null;
    private indicatorWindow: BrowserWindow | null = null;
    private boundaryWindow: BrowserWindow | null = null;
    private selectorWindow: BrowserWindow | null = null;
    private recordingArea: RecordingArea | null = null;
    private activeDisplay: DisplayInfo | null = null;
    private startTime: number | null = null;
    private pausedDuration: number = 0;
    private pauseStartTime: number | null = null;
    private timerInterval: NodeJS.Timeout | null = null;
    private tray: Tray | null = null;
    private store: AppStore | null = null;
    private mainWindow: BrowserWindow | null = null;
    
    private onStateChange: ((state: RecordingState) => void) | null = null;
    private onBeforeStart?: () => void;
    private getWindowBounds: (() => any[]) | null = null;

    constructor(onStateChange?: (state: RecordingState) => void) {
        this.onStateChange = onStateChange || null;
    }

    setTray(tray: Tray): void { this.tray = tray; }
    setStore(store: AppStore): void { this.store = store; }
    setMainWindow(win: BrowserWindow): void { this.mainWindow = win; }
    setOnBeforeStart(cb: () => void): void { this.onBeforeStart = cb; }
    setGetWindowBounds(fn: () => any[]): void { this.getWindowBounds = fn; }

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

    private _notify(): void {
        try {
            if (this.onStateChange) this.onStateChange(this.state);
        } catch (err) {
            const errorMessage = err instanceof Error ? err.message : String(err);
            console.error('Error in onStateChange callback:', errorMessage);
        }
    }

    async startFullscreen(displayInfo: DisplayInfo): Promise<void> {
        if (this.state !== 'idle') return;
        if (!displayInfo || !displayInfo.sourceId) {
            new Notification({ title: 'CloudSnap', body: 'Источник экрана не найден' }).show();
            return;
        }

        try {
            this.activeDisplay = displayInfo;
            this.recordingArea = null;
            await this._createRecorderAndOverlay(displayInfo.sourceId);
        } catch (err) {
            console.error('Ошибка startFullscreen:', err);
            this.state = 'idle';
            this.activeDisplay = null;
            this._notify();
        }
    }

    async startAreaSelection(displayInfo: DisplayInfo): Promise<void> {
        if (this.state !== 'idle') return;
        if (!displayInfo || !displayInfo.thumbnail) return;

        this.activeDisplay = displayInfo;
        this.state = 'selecting';
        this._notify();

        try {
            const { bounds } = displayInfo;
            const screenImageSrc = displayInfo.thumbnail.toDataURL();
            const windowBounds = this.getWindowBounds ? this.getWindowBounds() : [];

            this.selectorWindow = new BrowserWindow({
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
                    preload: path.join(__dirname, '..', 'preload.js'),
                    contextIsolation: true,
                    nodeIntegration: false
                }
            });

            this.selectorWindow.loadFile(path.join(__dirname, 'ui', 'area-selector', 'selector.html'));

            // Приводим к any, чтобы избежать конфликта типов DisplayInfo и DisplaySourceInfo
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
                if (this.state === 'selecting') {
                    this.state = 'idle';
                    this.activeDisplay = null;
                    this._notify();
                }
            });
        } catch (err) {
            console.error('Ошибка startAreaSelection:', err);
            this.state = 'idle';
            this.activeDisplay = null;
            this._notify();
        }
    }

    async confirmArea(area: AreaCoordinates): Promise<void> {
        if (this.state !== 'selecting' || !this.activeDisplay) return;
        if (this.selectorWindow) {
            this.selectorWindow.close();
            this.selectorWindow = null;
        }

        try {
            const display = this.activeDisplay;
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

            await this._createRecorderAndOverlay(display.sourceId);
        } catch (err) {
            console.error('Ошибка confirmArea:', err);
            this.state = 'idle';
            this.activeDisplay = null;
            this._notify();
        }
    }

    cancelAreaSelection(): void {
        if (this.selectorWindow) {
            this.selectorWindow.close();
            this.selectorWindow = null;
        }
        this.state = 'idle';
        this.activeDisplay = null;
        this._notify();
    }

    private async _createRecorderAndOverlay(sourceId: string): Promise<void> {
        if (this.onBeforeStart) this.onBeforeStart();
        this.state = 'recording';
        this.startTime = Date.now();
        this.pausedDuration = 0;
        this.pauseStartTime = null;

        const bitrate = this.store ? this.store.get('videoBitrate', 2500000) : 2500000;
        const recordAudio = this.store ? this.store.get('recordAudio', true) : true;

        this.recorderWindow = new BrowserWindow({
            show: false,
            width: 320, height: 240,
            webPreferences: {
                preload: path.join(__dirname, '..', 'preload.js'),
                contextIsolation: true,
                nodeIntegration: false
            }
        });
        this.recorderWindow.loadFile(path.join(__dirname, 'ui', 'recorder-window', 'recorder.html'));
        this.recorderWindow.webContents.setBackgroundThrottling(false);

        this.recorderWindow.webContents.on('did-finish-load', () => {
            this.recorderWindow?.webContents.send('init-recording', {
                sourceId,
                cropRect: this.recordingArea,
                bitrate,
                fps: 30,
                audio: recordAudio
            });
        });

        this.recorderWindow.on('closed', () => {
            this.recorderWindow = null;
            if (this.state === 'recording' || this.state === 'paused') {
                this._emergencyStop('Recorder window unexpectedly closed');
            }
        });

        const targetDisplay = this.activeDisplay
            ? screen.getAllDisplays().find(d => d.id === this.activeDisplay?.id) || screen.getPrimaryDisplay()
            : screen.getPrimaryDisplay();

        const iw = 240, ih = 50;
        this.indicatorWindow = new BrowserWindow({
            width: iw, height: ih,
            x: targetDisplay.bounds.x + targetDisplay.bounds.width - iw - 10,
            y: targetDisplay.bounds.y + 10,
            frame: false, transparent: true, alwaysOnTop: true,
            skipTaskbar: true, resizable: false,
            webPreferences: {
                preload: path.join(__dirname, '..', 'preload.js'),
                contextIsolation: true,
                nodeIntegration: false
            }
        });
        this.indicatorWindow.loadFile(path.join(__dirname, 'ui', 'recording-overlay', 'overlay.html'));

        this.indicatorWindow.webContents.on('did-finish-load', () => {
            this.indicatorWindow?.webContents.send('recording-started', {
                isFullscreen: !this.recordingArea,
                area: this.recordingArea
            });
        });
        this.indicatorWindow.on('closed', () => { this.indicatorWindow = null; });

        if (this.recordingArea) {
            const pad = 20;
            this.boundaryWindow = new BrowserWindow({
                x: this.recordingArea.logicalX - pad,
                y: this.recordingArea.logicalY - pad,
                width: this.recordingArea.logicalW + pad * 2,
                height: this.recordingArea.logicalH + pad * 2,
                frame: false, transparent: true, alwaysOnTop: true,
                skipTaskbar: true, hasShadow: false, resizable: false,
                webPreferences: {
                    preload: path.join(__dirname, '..', 'preload.js'),
                    contextIsolation: true,
                    nodeIntegration: false
                }
            });
            this.boundaryWindow.setIgnoreMouseEvents(true);
            this.boundaryWindow.loadFile(path.join(__dirname, 'ui', 'recording-overlay', 'boundary.html'));
            this.boundaryWindow.on('closed', () => { this.boundaryWindow = null; });
        }

        this._startTimer();
        this._notify();

        new Notification({ title: 'CloudSnap', body: 'Запись видео начата' }).show();
    }

    pause(): void {
        if (this.state !== 'recording') return;
        this.state = 'paused';
        this.pauseStartTime = Date.now();
        if (this.recorderWindow) this.recorderWindow.webContents.send('pause-recording');
        if (this.indicatorWindow) this.indicatorWindow.webContents.send('recording-paused');
        this._notify();
        new Notification({ title: 'CloudSnap', body: 'Запись приостановлена' }).show();
    }

    resume(): void {
        if (this.state !== 'paused') return;
        if (this.pauseStartTime) {
            this.pausedDuration += Date.now() - this.pauseStartTime;
        }
        this.pauseStartTime = null;
        this.state = 'recording';
        if (this.recorderWindow) this.recorderWindow.webContents.send('resume-recording');
        if (this.indicatorWindow) this.indicatorWindow.webContents.send('recording-resumed');
        this._notify();
        new Notification({ title: 'CloudSnap', body: 'Запись продолжена' }).show();
    }

    stop(): void {
        if (this.state !== 'recording' && this.state !== 'paused') return;
        if (this.pauseStartTime) {
            this.pausedDuration += Date.now() - this.pauseStartTime;
            this.pauseStartTime = null;
        }
        this.state = 'stopping';
        this._stopTimer();

        if (this.recorderWindow) this.recorderWindow.webContents.send('stop-recording');
        if (this.indicatorWindow) { this.indicatorWindow.close(); this.indicatorWindow = null; }
        if (this.boundaryWindow) { this.boundaryWindow.close(); this.boundaryWindow = null; }

        this._notify();
    }

    cleanup(): void {
        if (this.recorderWindow) { this.recorderWindow.close(); this.recorderWindow = null; }
        this.state = 'idle';
        this.recordingArea = null;
        this.activeDisplay = null;
        this.startTime = null;
        this.pausedDuration = 0;
        this.pauseStartTime = null;
        this._notify();
    }

    forceStop(): void {
        this._stopTimer();
        if (this.recorderWindow) { this.recorderWindow.destroy(); this.recorderWindow = null; }
        if (this.indicatorWindow) { this.indicatorWindow.destroy(); this.indicatorWindow = null; }
        if (this.boundaryWindow) { this.boundaryWindow.destroy(); this.boundaryWindow = null; }
        if (this.selectorWindow) { this.selectorWindow.destroy(); this.selectorWindow = null; }
        this.state = 'idle';
        this.recordingArea = null;
        this.activeDisplay = null;
        this.startTime = null;
        this._notify();
    }

    private _emergencyStop(reason: string): void {
        console.error('Emergency stop:', reason);
        this._stopTimer();
        if (this.indicatorWindow) { this.indicatorWindow.close(); this.indicatorWindow = null; }
        if (this.boundaryWindow) { this.boundaryWindow.close(); this.boundaryWindow = null; }
        this.state = 'idle';
        this.activeDisplay = null;
        this._notify();
        new Notification({ title: 'CloudSnap', body: 'Запись остановлена: ' + reason }).show();
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