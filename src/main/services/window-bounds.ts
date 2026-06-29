/**
 * Получение координат и заголовков видимых окон системы.
 *
 * Используется режимом захвата «Окно» (screenshot mode='window') и
 * area-selector'ом для подсветки окна под курсором и per-window capture
 * через desktopCapturer.getUserMedia(sourceId='window:...').
 *
 * На macOS координаты возвращает JXA/AppleScript через macos-utils.getWindowBounds()
 * — координаты логические (point), совпадают с Electron display.bounds.
 *
 * На Windows координаты возвращает PowerShell-обёртка над Win32 API
 * (EnumWindows + GetWindowRect + GetWindowText). SetProcessDPIAware()
 * даёт физические (DPI-unadjusted) координаты — display-utils.filterWindowBoundsForDisplay
 * переводит их в thumbnail-пиксели с учётом scale factor монитора.
 *
 * На Linux функция возвращает пустой массив — desktopCapturer всё равно
 * даст список окон (и sourceId), но без геометрии для подсветки. UI в режиме
 * «Окно» на Linux работает в режиме best-effort.
 */
import { execFileSync } from 'child_process';
import type { WindowBoundsData } from '../types';
import { getWindowBounds as getMacWindowBounds } from '../../macos-utils';

interface MacWindowBounds {
    x: number;
    y: number;
    w: number;
    h: number;
    title: string;
}

/**
 * PowerShell-скрипт, перечисляющий видимые top-level окна.
 * Возвращает строки формата "x,y,w,h,base64title" разделённые "|".
 * Если ни одного окна — выводит "NONE".
 *
 * Логика:
 *  • SetProcessDPIAware — физические координаты от DwmGetWindowAttribute
 *  • DwmGetWindowAttribute(DWMWA_EXTENDED_FRAME_BOUNDS) — ТОЧНЫЕ видимые
 *    границы окна БЕЗ drop-shadow. На Windows 11 в дефолтной теме
 *    тень ~10px справа/снизу — GetWindowRect включает тень в (w, h),
 *    а desktopCapturer.captureWindow() её исключает. Отсюда расхождение:
 *    рамка подсветки шире фактических границ окна, а в снимке после
 *    crop к PowerShell-координатам появляется пустая полоса справа/снизу.
 *    DWMWA_EXTENDED_FRAME_BOUNDS возвращает rect без тени — точно
 *    совпадает с тем, что рендерит desktopCapturer.
 *    Fallback на GetWindowRect, если DWM недоступен (legacy).
 *  • IsWindowVisible — отсекаем свёрнутые/фоновые окна
 *  • WS_CHILD — пропускаем дочерние контролы (Edit, Button и т.п.)
 *  • Минимальный размер 100×100 — убираем тулбары/таб-бары без рамки
 *  • Не пустой title — убираем служебные окна
 *  • base64(title) — защита от '|' и ',' в заголовке
 */
const POWERSHELL_SCRIPT = `
$signature = @"
using System;
using System.Runtime.InteropServices;
using System.Text;
using System.Collections.Generic;

public class WinEnum {
    public delegate bool EnumWindowsProc(IntPtr hWnd, IntPtr lParam);

    [DllImport("user32.dll")]
    public static extern bool EnumWindows(EnumWindowsProc enumProc, IntPtr lParam);

    [DllImport("user32.dll")]
    public static extern bool IsWindowVisible(IntPtr hWnd);

    [DllImport("user32.dll", CharSet=CharSet.Unicode)]
    public static extern int GetWindowText(IntPtr hWnd, StringBuilder lpString, int nMaxCount);

    [DllImport("dwmapi.dll")]
    public static extern int DwmGetWindowAttribute(IntPtr hWnd, int dwAttribute, out RECT pvAttribute, int cbAttribute);

    [DllImport("user32.dll")]
    public static extern bool GetWindowRect(IntPtr hWnd, out RECT lpRect);

    [DllImport("user32.dll")]
    public static extern bool SetProcessDPIAware();

    [DllImport("user32.dll")]
    public static extern int GetWindowLong(IntPtr hWnd, int nIndex);

    [StructLayout(LayoutKind.Sequential)]
    public struct RECT {
        public int Left, Top, Right, Bottom;
    }
}
"@

# DWMWA_EXTENDED_FRAME_BOUNDS = 9: DWM-rendered frame bounds WITHOUT drop shadow.
$DWMWA_EXTENDED_FRAME_BOUNDS = 9

Add-Type -TypeDefinition $signature -Language CSharp | Out-Null

# Физические координаты вместо logical (DPI-aware). Без этого DWM API
# возвращает logical-пиксели, и при scaleFactor > 1 окна сдвигаются.
[WinEnum]::SetProcessDPIAware() | Out-Null

$results = New-Object System.Collections.Generic.List[string]

$callback = [WinEnum+EnumWindowsProc] {
    param($hWnd, $lParam)

    if (-not [WinEnum]::IsWindowVisible($hWnd)) { return $true }

    # WS_CHILD = 0x40000000 — пропускаем дочерние контролы
    $style = [WinEnum]::GetWindowLong($hWnd, -16)
    if (($style -band 0x40000000) -ne 0) { return $true }

    # Сначала пробуем DWMWA_EXTENDED_FRAME_BOUNDS (без тени).
    # RECT — 4 ints × 4 байта = 16 байт.
    $rect = New-Object WinEnum+RECT
    $hr = [WinEnum]::DwmGetWindowAttribute($hWnd, $DWMWA_EXTENDED_FRAME_BOUNDS, [ref]$rect, 16)
    if ($hr -ne 0) {
        # DWM недоступен — fallback на GetWindowRect (включая тень).
        if (-not [WinEnum]::GetWindowRect($hWnd, [ref]$rect)) { return $true }
    }

    $w = $rect.Right - $rect.Left
    $h = $rect.Bottom - $rect.Top
    if ($w -lt 100 -or $h -lt 100) { return $true }

    $sb = New-Object System.Text.StringBuilder 512
    [WinEnum]::GetWindowText($hWnd, $sb, 512) | Out-Null
    $title = $sb.ToString()
    if ([string]::IsNullOrWhiteSpace($title)) { return $true }

    $bytes = [System.Text.Encoding]::UTF8.GetBytes($title)
    $b64 = [Convert]::ToBase64String($bytes)
    $results.Add("$($rect.Left),$($rect.Top),$w,$h,$b64")
    return $true
}

[WinEnum]::EnumWindows($callback, [IntPtr]::Zero) | Out-Null

if ($results.Count -eq 0) {
    Write-Output "NONE"
} else {
    Write-Output ($results -join "|")
}
`;

function decodeBase64(b64: string): string {
    try {
        return Buffer.from(b64, 'base64').toString('utf8');
    } catch {
        return '';
    }
}

/**
 * Windows: PowerShell + Win32 API.
 *
 * -Command передаёт скрипт текстом, поэтому execution policy не применяется
 * (это поведение по дизайну PowerShell — аналогично upload-orchestrator.notifyExplorer).
 */
function getWindowBoundsWindows(): WindowBoundsData[] {
    if (process.platform !== 'win32') return [];
    try {
        const stdout = execFileSync('powershell.exe', [
            '-NoProfile',
            '-NonInteractive',
            '-Command', POWERSHELL_SCRIPT
        ], { encoding: 'utf8', timeout: 5000 });

        const output = stdout.trim();
        if (!output || output === 'NONE') return [];

        return output.split('|')
            .map((line): WindowBoundsData | null => {
                // title — последнее поле, base64 не содержит ',' — режем строго по 5
                const parts = line.split(',');
                if (parts.length < 5) return null;
                const x = Number(parts[0]);
                const y = Number(parts[1]);
                const w = Number(parts[2]);
                const h = Number(parts[3]);
                if (!isFinite(x) || !isFinite(y) || !isFinite(w) || !isFinite(h)) return null;
                const b64 = parts.slice(4).join(',');
                const title = decodeBase64(b64);
                return { x, y, w, h, title };
            })
            .filter((b): b is WindowBoundsData => b !== null && !!b.title);
    } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        console.error('[window-bounds] PowerShell enumeration failed:', msg);
        return [];
    }
}

/**
 * macOS: JXA/AppleScript через macos-utils (логические координаты).
 */
function getWindowBoundsMac(): WindowBoundsData[] {
    const list = getMacWindowBounds() as MacWindowBounds[];
    return list.map(b => ({
        x: b.x,
        y: b.y,
        w: b.w,
        h: b.h,
        title: b.title
    }));
}

/**
 * Универсальная функция для подсветки окон в capture-window и area-selector.
 * На Linux возвращает [] — desktopCapturer всё равно даст sourceId по
 * клику (renderer умеет fallback на crop), но без предпросмотра под курсором.
 */
export function getWindowBoundsUniversal(): WindowBoundsData[] {
    if (process.platform === 'win32') return getWindowBoundsWindows();
    if (process.platform === 'darwin') return getWindowBoundsMac();
    return [];
}