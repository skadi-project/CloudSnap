import { screen, desktopCapturer, NativeImage, Display } from 'electron';

// === Интерфейсы данных ===

export interface DisplayBounds {
    x: number;
    y: number;
    width: number;
    height: number;
}

export interface WindowBounds {
    x: number;
    y: number;
    w: number;
    h: number;
}

export interface DisplaySourceInfo {
    id: number;
    index: number;
    label: string;
    bounds: DisplayBounds;
    scaleFactor: number;
    isPrimary: boolean;
    sourceId: string;
    thumbnail: NativeImage | null;
}

// === Реализация функций ===

/**
 * Получает список всех активных дисплеев системы, используя 5 каскадных стратегий 
 * сопоставления системных экранов с потоками захвата от desktopCapturer.
 */
export async function getDisplaySources(): Promise<DisplaySourceInfo[]> {
    const displays = screen.getAllDisplays();
    if (!displays.length) return [];

    const maxWidth = Math.max(...displays.map(d => Math.ceil(d.bounds.width * (d.scaleFactor || 1))));
    const maxHeight = Math.max(...displays.map(d => Math.ceil(d.bounds.height * (d.scaleFactor || 1))));

    const sources = await desktopCapturer.getSources({
        types: ['screen'],
        thumbnailSize: { width: maxWidth, height: maxHeight },
        fetchWindowIcons: false
    });

    console.log('[display-utils] sources count:', sources.length, 'displays count:', displays.length);
    for (const s of sources) {
        console.log('[display-utils] source:', s.id, 'display_id:', (s as any).display_id, 'name:', s.name);
    }
    for (const d of displays) {
        console.log('[display-utils] display id:', d.id, 'bounds:', JSON.stringify(d.bounds));
    }

    const primaryId = screen.getPrimaryDisplay().id;

    return displays.map((display, index) => {
        const idStr = String(display.id);

        // Стратегия 1: точное совпадение display_id
        let source = sources.find(s => String((s as any).display_id) === idStr);

        // Стратегия 2: на macOS source.id может содержать display.id
        if (!source) {
            source = sources.find(s => s.id && s.id.includes(idStr));
        }

        // Стратегия 3: matching по имени ("Screen 1", "Entire Screen")
        if (!source) {
            source = sources.find(s => s.name && s.name.includes(String(index + 1)));
        }

        // Стратегия 4: fallback по индексу
        if (!source && sources[index]) source = sources[index];

        // Стратегия 5: для primary display — поиск по имени "Entire Screen" или "Primary"
        if (!source && display.id === primaryId) {
            source = sources.find(s => s.name === 'Entire Screen') || sources[0];
        }

        console.log('[display-utils] display', index, 'id:', display.id, 'matched source:', source ? source.id : 'NONE');

        return {
            id: display.id,
            index,
            label: source ? source.name : `Монитор ${index + 1}`,
            bounds: { ...display.bounds },
            scaleFactor: display.scaleFactor || 1,
            isPrimary: display.id === primaryId,
            sourceId: source ? source.id : null,
            thumbnail: source ? source.thumbnail : null
        };
    }).filter((d): d is DisplaySourceInfo & { sourceId: string } => d.sourceId !== null);
}

/**
 * Возвращает системный дисплей, на котором в данный момент находится курсор мыши.
 */
export function getDisplayByCursor(): Display {
    const point = screen.getCursorScreenPoint();
    return screen.getDisplayNearestPoint(point);
}

/**
 * Ищет сохранённый дисплей в массиве по его ID с защитой от неопределённых типов.
 */
export function findDisplayById(displays: DisplaySourceInfo[], displayId: number | string | null): DisplaySourceInfo | null {
    if (displayId == null) return null;
    return displays.find(d => String(d.id) === String(displayId)) || null;
}

/**
 * Переводит физические/логические координаты окон под конкретный монитор с учётом Scale Factor,
 * выполняя обрезку (клиппинг) границ за пределами выбранного экрана.
 */
export function filterWindowBoundsForDisplay(
    windowBounds: WindowBounds[], 
    display: DisplaySourceInfo, 
    thumbnail: NativeImage | null
): WindowBounds[] {
    if (!display || !windowBounds || !windowBounds.length) return [];

    const { x: dx, y: dy, width, height } = display.bounds;
    const sf = display.scaleFactor || 1;

    // Вычисляем реальный размер thumbnail (физические пиксели)
    const thumbW = thumbnail ? ((thumbnail as any).width || (thumbnail.getSize && thumbnail.getSize().width) || 0) : 0;
    const thumbH = thumbnail ? ((thumbnail as any).height || (thumbnail.getSize && thumbnail.getSize().height) || 0) : 0;

    console.log('[capture-diag] display.bounds:', JSON.stringify(display.bounds),
        'scaleFactor:', sf,
        'thumbnail:', thumbW + 'x' + thumbH,
        'rawWindowBoundsCount:', windowBounds.length);
        
    if (windowBounds.length) {
        const sample = windowBounds.slice(0, 3);
        console.log('[capture-diag] sample raw windowBounds:', JSON.stringify(sample));
    }

    // Клиппинг идет по физическим границам: max(bounds * scaleFactor, thumbnail).
    const clipW = Math.max(Math.ceil(width * sf), thumbW);
    const clipH = Math.max(Math.ceil(height * sf), thumbH);
    const clipX = dx * sf;
    const clipY = dy * sf;

    console.log('[capture-diag] clip region:', clipX, clipY, clipW, clipH);

    const result = windowBounds
        .filter(win =>
            win.x < clipX + clipW &&
            win.x + win.w > clipX &&
            win.y < clipY + clipH &&
            win.y + win.h > clipY
        )
        .map(win => {
            const cx = Math.max(win.x, clipX);
            const cy = Math.max(win.y, clipY);
            const cr = Math.min(win.x + win.w, clipX + clipW);
            const cb = Math.min(win.y + win.h, clipY + clipH);
            return {
                x: cx - clipX,
                y: cy - clipY,
                w: cr - cx,
                h: cb - cy
            };
        })
        .filter(win => win.w > 50 && win.h > 50);

    if (result.length) {
        console.log('[capture-diag] sample filtered windowBounds:', JSON.stringify(result.slice(0, 3)));
    }
    return result;
}

/**
 * Собирает полный пакет данных (Payload) для инициализации окна захвата скриншота.
 */
export function buildCapturePayload(
    displayInfo: DisplaySourceInfo, 
    imageSrc: string, 
    mode: string, 
    windowBounds: WindowBounds[]
) {
    const { bounds, scaleFactor, thumbnail } = displayInfo;
    return {
        imageSrc,
        mode,
        windowBounds: filterWindowBoundsForDisplay(windowBounds, displayInfo, thumbnail),
        screenWidth: bounds.width,
        screenHeight: bounds.height,
        scaleFactor,
        displayId: displayInfo.id,
        displayLabel: displayInfo.label,
        displayOffsetX: bounds.x,
        displayOffsetY: bounds.y
    };
}

/**
 * Преобразует объекты NativeImage в DataURL формат base64 для передачи и отображения в UI выбора монитора.
 */
export function buildPickerPayload(displays: DisplaySourceInfo[]) {
    return displays.map(d => ({
        id: d.id,
        index: d.index,
        label: d.label,
        isPrimary: d.isPrimary,
        bounds: d.bounds,
        thumbnail: d.thumbnail ? d.thumbnail.toDataURL() : null
    }));
}