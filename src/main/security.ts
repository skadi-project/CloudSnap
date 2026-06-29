/**
 * Безопасность: валидация URL, magic bytes для upload, безопасное получение пароля.
 *
 * Все эти хелперы были собраны в main.ts в Фазе 1 для удобства проверки
 * безопасности. Теперь они изолированы в отдельный модуль, чтобы:
 *  - переиспользовать из любого IPC-обработчика
 *  - тестировать изолированно (см. Фаза 3.1 — priority 1: security.ts)
 */

import { safeStorage } from 'electron';
import Store from 'electron-store';

/** Результат валидации URL сервера Nextcloud. */
export type UrlValidation =
    | { ok: true; url: string; protocol: 'http:' | 'https:' }
    | { ok: false; error: string };

/**
 * Разрешаем только http(s) — любые другие схемы (file:, javascript:, и т.п.)
 * могут быть использованы для атаки через shell.openExternal или fetch.
 *
 * Применяется в: save-credentials, test-connection, open-in-nextcloud.
 */
export function validateServerUrl(rawUrl: string): UrlValidation {
    const url = (rawUrl || '').trim();
    if (!url) return { ok: false, error: 'URL не указан' };
    let parsed: URL;
    try {
        parsed = new URL(url);
    } catch {
        return { ok: false, error: 'Некорректный URL' };
    }
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
        return { ok: false, error: 'Допустимы только http:// и https://' };
    }
    if (!parsed.hostname) {
        return { ok: false, error: 'В URL отсутствует hostname' };
    }
    return { ok: true, url, protocol: parsed.protocol as 'http:' | 'https:' };
}

/**
 * Проверка magic bytes PNG/JPEG. Минимально достаточно, чтобы отклонить
 * бинарный blob, который не является изображением — основная защита от
 * использования upload-file как generic upload-прокси.
 */
export function isPngOrJpeg(buf: Buffer): boolean {
    if (buf.length < 8) return false;
    // PNG: 89 50 4E 47 0D 0A 1A 0A
    if (buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4E && buf[3] === 0x47) return true;
    // JPEG: FF D8 FF
    if (buf[0] === 0xFF && buf[1] === 0xD8 && buf[2] === 0xFF) return true;
    return false;
}

/**
 * Безопасное получение пароля из electron-store. Возвращает null, если
 * шифрование недоступно (на Linux без keyring) или пароль не сохранён /
 * повреждён. Бросает только в случае непредвиденных ошибок, не связанных
 * с самим шифрованием.
 *
 * Принимает `store` параметром, чтобы не зависеть от глобального состояния
 * и быть тестируемым.
 */
export function getDecryptedPassword(store: Store): string | null {
    const encrypted = store.get('password', '') as string;
    if (!encrypted) return null;
    if (!safeStorage.isEncryptionAvailable()) {
        console.error('[security] safeStorage.isEncryptionAvailable()=false — OS keyring недоступен');
        return null;
    }
    try {
        return safeStorage.decryptString(Buffer.from(encrypted, 'base64'));
    } catch (e) {
        console.error('[security] не удалось расшифровать сохранённый пароль:', e);
        return null;
    }
}