/**
 * Модуль аннотаций для capture window.
 *
 * Извлечено из src/ui/capture-window/capture.js в Фазе 2.3.
 * Содержит pure-функции для рисования и построения аннотаций:
 *   - drawAction(ctx, action, scale, rect, capturedCanvas?) — рисует одну аннотацию
 *   - buildAction(tool, p1, p2) — создаёт объект действия по tool и координатам
 *   - COLORS — константы цветов (вынесены, чтобы переиспользовать)
 *
 * Загружается через `<script type="module">`. Не требует сборки.
 *
 * Соглашения:
 *   - Все координаты в Canvas-координатах (не CSS-координатах).
 *   - `rect` = { x, y, w, h } — область скриншота, на которую накладывается аннотация.
 *   - `scale` = capturedRect.w / capturedCanvas.width — масштаб между canvas и captured.
 *   - `capturedCanvas` нужен ТОЛЬКО для blur (рисует пиксели из источника).
 *
 * Типы actions:
 *   - arrow:    { type:'arrow',  x1, y1, x2, y2 }
 *   - line:     { type:'line',   x1, y1, x2, y2 }
 *   - rect:     { type:'rect',   x, y, w, h }
 *   - marker:   { type:'marker', x, y, w, h }
 *   - blur:     { type:'blur',   x, y, w, h }
 *   - text:     { type:'text',   cssX, cssY, text, fontSize }  // CSS-координаты!
 *
 * NOTE: text хранит CSS-координаты, потому что шрифт рендерится в пикселях
 * viewport'а. Преобразование CSS→canvas делает сам renderer с учётом imgScale.
 */

export const COLORS = Object.freeze({
    arrow: '#ff3333',
    rect: '#ff3333',
    line: '#ff3333',
    text: '#ff3333',
    marker: 'rgba(255, 220, 0, 0.5)',
    markerBorder: '#ffcc00'
});

/**
 * @typedef {Object} AnnotationAction
 * @property {('arrow'|'line'|'rect'|'marker'|'blur'|'text')} type
 * @property {number} [x1] - для arrow/line
 * @property {number} [y1]
 * @property {number} [x2]
 * @property {number} [y2]
 * @property {number} [x] - для rect/marker/blur
 * @property {number} [y]
 * @property {number} [w]
 * @property {number} [h]
 * @property {number} [cssX] - для text (CSS-координаты)
 * @property {number} [cssY]
 * @property {string} [text] - для text
 * @property {number} [fontSize] - для text
 */

/**
 * @typedef {Object} Rect
 * @property {number} x
 * @property {number} y
 * @property {number} w
 * @property {number} h
 */

/**
 * Рисует одну аннотацию на canvas.
 *
 * @param {CanvasRenderingContext2D} c — контекст, на котором рисовать
 * @param {AnnotationAction} action — аннотация
 * @param {number} scale — масштаб captured→canvas
 * @param {Rect} rect — область скриншота (origin)
 * @param {HTMLCanvasElement} [capturedCanvas] — нужен только для blur
 * @param {{x:number,y:number}} [imgScalePair] — пара imgScale (для text), {x:imgScale, y:imgScaleY}
 */
export function drawAction(c, action, scale, rect, capturedCanvas, imgScalePair) {
    const ox = rect.x, oy = rect.y;
    c.save();

    switch (action.type) {
        case 'arrow': {
            c.strokeStyle = COLORS.arrow;
            c.lineWidth = Math.max(2, 3 * scale);
            c.beginPath();
            c.moveTo(ox + action.x1 * scale, oy + action.y1 * scale);
            c.lineTo(ox + action.x2 * scale, oy + action.y2 * scale);
            c.stroke();
            const angle = Math.atan2(action.y2 - action.y1, action.x2 - action.x1);
            const headLen = Math.max(8, 14 * scale);
            c.fillStyle = COLORS.arrow;
            c.beginPath();
            c.moveTo(ox + action.x2 * scale, oy + action.y2 * scale);
            c.lineTo(ox + (action.x2 - headLen * Math.cos(angle - 0.4)) * scale, oy + (action.y2 - headLen * Math.sin(angle - 0.4)) * scale);
            c.lineTo(ox + (action.x2 - headLen * Math.cos(angle + 0.4)) * scale, oy + (action.y2 - headLen * Math.sin(angle + 0.4)) * scale);
            c.closePath();
            c.fill();
            break;
        }
        case 'rect': {
            c.strokeStyle = COLORS.rect;
            c.lineWidth = Math.max(2, 3 * scale);
            c.strokeRect(ox + action.x * scale, oy + action.y * scale, action.w * scale, action.h * scale);
            break;
        }
        case 'line': {
            c.strokeStyle = COLORS.line;
            c.lineWidth = Math.max(2, 3 * scale);
            c.beginPath();
            c.moveTo(ox + action.x1 * scale, oy + action.y1 * scale);
            c.lineTo(ox + action.x2 * scale, oy + action.y2 * scale);
            c.stroke();
            break;
        }
        case 'text': {
            if (!imgScalePair) {
                // Если imgScalePair не передан — рисуем в абсолютных canvas-координатах.
                c.fillStyle = COLORS.text;
                c.font = `bold ${action.fontSize}px Arial`;
                c.textBaseline = 'top';
                c.fillText(action.text, ox + action.cssX, oy + action.cssY);
            } else {
                // Стандартный путь: CSS→canvas преобразование через imgScale (X) и imgScaleY (Y).
                const drawX = action.cssX / imgScalePair.x;
                const drawY = action.cssY / imgScalePair.y;
                c.fillStyle = COLORS.text;
                c.font = `bold ${action.fontSize}px Arial`;
                c.textBaseline = 'top';
                // Соотношение captured canvas к rect (используется для перевода
                // canvas-координат в captured canvas-координаты при отправке).
                const capturedScaleX = (capturedCanvas && rect.w > 0) ? capturedCanvas.width / rect.w : 1;
                const capturedScaleY = (capturedCanvas && rect.h > 0) ? capturedCanvas.height / rect.h : 1;
                if (scale !== 1 || ox !== 0 || oy !== 0) {
                    c.fillText(action.text,
                        ox + (drawX - rect.x) * capturedScaleX,
                        oy + (drawY - rect.y) * capturedScaleY);
                } else {
                    c.fillText(action.text, drawX, drawY);
                }
            }
            c.textBaseline = 'alphabetic';
            break;
        }
        case 'marker': {
            c.fillStyle = COLORS.marker;
            c.fillRect(ox + action.x * scale, oy + action.y * scale, action.w * scale, action.h * scale);
            c.strokeStyle = COLORS.markerBorder;
            c.lineWidth = Math.max(1, 2 * scale);
            c.strokeRect(ox + action.x * scale, oy + action.y * scale, action.w * scale, action.h * scale);
            break;
        }
        case 'blur': {
            if (!capturedCanvas) {
                console.warn('[annotations] blur action requires capturedCanvas');
                break;
            }
            const blockSize = Math.max(4, Math.round(8 * scale));
            const bx = ox + action.x * scale, by = oy + action.y * scale;
            const bw = action.w * scale, bh = action.h * scale;
            const tmpCanvas = document.createElement('canvas');
            tmpCanvas.width = Math.max(1, Math.round(bw / blockSize));
            tmpCanvas.height = Math.max(1, Math.round(bh / blockSize));
            const tmpCtx = tmpCanvas.getContext('2d');
            tmpCtx.drawImage(capturedCanvas, action.x, action.y, action.w, action.h, 0, 0, tmpCanvas.width, tmpCanvas.height);
            c.imageSmoothingEnabled = false;
            c.drawImage(tmpCanvas, bx, by, bw, bh);
            c.imageSmoothingEnabled = true;
            break;
        }
    }

    c.restore();
}

/**
 * Создаёт объект действия по выбранному инструменту и двум точкам.
 * Возвращает null, если действие слишком маленькое (< 5px) и должно игнорироваться.
 *
 * @param {string} tool — 'arrow' | 'line' | 'rect' | 'marker' | 'blur'
 * @param {{x:number,y:number}} p1 — первая точка
 * @param {{x:number,y:number}} p2 — вторая точка
 * @returns {AnnotationAction | null}
 */
export function buildAction(tool, p1, p2) {
    const minX = Math.min(p1.x, p2.x), minY = Math.min(p1.y, p2.y);
    const w = Math.abs(p2.x - p1.x), h = Math.abs(p2.y - p1.y);

    if (tool === 'arrow' || tool === 'line') {
        if (Math.abs(p2.x - p1.x) < 5 && Math.abs(p2.y - p1.y) < 5) return null;
        return { type: tool, x1: p1.x, y1: p1.y, x2: p2.x, y2: p2.y };
    }
    if (tool === 'rect' || tool === 'marker' || tool === 'blur') {
        if (w < 5 || h < 5) return null;
        return { type: tool, x: minX, y: minY, w, h };
    }
    return null;
}

/**
 * История действий с поддержкой undo/redo. Лёгкая абстракция, чтобы
 * не дублировать логику actions/redoStack в capture.js.
 *
 * @example
 *   const history = new ActionHistory();
 *   history.push({ type: 'arrow', ... });
 *   history.undo(); // → вернёт последнее
 */
export class ActionHistory {
    constructor() {
        /** @type {AnnotationAction[]} */
        this.actions = [];
        /** @type {AnnotationAction[]} */
        this.redoStack = [];
    }

    push(action) {
        this.actions.push(action);
        this.redoStack = [];
    }

    undo() {
        if (this.actions.length === 0) return null;
        const action = this.actions.pop();
        this.redoStack.push(action);
        return action;
    }

    redo() {
        if (this.redoStack.length === 0) return null;
        const action = this.redoStack.pop();
        this.actions.push(action);
        return action;
    }

    clear() {
        this.actions = [];
        this.redoStack = [];
    }

    get length() {
        return this.actions.length;
    }

    get canUndo() {
        return this.actions.length > 0;
    }

    get canRedo() {
        return this.redoStack.length > 0;
    }
}