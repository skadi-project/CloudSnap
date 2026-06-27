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
    const ext = options.ext || (type === 'video' ? 'webm' : 'png');
    const fileType = type === 'video' ? 'video' : 'image';

    const date = now.toISOString().slice(0, 10);
    const time = now.toTimeString().slice(0, 8).replace(/:/g, '-');
    const datetime = now.toISOString().replace(/[:.]/g, '-').slice(0, 19);

    const resolvedTemplate = template && template.trim() ? template.trim() : DEFAULT_TEMPLATE;

    let name = resolvedTemplate
        .replace(/\{type\}/g, fileType)
        .replace(/\{date\}/g, date)
        .replace(/\{time\}/g, time)
        .replace(/\{datetime\}/g, datetime)
        .replace(/\{user\}/g, user)
        .replace(/\{monitor\}/g, sanitizeFilenamePart(options.monitor != null ? options.monitor : '1'));

    name = sanitizeFilenamePart(name.replace(/\.(png|webm|jpg|jpeg)$/i, ''));

    return `${name}.${ext}`;
}

/**
 * Генерирует уникальный ID для записи в историю.
 */
export function generateFileId(now: Date = new Date()): string {
    return `cs_${now.toISOString().replace(/[:.]/g, '-').slice(0, 19)}`;
}