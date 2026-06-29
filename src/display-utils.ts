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
    title?: string; // base64-encoded или plain title, используется для матчинга с desktopCapturer
    sourceId?: string | null; // desktopCapturer source id для per-window capture
    /**
     * Полные (не клиппированные) координаты окна В СИСТЕМЕ КООРДИНАТ ДИСПЛЕЯ-ЗАХВАТА.
     * (x, y) — координаты левого-верхнего угла полного окна относительно origin
     * дисплея-захвата; могут быть отрицательными, если окно частично за ним.
     * (w, h) — полный размер окна (включая часть вне дисплея).
     *
     * Нужны renderer'у, чтобы после getUserMedia(sourceId) получить полное
     * изображение окна и обрезать его до (x, y, w, h) — иначе в снимок попадает
     * лишнее пространство за пределами подсвеченной области.
     */
    fullX?: number;
    fullY?: number;
    fullW?: number;
    fullH?: number;
}

/**
 * Информация об окне, полученная от desktopCapturer.
 * sourceId используется для захвата окна через getUserMedia —
 * это даёт чистое содержимое окна БЕЗ перекрывающих приложений,
 * в отличие от crop со скриншота экрана.
 */
export interface WindowSourceInfo {
    id: string;
    name: string; // title окна
    thumbnail: NativeImage | null;
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

    // desktopCapturer needs a single thumbnailSize for ALL sources.
    // Use the max physical dimensions so the largest monitor gets a
    // full-resolution thumbnail. Then resize each thumbnail to its
    // own monitor's physical size to avoid padding/upscale mismatch.
    const maxThumbW = Math.max(...displays.map(d => Math.ceil(d.bounds.width * (d.scaleFactor || 1))));
    const maxThumbH = Math.max(...displays.map(d => Math.ceil(d.bounds.height * (d.scaleFactor || 1))));

    const sources = await desktopCapturer.getSources({
        types: ['screen'],
        thumbnailSize: { width: maxThumbW, height: maxThumbH },
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
        const physW = Math.ceil(display.bounds.width * (display.scaleFactor || 1));
        const physH = Math.ceil(display.bounds.height * (display.scaleFactor || 1));

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

        // Resize thumbnail to this monitor's physical pixel dimensions.
        // desktopCapturer may return a padded/upscaled thumbnail when
        // thumbnailSize exceeds the monitor's actual resolution — this
        // ensures canvas.width matches viewport/scaleFactor correctly.
        let thumb: NativeImage | null = null;
        if (source) {
            const rawThumb = source.thumbnail;
            const rawSize = rawThumb.getSize();
            if (rawSize.width !== physW || rawSize.height !== physH) {
                thumb = rawThumb.resize({ width: physW, height: physH });
                console.log('[display-utils] resized thumbnail from', rawSize.width + 'x' + rawSize.height, 'to', physW + 'x' + physH);
            } else {
                thumb = rawThumb;
            }
        }

        return {
            id: display.id,
            index,
            label: source ? source.name : `Монитор ${index + 1}`,
            bounds: { ...display.bounds },
            scaleFactor: display.scaleFactor || 1,
            isPrimary: display.id === primaryId,
            sourceId: source ? source.id : null,
            thumbnail: thumb
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
 * Получает список окон через desktopCapturer с types:['window'].
 * Возвращает sourceId/title — для последующего per-window capture через getUserMedia.
 * thumbnailSize делаем большим (1920x1080) — desktopCapturer обрежет пропорционально.
 */
export async function getWindowSources(): Promise<WindowSourceInfo[]> {
    try {
        const sources = await desktopCapturer.getSources({
            types: ['window'],
            thumbnailSize: { width: 1920, height: 1080 },
            fetchWindowIcons: false
        });
        return sources.map(s => ({
            id: s.id,
            name: s.name || '',
            thumbnail: s.thumbnail || null
        }));
    } catch (e) {
        console.error('[display-utils] getWindowSources error:', e);
        return [];
    }
}

/**
 * Нормализует заголовок окна для устойчивого сравнения:
 *  • trim + collapse внутренних пробелов
 *  • нижний регистр (PowerShell и desktopCapturer могут отличаться)
 */
function normalizeTitle(t: string): string {
    return (t || '').trim().replace(/\s+/g, ' ').toLowerCase();
}

/**
 * Сопоставляет окна из desktopCapturer с windowBounds (из getWindowBounds).
 * Стратегии матчинга (по убыванию надёжности):
 *   1. Точное совпадение нормализованного title
 *   2. Частичное совпадение title (includes, нормализованное)
 *
 * Каждый sourceId используется не более одного раза — чтобы одно и то же окно
 * из desktopCapturer не подбиралось к двум разным bounds.
 *
 * Раньше использовался сырой title.includes() с учётом регистра, и на ПЕРВОМ
 * снимке после старта приложения часто проваливалось: desktopCapturer ещё не
 * перечислил заголовки и/или вернул их в кодировке, не совпадающей с PowerShell.
 * В результате hoveredWindow.sourceId = null → код в capture.html падал в
 * fallback (crop с экрана) и в снимок попадало приложение, лежащее поверх
 * целевого окна. Со второго снимка источники уже прогреты — баг не
 * воспроизводился.
 *
 * Обогащает windowBounds полем sourceId для последующего per-window capture.
 */
export function matchWindowSourcesToBounds(
    windowBounds: WindowBounds[],
    windowSources: WindowSourceInfo[]
): WindowBounds[] {
    if (!windowSources.length) {
        return windowBounds.map(b => ({ ...b, sourceId: null }));
    }
    // Готовим нормализованный список источников, отсортированный по длине
    // нормализованного title (более длинные — более специфичные, чтобы
    // exact-match срабатывал раньше, чем contains-match на подстроке).
    const normalizedSources = windowSources
        .map(s => ({ ...s, norm: normalizeTitle(s.name) }))
        .sort((a, b) => b.norm.length - a.norm.length);

    const usedSourceIds = new Set<string>();

    return windowBounds.map(b => {
        const title = normalizeTitle(b.title || '');
        let match: WindowSourceInfo | null = null;
        if (title) {
            // 1. Точное совпадение (нормализованное)
            match = normalizedSources.find(s => !usedSourceIds.has(s.id) && s.norm === title) || null;
            // 2. Частичное совпадение (нормализованное)
            if (!match) {
                match = normalizedSources.find(s =>
                    !usedSourceIds.has(s.id) && s.norm &&
                    (s.norm.includes(title) || title.includes(s.norm))
                ) || null;
            }
        }
        if (match) usedSourceIds.add(match.id);
        return { ...b, sourceId: match ? match.id : null };
    });
}

/**
 * Клиппирует координаты окон под конкретный монитор и переводит в thumbnail-пиксели.
 *
 * Windows: SetProcessDPIAware() возвращает физические (DPI-unadjusted) координаты,
 * поэтому bounds нужно перевести в физическое пространство: offset × sf_primary,
 * dimensions × sf_current. Клиппинг в физическом пространстве, результат —
 * thumbnail-пиксели без дополнительного перевода.
 *
 * macOS/Linux: JXA/AppleScript возвращает логические (point) координаты,
 * совпадающие с Electron display.bounds. Клиппинг в логическом пространстве,
 * затем перевод в thumbnail-пиксели через × sf_current.
 */
export function filterWindowBoundsForDisplay(
    windowBounds: WindowBounds[],
    display: DisplaySourceInfo,
    thumbnail: NativeImage | null
): WindowBounds[] {
    if (!display || !windowBounds || !windowBounds.length) return [];

    const { x: dx, y: dy, width, height } = display.bounds;
    const sf = display.scaleFactor || 1;
    const isWindows = process.platform === 'win32';

    const thumbW = thumbnail ? ((thumbnail as any).width || (thumbnail.getSize && thumbnail.getSize().width) || 0) : 0;
    const thumbH = thumbnail ? ((thumbnail as any).height || (thumbnail.getSize && thumbnail.getSize().height) || 0) : 0;

    console.log('[capture-diag] platform:', process.platform,
        'display.bounds:', JSON.stringify(display.bounds),
        'scaleFactor:', sf,
        'thumbnail:', thumbW + 'x' + thumbH,
        'rawWindowBoundsCount:', windowBounds.length);

    if (windowBounds.length) {
        const sample = windowBounds.slice(0, 3);
        console.log('[capture-diag] sample raw windowBounds:', JSON.stringify(sample));
    }

    if (isWindows) {
        // Windows: window coords are physical (SetProcessDPIAware).
        // Convert bounds to physical space for clipping.
        // Position uses sf_primary (desktop coordinate space scale),
        // dimensions use sf_current (this monitor's physical size).
        const sfPrimary = screen.getPrimaryDisplay().scaleFactor || 1;
        const clipX = dx * sfPrimary;
        const clipY = dy * sfPrimary;
        const clipW = Math.max(Math.ceil(width * sf), thumbW);
        const clipH = Math.max(Math.ceil(height * sf), thumbH);

        console.log('[capture-diag] sfPrimary:', sfPrimary, 'clip region:', clipX, clipY, clipW, clipH);

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
                    h: cb - cy,
                    // Сохраняем sourceId/title — нужны для per-window capture
                    sourceId: win.sourceId,
                    title: win.title,
                    // Полные координаты в display-local (для crop getUserMedia).
                    // Совпадают с системой координат захваченного окна:
                    // (x, y) — позиция левого-верхнего угла ПОЛНОГО окна
                    // (может быть отрицательной, если окно частично вне дисплея);
                    // (w, h) — полный размер.
                    fullX: win.x - clipX,
                    fullY: win.y - clipY,
                    fullW: win.w,
                    fullH: win.h
                };
            })
            .filter(win => win.w > 50 && win.h > 50);

        if (result.length) {
            console.log('[capture-diag] sample filtered windowBounds:', JSON.stringify(result.slice(0, 3)));
        }
        return result;
    }

    // macOS/Linux: window coords are logical (points), matching Electron bounds.
    // Clip in logical space, then translate to thumbnail pixels via sf_current.
    const result = windowBounds
        .filter(win =>
            win.x < dx + width &&
            win.x + win.w > dx &&
            win.y < dy + height &&
            win.y + win.h > dy
        )
        .map(win => {
            const cx = Math.max(win.x, dx);
            const cy = Math.max(win.y, dy);
            const cr = Math.min(win.x + win.w, dx + width);
            const cb = Math.min(win.y + win.h, dy + height);
            return {
                x: cx - dx,
                y: cy - dy,
                w: cr - cx,
                h: cb - cy,
                sourceId: win.sourceId,
                title: win.title,
                // Логические координаты (display-local, до × sf).
                // Применяем ту же шкалу в финальном .map ниже.
                fullX: win.x - dx,
                fullY: win.y - dy,
                fullW: win.w,
                fullH: win.h
            };
        })
        .filter(win => win.w > 50 && win.h > 50)
        .map(win => ({
            x: Math.round(win.x * sf),
            y: Math.round(win.y * sf),
            w: Math.round(win.w * sf),
            h: Math.round(win.h * sf),
            sourceId: win.sourceId,
            title: win.title,
            // Та же трансформация × sf, чтобы full* и (x, y, w, h)
            // оставались в одной системе координат — координаты
            // захваченного окна (thumbnail-пиксели).
            fullX: Math.round(win.fullX! * sf),
            fullY: Math.round(win.fullY! * sf),
            fullW: Math.round(win.fullW! * sf),
            fullH: Math.round(win.fullH! * sf)
        }));

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
        scaleFactor: d.scaleFactor,
        thumbnail: d.thumbnail ? d.thumbnail.toDataURL() : null
    }));
}