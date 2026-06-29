/**
 * Захват первого кадра canvas в JPEG (используется для cover art MP4 и
 * миниатюры истории в recorder.js).
 *
 * Pure-функция: возвращает объект с двумя представлениями (bytes и base64),
 * не сохраняет в module-level state. Изначально была частью recorder.js
 * (captureFirstFrame()), но вынесена для возможного переиспользования и
 * тестируемости.
 *
 * @param {HTMLCanvasElement} canvas — canvas, на котором нарисован кадр
 * @param {number} [quality=0.85] — JPEG quality (0..1)
 * @returns {{ jpegBytes: Uint8Array | null, jpegBase64: string | null }}
 */
export function captureFirstFrame(canvas, quality = 0.85) {
    if (!canvas || canvas.width === 0 || canvas.height === 0) {
        return { jpegBytes: null, jpegBase64: null };
    }
    try {
        const dataUrl = canvas.toDataURL('image/jpeg', quality);
        const commaIdx = dataUrl.indexOf(',');
        if (commaIdx < 0) return { jpegBytes: null, jpegBase64: null };

        const jpegBase64 = dataUrl.slice(commaIdx + 1);
        const binStr = atob(jpegBase64);
        const bytes = new Uint8Array(binStr.length);
        for (let i = 0; i < binStr.length; i++) bytes[i] = binStr.charCodeAt(i);
        return { jpegBytes: bytes, jpegBase64 };
    } catch (e) {
        console.warn('[first-frame] capture failed:', e);
        return { jpegBytes: null, jpegBase64: null };
    }
}