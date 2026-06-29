/**
 * Инструменты выделения области для capture window.
 *
 * Извлечено из src/ui/capture-window/capture.js в Фазе 2.3.
 * Pure-функции для:
 *   - normalizeRect() — нормализация rect из двух точек
 *   - findHoveredWindow() — поиск окна под курсором
 *   - captureWindowBySourceId() — per-window capture через getUserMedia
 *
 * Загружается через `<script type="module">`.
 */

/**
 * @typedef {Object} Rect
 * @property {number} x
 * @property {number} y
 * @property {number} w
 * @property {number} h
 */

/**
 * @typedef {Object} WindowBounds
 * @property {number} x
 * @property {number} y
 * @property {number} w
 * @property {number} h
 * @property {string} [title] — base64-encoded
 * @property {string} [sourceId] — desktopCapturer sourceId для per-window capture
 */

/**
 * Нормализует прямоугольник из двух произвольных точек (координаты могут
 * идти в любом направлении — drag справа налево или снизу вверх).
 *
 * @param {number} startX
 * @param {number} startY
 * @param {number} endX
 * @param {number} endY
 * @returns {Rect}
 */
export function normalizeRect(startX, startY, endX, endY) {
    return {
        x: Math.min(startX, endX),
        y: Math.min(startY, endY),
        w: Math.abs(endX - startX),
        h: Math.abs(endY - startY)
    };
}

/**
 * Ищет окно под курсором. Если ни одно не подходит — возвращает null.
 *
 * @param {WindowBounds[]} windowBounds
 * @param {number} x
 * @param {number} y
 * @returns {WindowBounds | null}
 */
export function findHoveredWindow(windowBounds, x, y) {
    if (!windowBounds || windowBounds.length === 0) return null;
    return windowBounds.find(win =>
        x >= win.x && x <= (win.x + win.w) &&
        y >= win.y && y <= (win.y + win.h)
    ) || null;
}

/**
 * Per-window capture через desktopCapturer window source.
 * getUserMedia с sourceId='window:XXX' даёт MediaStream с ЧИСТЫМ содержимым
 * конкретного окна — без перекрывающих приложений (в отличие от crop со скриншота).
 *
 * @param {string} sourceId — desktopCapturer sourceId (формат 'window:XXX:0')
 * @returns {Promise<string>} data:image/png;base64,...
 */
export async function captureWindowBySourceId(sourceId) {
    const stream = await navigator.mediaDevices.getUserMedia({
        video: {
            mandatory: {
                chromeMediaSource: 'desktop',
                chromeMediaSourceId: sourceId
            }
        }
    });
    const video = document.createElement('video');
    video.srcObject = stream;
    video.muted = true;
    video.playsInline = true;
    await video.play();

    // Ждём первый кадр с реальными размерами
    await new Promise((resolve) => {
        if (video.videoWidth > 0) return resolve();
        video.addEventListener('loadedmetadata', resolve, { once: true });
    });
    // Дополнительный tick чтобы кадр точно отрисовался
    await new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r)));

    const w = video.videoWidth;
    const h = video.videoHeight;
    const offscreen = document.createElement('canvas');
    offscreen.width = w;
    offscreen.height = h;
    offscreen.getContext('2d').drawImage(video, 0, 0, w, h);

    // Останавливаем треки — окно нам больше не нужно
    stream.getTracks().forEach(t => t.stop());

    return offscreen.toDataURL('image/png');
}

/**
 * Рисует затемнение всего экрана + подсветку выбранного окна/прямоугольника.
 * Используется и для window mode, и для rect mode при drag'е.
 *
 * @param {CanvasRenderingContext2D} ctx
 * @param {HTMLImageElement} originalImage — исходный скриншот экрана
 * @param {Rect} capturedRect — выделенная область
 * @param {number} canvasWidth — ширина canvas
 * @param {number} canvasHeight — высота canvas
 * @param {number} naturalWidth — naturalWidth originalImage
 * @param {number} naturalHeight — naturalHeight originalImage
 * @param {string} [strokeColor='#0078d4'] — цвет рамки выделения
 * @param {number} [lineWidth=2] — толщина рамки
 */
export function drawSelectionHighlight(ctx, originalImage, capturedRect, canvasWidth, canvasHeight, naturalWidth, naturalHeight, strokeColor = '#0078d4', lineWidth = 2) {
    ctx.clearRect(0, 0, canvasWidth, canvasHeight);
    ctx.drawImage(originalImage, 0, 0, canvasWidth, canvasHeight);
    ctx.fillStyle = 'rgba(0, 0, 0, 0.45)';
    ctx.fillRect(0, 0, canvasWidth, canvasHeight);
    const toPhysX = naturalWidth / canvasWidth;
    const toPhysY = naturalHeight / canvasHeight;
    ctx.drawImage(originalImage,
        capturedRect.x * toPhysX, capturedRect.y * toPhysY,
        capturedRect.w * toPhysX, capturedRect.h * toPhysY,
        capturedRect.x, capturedRect.y, capturedRect.w, capturedRect.h);
    ctx.strokeStyle = strokeColor;
    ctx.lineWidth = lineWidth;
    ctx.strokeRect(capturedRect.x, capturedRect.y, capturedRect.w, capturedRect.h);
}

/**
 * Вырезает прямоугольник из исходного изображения в новый canvas
 * (для annotate mode и отправки).
 *
 * @param {HTMLImageElement} originalImage
 * @param {Rect} capturedRect — координаты в canvas-пространстве originalImage
 * @param {number} canvasWidth — ширина canvas (для пропорции)
 * @param {number} canvasHeight — высота canvas
 * @returns {HTMLCanvasElement}
 */
export function cropCanvas(originalImage, capturedRect, canvasWidth, canvasHeight) {
    const toPhysX = originalImage.naturalWidth / canvasWidth;
    const toPhysY = originalImage.naturalHeight / canvasHeight;
    const physX = capturedRect.x * toPhysX;
    const physY = capturedRect.y * toPhysY;
    const physW = capturedRect.w * toPhysX;
    const physH = capturedRect.h * toPhysY;
    const out = document.createElement('canvas');
    out.width = physW;
    out.height = physH;
    out.getContext('2d').drawImage(originalImage,
        physX, physY, physW, physH, 0, 0, physW, physH);
    return out;
}