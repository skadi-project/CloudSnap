/**
 * Глобальные константы приложения. Сосредоточены здесь, чтобы избежать
 * magic numbers в коде и упростить тонкую настройку поведения.
 */

// === История ===
/** Максимальное число записей в истории снимков/видео. Старые записи вытесняются (с удалением миниатюр). */
export const MAX_HISTORY = 50;

// === Загрузка / IPC ===
/** Максимальный размер payload одного снимка после base64-декодирования (100 МБ). Защита от OOM через upload-file IPC. */
export const MAX_SCREENSHOT_BYTES = 100 * 1024 * 1024;

// === Display sources cache ===
/**
 * TTL кеша desktopCapturer.getSources(). Главное узкое место:
 * getSources() занимает 50-200ms; кешируем с инвалидацией на изменения
 * дисплеев и прогревом при старте.
 */
export const DISPLAY_CACHE_TTL_MS = 5000;

/** Задержки перед повторной проверкой соединения после потери (секунды). Экспоненциальный backoff. */
export const RECONNECT_INTERVALS = [5, 15, 30, 60] as const;
/** Интервал heartbeat-проверки соединения (секунды). */
export const HEARTBEAT_INTERVAL = 60;

// === Recording ===
/** Битрейт видео по умолчанию (бит/с). */
export const DEFAULT_VIDEO_BITRATE = 2_500_000;
/** FPS по умолчанию для MediaRecorder. */
export const DEFAULT_RECORDING_FPS = 30;
/** Записывать системный звук по умолчанию. */
export const DEFAULT_RECORD_AUDIO = true;

// === File operations ===
/** Порог размера файла (байт), выше которого пишем через stream вместо writeFileSync (избегаем RangeError на больших аллокациях). */
export const STREAMING_FILE_THRESHOLD = 50 * 1024 * 1024;
/** Размер чанка при стримовой записи (байт). */
export const FILE_WRITE_CHUNK_SIZE = 4 * 1024 * 1024;