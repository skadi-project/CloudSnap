// Capture window: точка входа.
// Вся нетривиальная логика вынесена в src/annotations/ и src/tools/.
// Здесь только DOM-связка: обработчики событий, состояние UI, IPC.

import { drawAction, buildAction, ActionHistory } from '../../annotations/annotations.js';
import {
    normalizeRect,
    findHoveredWindow,
    captureWindowBySourceId,
    drawSelectionHighlight,
    cropCanvas
} from '../../tools/selection.js';

const canvas = document.getElementById('screenCanvas');
const ctx = canvas.getContext('2d');
const toolbar = document.getElementById('toolbar');
const hint = document.getElementById('hint');
const monitorBar = document.getElementById('monitorBar');
const annotateToolbar = document.getElementById('annotateToolbar');
const textInput = document.getElementById('textInput');

const toolButtons = document.querySelectorAll('.toolBtn');
const annotateButtons = document.querySelectorAll('.annotateBtn');

const cancelBtn = document.getElementById('cancelBtn');
const undoBtn = document.getElementById('undoBtn');
const redoBtn = document.getElementById('redoBtn');
const sendBtn = document.getElementById('sendBtn');
const skipBtn = document.getElementById('skipBtn');

const originalImage = new Image();
let currentMode = 'fullscreen';
let windowBounds = [];
let hoveredWindow = null;
let imgScale = 1;  // X: viewport / canvas
let imgScaleY = 1; // Y: viewport / canvas (отдельно, т.к. taskbar уменьшает viewport.height)

// Захват области
let isDrawing = false;
let startX = 0, startY = 0, endX = 0, endY = 0;

// Разметка
let annotateMode = false;
let currentTool = null;
const history = new ActionHistory();
let capturedRect = null;
let capturedCanvas = null;
let isTextInputVisible = false;
let textInputCanvasPos = null;
let currentDisplayId = null;
let currentDisplayIndex = 0;
let availableDisplays = [];

// Рисование инструмента
let toolStartX = 0, toolStartY = 0, toolEndX = 0, toolEndY = 0;
let isToolDrawing = false;

// === РЕЖИМЫ ЗАХВАТА ===

toolButtons.forEach(btn => {
    btn.addEventListener('click', async (e) => {
        e.stopPropagation();
        setMode(btn.dataset.mode);
    });
});

async function setMode(mode) {
    currentMode = mode;
    await window.electronAPI.setScreenshotMode(mode);
    toolButtons.forEach(b => b.classList.remove('active'));
    document.querySelector(`.toolBtn[data-mode="${mode}"]`).classList.add('active');
    isDrawing = false;
    hoveredWindow = null;
    if (originalImage.src) redrawBase();
    updateHint();
}

function updateHint() {
    if (annotateMode) {
        hint.textContent = 'Разметка: выберите инструмент и рисуйте. Enter — отправить.';
        return;
    }
    if (currentMode === 'fullscreen') hint.textContent = 'Кликните в любом месте для снимка всего экрана';
    else if (currentMode === 'rect') hint.textContent = 'Зажмите ЛКМ и выделите область';
    else if (currentMode === 'window') hint.textContent = 'Наведите на окно и кликните для снимка';
}

cancelBtn.addEventListener('click', (e) => {
    e.stopPropagation();
    if (annotateMode) exitAnnotate();
    else window.close();
});

document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') {
        if (annotateMode) exitAnnotate();
        else window.close();
    }
    if (!annotateMode) {
        if (e.key === '1') setMode('fullscreen');
        if (e.key === '2') setMode('rect');
        if (e.key === '3') setMode('window');
    }
    if (annotateMode) {
        if (e.ctrlKey && e.key === 'z') { e.preventDefault(); undo(); }
        if (e.ctrlKey && e.key === 'y') { e.preventDefault(); redo(); }
        if (e.key === 'Enter' && !isTextInputVisible) sendAnnotated();
    }
});

function getMousePos(e) {
    return { x: e.clientX / imgScale, y: e.clientY / imgScaleY };
}

function redrawBase() {
    const vw = window.innerWidth;
    const vh = window.innerHeight;
    canvas.width = originalImage.naturalWidth || vw;
    canvas.height = originalImage.naturalHeight || vh;
    canvas.style.width = vw + 'px';
    canvas.style.height = vh + 'px';
    imgScale = vw / canvas.width;
    imgScaleY = vh / canvas.height;
    console.log('[capture] redrawBase: viewport=' + vw + 'x' + vh,
        'canvas=' + canvas.width + 'x' + canvas.height,
        'imgScale=' + imgScale, 'imgScaleY=' + imgScaleY,
        'naturalSize=' + originalImage.naturalWidth + 'x' + originalImage.naturalHeight);
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    ctx.drawImage(originalImage, 0, 0, canvas.width, canvas.height);
}

function applyCapturePayload(data) {
    currentMode = data.mode;
    currentDisplayId = data.currentDisplayId;
    availableDisplays = data.displays || [];
    const activeDisplay = availableDisplays.find(d => d.id === currentDisplayId);
    currentDisplayIndex = activeDisplay ? activeDisplay.index : 0;

    toolButtons.forEach(b => b.classList.remove('active'));
    const activeBtn = document.querySelector(`.toolBtn[data-mode="${currentMode}"]`);
    if (activeBtn) activeBtn.classList.add('active');

    renderMonitorBar();

    originalImage.onload = () => {
        redrawBase();
        windowBounds = data.windowBounds || [];
        console.log('[capture] Window bounds loaded:', windowBounds.length, 'windows');
        if (windowBounds.length > 0) {
            console.log('[capture] Sample bounds:', windowBounds.slice(0, 3));
        }
        updateHint();
    };
    originalImage.src = data.imageSrc;
}

function renderMonitorBar() {
    monitorBar.innerHTML = '';
    if (!availableDisplays || availableDisplays.length <= 1) {
        monitorBar.classList.remove('visible');
        return;
    }
    monitorBar.classList.add('visible');
    for (const d of availableDisplays) {
        const btn = document.createElement('button');
        btn.className = 'monitorBtn' + (d.id === currentDisplayId ? ' active' : '');
        btn.textContent = d.label || `Монитор ${d.index + 1}`;
        btn.title = d.label || '';
        btn.addEventListener('click', async (e) => {
            e.stopPropagation();
            if (d.id === currentDisplayId || annotateMode) return;
            hint.textContent = 'Переключение монитора...';
            await window.electronAPI.switchCaptureDisplay(d.id);
        });
        monitorBar.appendChild(btn);
    }
}

window.electronAPI.onScreenshotCaptured((data) => applyCapturePayload(data));

if (window.electronAPI.onCaptureDisplaySwitched) {
    window.electronAPI.onCaptureDisplaySwitched((data) => {
        annotateMode = false;
        annotateToolbar.classList.remove('visible');
        toolbar.style.opacity = '1';
        toolbar.style.pointerEvents = 'auto';
        isDrawing = false;
        hoveredWindow = null;
        applyCapturePayload(data);
    });
}

// === MOUSEMOVE — режимы fullscreen/rect/window ===

canvas.addEventListener('mousemove', (e) => {
    if (annotateMode) return handleToolMove(e);
    const pos = getMousePos(e);

    if (currentMode === 'window') {
        const match = findHoveredWindow(windowBounds, pos.x, pos.y);
        if (match !== hoveredWindow) {
            hoveredWindow = match;
            if (hoveredWindow) {
                drawSelectionHighlight(ctx, originalImage, hoveredWindow,
                    canvas.width, canvas.height,
                    originalImage.naturalWidth, originalImage.naturalHeight,
                    '#0078d4', 3);
            } else {
                redrawBase();
            }
        }
        return;
    }

    if (!isDrawing || currentMode !== 'rect') return;
    endX = pos.x; endY = pos.y;
    const rect = normalizeRect(startX, startY, endX, endY);
    if (rect.w > 0 && rect.h > 0) {
        drawSelectionHighlight(ctx, originalImage, rect,
            canvas.width, canvas.height,
            originalImage.naturalWidth, originalImage.naturalHeight,
            '#0078d4', 2);
    } else {
        redrawBase();
        ctx.fillStyle = 'rgba(0, 0, 0, 0.45)';
        ctx.fillRect(0, 0, canvas.width, canvas.height);
    }
});

// === MOUSEDOWN ===

canvas.addEventListener('mousedown', (e) => {
    if (annotateMode) return handleToolDown(e);
    if (currentMode === 'rect') {
        isDrawing = true;
        const pos = getMousePos(e);
        startX = pos.x; startY = pos.y;
        endX = pos.x; endY = pos.y;
    }
});

// === MOUSEUP ===

canvas.addEventListener('mouseup', async (e) => {
    if (annotateMode) return handleToolUp(e);

    if (currentMode === 'fullscreen') {
        capturedRect = { x: 0, y: 0, w: canvas.width, h: canvas.height };
        capturedCanvas = document.createElement('canvas');
        capturedCanvas.width = originalImage.naturalWidth;
        capturedCanvas.height = originalImage.naturalHeight;
        capturedCanvas.getContext('2d').drawImage(originalImage, 0, 0);
        enterAnnotate();
    } else if (currentMode === 'window') {
        if (!hoveredWindow) return;
        capturedRect = { x: hoveredWindow.x, y: hoveredWindow.y, w: hoveredWindow.w, h: hoveredWindow.h };
        hint.textContent = 'Захват окна...';

        // Если у окна есть sourceId из desktopCapturer — делаем per-window capture
        // через getUserMedia. Это возвращает ЧИСТОЕ содержимое окна без
        // перекрывающих приложений (в отличие от crop со скриншота экрана).
        if (hoveredWindow.sourceId) {
            try {
                const cleanDataURL = await captureWindowBySourceId(hoveredWindow.sourceId);
                const img = new Image();
                await new Promise((resolve, reject) => {
                    img.onload = resolve;
                    img.onerror = reject;
                    img.src = cleanDataURL;
                });

                // Захваченное изображение = полное окно (desktopCapturer отдаёт
                // целиком, включая части за пределами дисплея-захвата и chrome).
                // Нам нужна только подсвеченная область. Считаем её смещение
                // внутри полного окна через full{X,Y,W,H} (заполняются в
                // display-utils.filterWindowBoundsForDisplay).
                //
                // srcX = clippedX - fullX  — координаты видимой области
                //                              в системе координат
                //                              захваченного изображения.
                let srcX = 0, srcY = 0, srcW = img.naturalWidth, srcH = img.naturalHeight;
                if (
                    typeof hoveredWindow.fullX === 'number' &&
                    typeof hoveredWindow.fullY === 'number' &&
                    typeof hoveredWindow.fullW === 'number' &&
                    typeof hoveredWindow.fullH === 'number'
                ) {
                    // Если размеры захваченного изображения совпадают с
                    // измеренными размерами окна — обрезаем строго по видимой
                    // области. Если не совпадают (например, изображение
                    // включает тень, а PowerShell вернул outer bounds без неё) —
                    // пересчитываем пропорционально.
                    const dw = img.naturalWidth / hoveredWindow.fullW;
                    const dh = img.naturalHeight / hoveredWindow.fullH;

                    if (Math.abs(dw - 1) < 0.02 && Math.abs(dh - 1) < 0.02) {
                        // Случай 1: размеры совпадают (или различие ≤2%).
                        // Простой crop по пиксельным координатам.
                        srcX = hoveredWindow.x - hoveredWindow.fullX;
                        srcY = hoveredWindow.y - hoveredWindow.fullY;
                        srcW = hoveredWindow.w;
                        srcH = hoveredWindow.h;
                    } else {
                        // Случай 2: масштаб отличается (тень/DPI/масштабирование).
                        // Пропорциональный crop сохраняет область нетронутой,
                        // даже если захват выходит за outer bounds.
                        const sx = (hoveredWindow.x - hoveredWindow.fullX) * dw;
                        const sy = (hoveredWindow.y - hoveredWindow.fullY) * dh;
                        srcX = Math.max(0, Math.round(sx));
                        srcY = Math.max(0, Math.round(sy));
                        srcW = Math.max(1, Math.min(
                            Math.round(hoveredWindow.w * dw),
                            img.naturalWidth - srcX
                        ));
                        srcH = Math.max(1, Math.min(
                            Math.round(hoveredWindow.h * dh),
                            img.naturalHeight - srcY
                        ));
                    }

                    console.log('[capture] window crop:',
                        'image=', img.naturalWidth + 'x' + img.naturalHeight,
                        'full=', hoveredWindow.fullW + 'x' + hoveredWindow.fullH,
                        'fullXY=', hoveredWindow.fullX + ',' + hoveredWindow.fullY,
                        'clipped=', hoveredWindow.w + 'x' + hoveredWindow.h,
                        'srcRect=', srcX + ',' + srcY + ' ' + srcW + 'x' + srcH);
                }

                capturedCanvas = document.createElement('canvas');
                capturedCanvas.width = srcW;
                capturedCanvas.height = srcH;
                // Source-rect crop — вырезаем только видимую (подсвеченную)
                // часть из полного окна; dest-rect — в capturedCanvas 1:1.
                capturedCanvas.getContext('2d').drawImage(img,
                    srcX, srcY, srcW, srcH,
                    0, 0, srcW, srcH);
                enterAnnotate();
                return;
            } catch (err) {
                console.warn('[capture] per-window capture failed, falling back to screen crop:', err);
                // fallthrough to screen crop
            }
        }

        // Fallback: crop со скриншота экрана (если sourceId нет или getUserMedia упал)
        capturedCanvas = cropCanvas(originalImage, capturedRect, canvas.width, canvas.height);
        enterAnnotate();
    } else if (currentMode === 'rect') {
        if (!isDrawing) return;
        isDrawing = false;
        const rect = normalizeRect(startX, startY, endX, endY);
        if (rect.w < 10 || rect.h < 10) return;
        capturedRect = rect;
        capturedCanvas = cropCanvas(originalImage, rect, canvas.width, canvas.height);
        enterAnnotate();
    }
});

// === РАЗМЕТКА ===

function enterAnnotate() {
    annotateMode = true;
    history.clear();
    toolbar.style.opacity = '0';
    toolbar.style.pointerEvents = 'none';
    annotateToolbar.classList.add('visible');
    redrawAnnotated();
    updateHint();
    setTool('arrow');
}

function exitAnnotate() {
    annotateMode = false;
    annotateToolbar.classList.remove('visible');
    textInput.style.display = 'none';
    toolbar.style.opacity = '1';
    toolbar.style.pointerEvents = 'auto';
    capturedRect = null;
    capturedCanvas = null;
    currentTool = null;
    history.clear();
    redrawBase();
    updateHint();
}

function setTool(tool) {
    currentTool = tool;
    annotateButtons.forEach(b => b.classList.remove('active'));
    const active = document.querySelector(`.annotateBtn[data-tool="${tool}"]`);
    if (active) active.classList.add('active');
    canvas.style.cursor = tool === 'text' ? 'text' : tool === 'blur' ? 'cell' : 'crosshair';
}

annotateButtons.forEach(btn => {
    btn.addEventListener('click', (e) => {
        e.stopPropagation();
        setTool(btn.dataset.tool);
    });
});

function canvasToCaptured(cx, cy) {
    if (!capturedRect) return { x: cx, y: cy };
    return {
        x: (cx - capturedRect.x) * (capturedCanvas.width / capturedRect.w),
        y: (cy - capturedRect.y) * (capturedCanvas.height / capturedRect.h)
    };
}

function redrawAnnotated() {
    if (!capturedCanvas || !capturedRect) return;
    redrawBase();
    ctx.fillStyle = 'rgba(0,0,0,0.35)';
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    const toPhysX = originalImage.naturalWidth / canvas.width;
    const toPhysY = originalImage.naturalHeight / canvas.height;
    ctx.drawImage(originalImage,
        capturedRect.x * toPhysX, capturedRect.y * toPhysY,
        capturedRect.w * toPhysX, capturedRect.h * toPhysY,
        capturedRect.x, capturedRect.y, capturedRect.w, capturedRect.h);
    ctx.strokeStyle = '#0078d4'; ctx.lineWidth = 2;
    ctx.strokeRect(capturedRect.x, capturedRect.y, capturedRect.w, capturedRect.h);

    const scale = capturedRect.w / capturedCanvas.width;
    const imgScalePair = { x: imgScale, y: imgScaleY };
    for (const action of history.actions) {
        drawAction(ctx, action, scale, capturedRect, capturedCanvas, imgScalePair);
    }
}

// === Инструмент MOUSEDOWN / MOVE / UP ===

function handleToolDown(e) {
    if (!annotateMode || !currentTool) return;
    const pos = getMousePos(e);

    if (capturedRect &&
        (pos.x < capturedRect.x || pos.x > capturedRect.x + capturedRect.w ||
         pos.y < capturedRect.y || pos.y > capturedRect.y + capturedRect.h)) {
        return;
    }

    if (currentTool === 'text') {
        showTextInput(pos.x, pos.y);
        return;
    }

    isToolDrawing = true;
    toolStartX = pos.x; toolStartY = pos.y;
    toolEndX = pos.x; toolEndY = pos.y;
}

function handleToolMove(e) {
    if (!isToolDrawing) return;
    const pos = getMousePos(e);
    toolEndX = pos.x; toolEndY = pos.y;
    redrawAnnotated();
    const cPos1 = canvasToCaptured(toolStartX, toolStartY);
    const cPos2 = canvasToCaptured(toolEndX, toolEndY);
    const scale = capturedRect.w / capturedCanvas.width;
    const previewAction = buildAction(currentTool, cPos1, cPos2);
    if (previewAction) {
        const imgScalePair = { x: imgScale, y: imgScaleY };
        drawAction(ctx, previewAction, scale, capturedRect, capturedCanvas, imgScalePair);
    }
}

function handleToolUp(e) {
    if (!isToolDrawing) return;
    isToolDrawing = false;
    const cPos1 = canvasToCaptured(toolStartX, toolStartY);
    const cPos2 = canvasToCaptured(toolEndX, toolEndY);
    const action = buildAction(currentTool, cPos1, cPos2);
    if (action) {
        history.push(action);
    }
    redrawAnnotated();
}

// === Текстовый инструмент ===

function showTextInput(cx, cy) {
    isTextInputVisible = true;
    textInputCanvasPos = { cssX: cx * imgScale, cssY: cy * imgScaleY };

    textInput.style.display = 'block';
    textInput.style.left = (cx * imgScale) + 'px';
    const TEXT_FONT_SIZE = 20;
    textInput.style.top = ((cy * imgScaleY) - TEXT_FONT_SIZE / 2) + 'px';
    textInput.value = '';
    textInput.focus();
}

textInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
        e.preventDefault();
        const text = textInput.value.trim();
        if (text && textInputCanvasPos) {
            history.push({
                type: 'text',
                cssX: textInputCanvasPos.cssX,
                cssY: textInputCanvasPos.cssY,
                text,
                fontSize: 20
            });
            redrawAnnotated();
        }
        isTextInputVisible = false;
        textInput.style.display = 'none';
        textInputCanvasPos = null;
    }
    if (e.key === 'Escape') {
        isTextInputVisible = false;
        textInput.style.display = 'none';
        textInputCanvasPos = null;
    }
    e.stopPropagation();
});

// === Undo / Redo ===

function undo() {
    history.undo();
    redrawAnnotated();
}

function redo() {
    history.redo();
    redrawAnnotated();
}

undoBtn.addEventListener('click', (e) => { e.stopPropagation(); undo(); });
redoBtn.addEventListener('click', (e) => { e.stopPropagation(); redo(); });

// === Отправка ===

sendBtn.addEventListener('click', (e) => {
    e.stopPropagation();
    sendAnnotated();
});

skipBtn.addEventListener('click', (e) => {
    e.stopPropagation();
    sendOriginal();
});

async function sendAnnotated() {
    if (!capturedCanvas) return;
    hint.textContent = 'Отправка размеченного снимка...';

    const annCtx = capturedCanvas.getContext('2d');
    const imgScalePair = { x: imgScale, y: imgScaleY };
    for (const action of history.actions) {
        drawAction(annCtx, action, 1, { x: 0, y: 0, w: capturedCanvas.width, h: capturedCanvas.height }, capturedCanvas, imgScalePair);
    }

    const dataUrl = capturedCanvas.toDataURL('image/png');
    const base64Data = dataUrl.replace(/^data:image\/png;base64,/, '');
    await window.electronAPI.uploadFile({ fileData: base64Data, type: 'image', monitorIndex: currentDisplayIndex });
    window.close();
}

async function sendOriginal() {
    if (!capturedCanvas) return;
    hint.textContent = 'Отправка оригинала...';

    const dataUrl = capturedCanvas.toDataURL('image/png');
    const base64Data = dataUrl.replace(/^data:image\/png;base64,/, '');
    await window.electronAPI.uploadFile({ fileData: base64Data, type: 'image', monitorIndex: currentDisplayIndex });
    window.close();
}