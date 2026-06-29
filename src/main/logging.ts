/**
 * Обёртка над console с уровнями и автоматической фильтрацией чувствительных полей.
 *
 * Использование:
 *   const log = createLogger('upload');
 *   log.debug('starting upload', { url, login });   // НЕ логируется в production
 *   log.info('upload ok', { url });
 *   log.warn('HTTP без TLS', { url });
 *   log.error('upload failed', { error });
 *
 * Чувствительные ключи (password, token, key, secret, authorization) автоматически
 * заменяются на '[REDACTED]' при логировании.
 */

export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

const LEVEL_PRIORITY: Record<LogLevel, number> = {
    debug: 10,
    info: 20,
    warn: 30,
    error: 40
};

const SENSITIVE_KEYS = new Set([
    'password', 'passwd', 'token', 'key', 'secret',
    'authorization', 'auth', 'apikey', 'api_key'
]);

/** Рекурсивно маскирует значения по списку чувствительных ключей (только строковые значения). */
function redact<T>(value: T): T {
    if (value === null || value === undefined) return value;
    if (Array.isArray(value)) {
        return value.map((v) => redact(v)) as unknown as T;
    }
    if (typeof value === 'object') {
        const result: Record<string, unknown> = {};
        for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
            if (SENSITIVE_KEYS.has(k.toLowerCase()) && typeof v === 'string') {
                result[k] = '[REDACTED]';
            } else {
                result[k] = redact(v);
            }
        }
        return result as unknown as T;
    }
    return value;
}

export interface Logger {
    debug(message: string, context?: unknown): void;
    info(message: string, context?: unknown): void;
    warn(message: string, context?: unknown): void;
    error(message: string, context?: unknown): void;
    setLevel(level: LogLevel): void;
    getLevel(): LogLevel;
}

let globalLevel: LogLevel = 'debug'; // По умолчанию debug — переопределяется через setGlobalLogLevel

export function setGlobalLogLevel(level: LogLevel): void {
    globalLevel = level;
}

export function createLogger(tag: string): Logger {
    const minPriority = (): number => LEVEL_PRIORITY[globalLevel];

    const emit = (level: LogLevel, message: string, context?: unknown): void => {
        if (LEVEL_PRIORITY[level] < minPriority()) return;
        const prefix = `[${tag}]`;
        const line = context !== undefined ? `${prefix} ${message}` : `${prefix} ${message}`;
        const safeContext = context !== undefined ? redact(context) : undefined;
        const writer = level === 'debug' ? console.debug
            : level === 'info' ? console.info
            : level === 'warn' ? console.warn
            : console.error;
        if (safeContext !== undefined) writer(line, safeContext);
        else writer(line);
    };

    return {
        debug: (msg, ctx) => emit('debug', msg, ctx),
        info: (msg, ctx) => emit('info', msg, ctx),
        warn: (msg, ctx) => emit('warn', msg, ctx),
        error: (msg, ctx) => emit('error', msg, ctx),
        setLevel(level: LogLevel): void { globalLevel = level; },
        getLevel(): LogLevel { return globalLevel; }
    };
}