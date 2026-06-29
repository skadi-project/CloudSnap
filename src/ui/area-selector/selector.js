// Area selector renderer — draws red rectangle as user drags, then confirms via IPC.

const canvas = document.getElementById('screenCanvas');
const ctx = canvas.getContext('2d');
const info = document.getElementById('info');

let originalImage = new Image();
let scaleFactor = 1;
let imgScale = 1;
let isDrawing = false;
let startX = 0, startY = 0, endX = 0, endY = 0;

function redrawBase() {
    const vw = window.innerWidth;
    const vh = window.innerHeight;
    canvas.width = originalImage.naturalWidth || vw;
    canvas.height = originalImage.naturalHeight || vh;
    canvas.style.width = vw + 'px';
    canvas.style.height = vh + 'px';
    imgScale = vw / canvas.width;
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    ctx.drawImage(originalImage, 0, 0, canvas.width, canvas.height);
}

window.electronAPI.onScreenshotCaptured((data) => {
    scaleFactor = data.scaleFactor;
    originalImage.onload = () => { redrawBase(); };
    originalImage.src = data.imageSrc;
});

function getMousePos(e) {
    return { x: e.clientX / imgScale, y: e.clientY / imgScale };
}

canvas.addEventListener('mousedown', (e) => {
    isDrawing = true;
    const pos = getMousePos(e);
    startX = pos.x;
    startY = pos.y;
    endX = pos.x;
    endY = pos.y;
});

canvas.addEventListener('mousemove', (e) => {
    if (!isDrawing) return;
    const pos = getMousePos(e);
    endX = pos.x;
    endY = pos.y;

    redrawBase();
    ctx.fillStyle = 'rgba(0, 0, 0, 0.6)';
    ctx.fillRect(0, 0, canvas.width, canvas.height);

    const rectX = Math.min(startX, endX);
    const rectY = Math.min(startY, endY);
    const rectW = Math.abs(endX - startX);
    const rectH = Math.abs(endY - startY);

    if (rectW > 0 && rectH > 0) {
        ctx.drawImage(originalImage,
            rectX, rectY, rectW, rectH,
            rectX, rectY, rectW, rectH
        );
        ctx.strokeStyle = '#ff3333';
        ctx.lineWidth = 3;
        ctx.strokeRect(rectX, rectY, rectW, rectH);
        info.textContent = `${Math.round(rectW)}×${Math.round(rectH)} — отпустите для начала записи`;
    }
});

canvas.addEventListener('mouseup', (e) => {
    if (!isDrawing) return;
    isDrawing = false;

    const rectX = Math.min(startX, endX);
    const rectY = Math.min(startY, endY);
    const rectW = Math.abs(endX - startX);
    const rectH = Math.abs(endY - startY);

    if (rectW < 10 || rectH < 10) {
        redrawBase();
        info.textContent = 'Зажмите ЛКМ — выделите область для записи. ESC — отмена.';
        return;
    }

    window.electronAPI.confirmAreaSelection({
        x: rectX / scaleFactor,
        y: rectY / scaleFactor,
        w: rectW / scaleFactor,
        h: rectH / scaleFactor,
        scaleFactor: scaleFactor
    });
});

document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') {
        window.electronAPI.cancelAreaSelection();
    }
});