import { contextBridge, ipcRenderer, IpcRendererEvent } from 'electron';

contextBridge.exposeInMainWorld('electronAPI', {
    saveCredentials: (config: any) => ipcRenderer.invoke('save-credentials', config),
    loadCredentials: () => ipcRenderer.invoke('load-credentials'),
    uploadFile: (data: any) => ipcRenderer.invoke('upload-file', data),
    onScreenshotCaptured: (callback: (data: any) => void) =>
        ipcRenderer.on('screenshot-captured', (_event: IpcRendererEvent, data: any) => callback(data)),
    onScreenshotModeChanged: (callback: (mode: string) => void) =>
        ipcRenderer.on('screenshot-mode-changed', (_event: IpcRendererEvent, mode: string) => callback(mode)),
    onStatusUpdate: (callback: (value: string) => void) =>
        ipcRenderer.on('status-update', (_event: IpcRendererEvent, value: string) => callback(value)),

    onConnectionStatus: (callback: (data: { status: string; message: string }) => void) =>
        ipcRenderer.on('connection-status', (_event: IpcRendererEvent, data: { status: string; message: string }) => callback(data)),

    saveScreenshotMode: (mode: string) => ipcRenderer.send('save-screenshot-mode', mode),
    getScreenshotMode: () => ipcRenderer.invoke('get-screenshot-mode'),
    setScreenshotMode: (mode: string) => ipcRenderer.invoke('set-screenshot-mode', mode),

    saveAppSettings: (settings: any) => ipcRenderer.invoke('save-app-settings', settings),
    loadAppSettings: () => ipcRenderer.invoke('load-app-settings'),

    testConnection: (config: any) => ipcRenderer.invoke('test-connection', config),

    // === Monitor picker ===
    onDisplaysList: (callback: (data: any) => void) =>
        ipcRenderer.on('displays-list', (_event: IpcRendererEvent, data: any) => callback(data)),
    selectMonitor: (displayId: any) => ipcRenderer.send('selectMonitor', displayId),
    cancelMonitorPicker: () => ipcRenderer.send('cancelMonitorPicker'),

    // === Capture: multi-monitor ===
    onCaptureDisplaySwitched: (callback: (data: any) => void) =>
        ipcRenderer.on('capture-display-switched', (_event: IpcRendererEvent, data: any) => callback(data)),
    switchCaptureDisplay: (displayId: any) => ipcRenderer.invoke('switch-capture-display', displayId),

    openScreenshotsFolder: () => ipcRenderer.invoke('open-screenshots-folder'),

    getHistory: () => ipcRenderer.invoke('get-history'),
    copyHistoryLink: (id: string) => ipcRenderer.invoke('copy-history-link', id),
    openInNextcloud: (id: string) => ipcRenderer.invoke('open-in-nextcloud', id),
    deleteHistoryItem: (id: string) => ipcRenderer.invoke('delete-history-item', id),
    clearHistory: () => ipcRenderer.invoke('clear-history'),
    onHistoryUpdated: (callback: () => void) =>
        ipcRenderer.on('history-updated', (_event: IpcRendererEvent) => callback()),

    // === Recording: control (main window / overlay → main) ===
    startVideoRecording: () => ipcRenderer.invoke('start-video-recording'),
    startAreaRecording: () => ipcRenderer.invoke('start-area-recording'),
    togglePauseRecording: () => ipcRenderer.invoke('toggle-pause-recording'),
    stopRecording: () => ipcRenderer.invoke('stop-recording'),
    getRecordingState: () => ipcRenderer.invoke('get-recording-state'),

    // === Recording: state notifications (main → main window) ===
    onRecordingStateChanged: (callback: (data: any) => void) =>
        ipcRenderer.on('recording-state-changed', (_event: IpcRendererEvent, data: any) => callback(data)),

    // === Recording: recorder window (main → recorder) ===
    onInitRecording: (callback: (data: any) => void) =>
        ipcRenderer.on('init-recording', (_event: IpcRendererEvent, data: any) => callback(data)),
    onPauseRecording: (callback: () => void) =>
        ipcRenderer.on('pause-recording', (_event: IpcRendererEvent) => callback()),
    onResumeRecording: (callback: () => void) =>
        ipcRenderer.on('resume-recording', (_event: IpcRendererEvent) => callback()),
    onStopRecording: (callback: () => void) =>
        ipcRenderer.on('stop-recording', (_event: IpcRendererEvent) => callback()),

    // === Recording: recorder → main (data transfer) ===
    sendRecordingChunk: (data: any, sessionId: string) => ipcRenderer.send('recording-chunk', data, sessionId),
    sendRecordingFinished: () => ipcRenderer.send('recording-finished'),
    sendRecordingFirstFrame: (ts: number) => ipcRenderer.send('recording-first-frame', ts),
    sendRecordingThumbnail: (base64: string) => ipcRenderer.send('recording-thumbnail', base64),

    // === Recording: overlay window (main → overlay) ===
    onRecordingStarted: (callback: (data: any) => void) =>
        ipcRenderer.on('recording-started', (_event: IpcRendererEvent, data: any) => callback(data)),
    onRecordingPaused: (callback: () => void) =>
        ipcRenderer.on('recording-paused', (_event: IpcRendererEvent) => callback()),
    onRecordingResumed: (callback: () => void) =>
        ipcRenderer.on('recording-resumed', (_event: IpcRendererEvent) => callback()),
    onRecordingTimerUpdate: (callback: (seconds: number) => void) =>
        ipcRenderer.on('recording-timer-update', (_event: IpcRendererEvent, seconds: number) => callback(seconds)),

    // === Recording: area selector (selector → main) ===
    confirmAreaSelection: (area: any) => ipcRenderer.send('area-selected', area),
    cancelAreaSelection: () => ipcRenderer.send('area-selection-cancelled'),
});