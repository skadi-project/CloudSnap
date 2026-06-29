/**
 * Общие типы данных приложения. Импортируются по всему main-процессу.
 */

/** Запись в истории снимков/видео. */
export interface HistoryEntry {
    id: string;
    filename: string;
    type: string;
    timestamp: string;
    status: 'uploaded' | 'queued' | string;
    thumbnailPath: string | null;
    finalLink: string | null;
    filePath: string;
    serverUrl: string;
    linkMode: string;
    localPath: string | null;
}

/** Элемент очереди отложенных загрузок (файл не удалось отправить — кладём в pending-uploads и повторяем позже). */
export interface QueueItem {
    id: string;
    filename: string;
    localPath: string;
}

/** Границы окна (используется для per-window capture). */
export interface WindowBoundsData {
    x: number;
    y: number;
    w: number;
    h: number;
    /** base64-encoded заголовок окна — безопасный парсинг с учётом разделителей. */
    title?: string;
    /** desktopCapturer sourceId для per-window capture. */
    sourceId?: string | null;
    /**
     * Полные (не клиппированные) координаты окна в координатах дисплея-захвата.
     * Нужны renderer'у, чтобы обрезать результат getUserMedia(sourceId)
     * до подсвеченной области. См. display-utils.WindowBounds.fullX.
     */
    fullX?: number;
    fullY?: number;
    fullW?: number;
    fullH?: number;
}

/** Настройки приложения, сохраняемые в electron-store. */
export interface AppSettings {
    remoteFolder: string;
    folderStructure: 'none' | 'date' | 'user' | string;
    linkMode: 'internal' | 'public' | string;
    defaultDelay: number;
    autoStart: boolean;
    startMinimized: boolean;
    saveLocalCopy: boolean;
    videoBitrate: number;
    recordAudio: boolean;
    filenameTemplate: string;
    shortcutModifier: string;
    shortcutKey: string;
    recordShortcutModifier: string;
    recordShortcutKey: string;
    stopShortcutModifier: string;
    stopShortcutKey: string;
}

/** Результат WebDAV-загрузки. */
export interface UploadResult {
    success: boolean;
    url?: string;
    filePath?: string;
    error?: string;
}

/** Результат проверки соединения. */
export interface TestResult {
    success: boolean;
    error?: string;
}

/** Результат создания публичной ссылки через OCS API. */
export interface ShareResult {
    success: boolean;
    url?: string;
    error?: string;
}

/** Статус соединения с сервером. */
export type ConnectionStatus = 'connected' | 'disconnected' | 'reconnecting' | 'checking';

/** Сообщение о статусе для UI. */
export interface StatusUpdate {
    status: ConnectionStatus;
    message: string;
}