export const DEFAULT_TEMPLATE = 'CS_{type}_{datetime}';

export interface GenerateFilenameOptions {
    date?: Date;
    user?: string;
    ext?: string;
    monitor?: string | number | null;
}

function sanitizeFilenamePart(value: string | number): string {
    return String(value).replace(/[<>:"/\\|?*\x00-\x1f]/g, '_').trim() || 'file';
}

/**
 * Генерирует имя файла на основе шаблона и метаданных.
 */
export function generateFilename(
    template: string | null | undefined, 
    type: 'video' | 'image' | string, 
    options: GenerateFilenameOptions = {}
): string {
    const now = options.date instanceof Date ? options.date : new Date();
    const user = sanitizeFilenamePart(options.user || 'user');
    // По умолчанию видео теперь в MP4 (H.264/AAC через Mediabunny WebCodecs),
    // а не в WebM. Можно переопределить через options.ext.
    const ext = options.ext || (type === 'video' ? 'mp4' : 'png');
    const fileType = type === 'video' ? 'video' : 'image';

    // ВАЖНО: используем ЛОКАЛЬНОЕ время компьютера, на котором сделан снимок,
    // а не UTC. toISOString() возвращает UTC — для пользователя имя файла
    // «убегает» на несколько часов. Геттеры Date всегда дают локальное время.
    const pad2 = (n: number) => String(n).padStart(2, '0');
    const yyyy = now.getFullYear();
    const mm = pad2(now.getMonth() + 1);
    const dd = pad2(now.getDate());
    const HH = pad2(now.getHours());
    const MM = pad2(now.getMinutes());
    const SS = pad2(now.getSeconds());
    const date = `${yyyy}-${mm}-${dd}`;
    const time = `${HH}-${MM}-${SS}`;
    const datetime = `${date}_${HH}-${MM}-${SS}`;

    const resolvedTemplate = template && template.trim() ? template.trim() : DEFAULT_TEMPLATE;

    let name = resolvedTemplate
        .replace(/\{type\}/g, fileType)
        .replace(/\{date\}/g, date)
        .replace(/\{time\}/g, time)
        .replace(/\{datetime\}/g, datetime)
        .replace(/\{user\}/g, user)
        .replace(/\{monitor\}/g, sanitizeFilenamePart(options.monitor != null ? options.monitor : '1'));

    name = sanitizeFilenamePart(name.replace(/\.(png|webm|mp4|jpg|jpeg)$/i, ''));

    return `${name}.${ext}`;
}

/**
 * Генерирует уникальный ID для записи в историю.
 * Используем ЛОКАЛЬНОЕ время (а не UTC через toISOString) — иначе ID отстаёт
 * от системных часов пользователя и сортировка истории сбивается.
 */
export function generateFileId(now: Date = new Date()): string {
    const pad2 = (n: number) => String(n).padStart(2, '0');
    return `cs_${now.getFullYear()}-${pad2(now.getMonth() + 1)}-${pad2(now.getDate())}` +
        `_${pad2(now.getHours())}-${pad2(now.getMinutes())}-${pad2(now.getSeconds())}`;
}