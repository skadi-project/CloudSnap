import { execFileSync, exec } from 'child_process';
import { App } from 'electron';
import * as path from 'path';
import * as fs from 'fs';

// Интерфейс для координат и размеров окон
export interface WindowBounds {
    x: number;
    y: number;
    w: number;
    h: number;
}

// Интерфейс для информации о трей-иконке
export interface TrayIconInfo {
    filePath: string | null;
    isTemplate: boolean;
}

/**
 * Получение координат и размеров видимых окон на macOS.
 * Использует JXA (System Events) через osascript для перечисления окон,
 * а screen height берётся из Electron — не нужен ObjC.bridge.
 *
 * Возвращает массив { x, y, w, h } в top-left координатах,
 * совместимых с desktopCapturer thumbnail.
 */
export function getWindowBounds(): WindowBounds[] {
    if (process.platform !== 'darwin') return [];

    try {
        const script = `
var sysEvents = Application('System Events');
var lines = [];
var procs = sysEvents.processes.whose({visible: true, backgroundOnly: false});

for (var i = 0; i < procs.length; i++) {
    try {
        var wins = procs[i].windows();
        for (var j = 0; j < wins.length; j++) {
            var pos = wins[j].position();
            var sz = wins[j].size();
            var x = pos[0];
            var y = pos[1];
            var w = sz[0];
            var h = sz[1];
            if (w > 100 && h > 100 && x >= 0) {
                lines.push(x + ',' + y + ',' + w + ',' + h);
            }
        }
    } catch(e) {}
}
lines.join('|');
`;

        const stdout = execFileSync('/usr/bin/osascript', ['-l', 'JavaScript', '-e', script], {
            encoding: 'utf8',
            timeout: 5000
        });

        const output = stdout.trim();
        if (!output) return [];

        // macOS Accessibility API возвращает логические (top-left) координаты,
        // они совместимы с Electron display.bounds
        return output.split('|').map((line): WindowBounds | null => {
            const parts = line.split(',').map(Number);
            if (parts.length !== 4 || parts.some(n => !isFinite(n))) return null;
            return { x: parts[0], y: parts[1], w: parts[2], h: parts[3] };
        }).filter((item): item is WindowBounds => item !== null);
    } catch (e) {
        const errorMessage = e instanceof Error ? e.message : String(e);
        console.error('[macOS] Ошибка getWindowBounds через JXA:', errorMessage);
        return getWindowBoundsAppleScript();
    }
}

/**
 * Fallback: AppleScript-версия получения окон.
 * screenHeight передаётся из Electron, не через system_profiler.
 */
export function getWindowBoundsAppleScript(): WindowBounds[] {
    try {
        const appleScript = `
tell application "System Events"
    set output to ""
    repeat with proc in (every process whose visible is true and background only is false)
        try
            repeat with w in (every window of proc)
                set winPos to position of w
                set winSize to size of w
                set x to item 1 of winPos
                set y to item 2 of winPos
                set wWidth to item 1 of winSize
                set wHeight to item 2 of winSize
                if wWidth > 100 and wHeight > 100 then
                    set output to output & x & "," & y & "," & wWidth & "," & wHeight & "|"
                end if
            end repeat
        end try
    end repeat
    return output
end tell
`;

        const stdout = execFileSync('/usr/bin/osascript', ['-e', appleScript], {
            encoding: 'utf8',
            timeout: 5000
        });

        const output = stdout.trim();
        if (!output) return [];

        return output.split('|').filter(s => s.length > 0).map((line): WindowBounds | null => {
            const parts = line.split(',').map(Number);
            if (parts.length !== 4 || parts.some(n => !isFinite(n))) return null;
            return { x: parts[0], y: parts[1], w: parts[2], h: parts[3] };
        }).filter((item): item is WindowBounds => item !== null);
    } catch (e) {
        const errorMessage = e instanceof Error ? e.message : String(e);
        console.error('[macOS] Ошибка getWindowBounds через AppleScript:', errorMessage);
        return [];
    }
}

/**
 * На macOS Accessibility API требует разрешения.
 * Проверяем, дано ли разрешение System Preferences → Security & Privacy → Accessibility.
 */
export function checkAccessibilityPermission(): boolean {
    try {
        const script = `
ObjC.import('ApplicationServices');
var opts = $.NSDictionary.dictionaryWithObjectForKey($.NSNumber.numberWithBool(false), "AXTrustedCheckOptionPrompt");
$.AXIsProcessTrustedWithOptions(opts);
`;
        const stdout = execFileSync('/usr/bin/osascript', ['-l', 'JavaScript', '-e', script], {
            encoding: 'utf8',
            timeout: 3000
        });
        return stdout.trim() === 'true';
    } catch (e) {
        // JXA может не иметь AXIsProcessTrustedWithOptions в osascript-контексте,
        // fallback: попробуем через AppleScript
        try {
            const stdout = execFileSync('/usr/bin/osascript', ['-e',
                'tell application "System Events" to get isAXTrusted'], {
                encoding: 'utf8',
                timeout: 3000
            });
            return stdout.trim() === 'true';
        } catch (e2) {
            return false;
        }
    }
}

/**
 * Открытие системных настроек Accessibility.
 * JXA isAXTrusted(true) не работает (-1708), поэтому открываем настройки напрямую.
 */
export function requestAccessibilityPermission(): void {
    try {
        exec('open "x-apple.systempreferences:com.apple.preference.security?Accessibility"', (err) => {
            if (err) console.error('[macOS] Ошибка открытия Accessibility:', err.message);
        });
    } catch (e) {
        const errorMessage = e instanceof Error ? e.message : String(e);
        console.error('[macOS] Ошибка запроса Accessibility:', errorMessage);
    }
}

/**
 * Проверка разрешения Screen Recording на macOS 10.15+.
 * desktopCapturer.getSources() вернёт пустые/чёрные thumbnails без этого разрешения.
 * Реальная проверка делается в main.ts через desktopCapturer thumbnail.
 */
export function checkScreenRecordingPermission(): boolean {
    // Нельзя проверить напрямую через JXA/AppleScript.
    // Проверка делается в main.ts после вызова desktopCapturer.getSources().
    return true;
}

/**
 * Открытие системных настроек Screen Recording.
 */
export function requestScreenRecordingPermission(): void {
    try {
        exec('open "x-apple.systempreferences:com.apple.preference.security?Privacy_ScreenCapture"', (err) => {
            if (err) console.error('[macOS] Ошибка открытия Screen Recording:', err.message);
        });
    } catch (e) {
        const errorMessage = e instanceof Error ? e.message : String(e);
        console.error('[macOS] Ошибка запроса Screen Recording:', errorMessage);
    }
}

/**
 * Генерация tray-icon для macOS.
 * macOS tray-иконки — template-изображения (чёрный силуэт 16×16),
 * Electron автоматически инвертирует их для dark mode,
 * если имя файла содержит слово "Template".
 *
 * Возвращает { filePath, isTemplate } — filePath для Tray(), isTemplate для суффикса.
 */
export function getTrayIconInfo(appPath: string): TrayIconInfo {
    const candidateDirs = [
        appPath,
        __dirname,
        path.join(appPath, '..'),
        path.join(__dirname, '..'),
    ].filter(Boolean);
    const preferredFiles = ['tray-icon-mac.png', 'tray-icon.png'];

    for (const iconDir of candidateDirs) {
        for (const fileName of preferredFiles) {
            const filePath = path.join(iconDir, fileName);
            if (fs.existsSync(filePath)) {
                return { filePath, isTemplate: false };
            }
        }
    }

    // Файл шаблонной иконки больше не используется для трея, чтобы избежать
    // поведения macOS с белым кругом/инверсией.
    return { filePath: null, isTemplate: false };
}

/**
 * Настройка автозапуска на macOS.
 * Electron setLoginItemSettings работает на macOS,
 * но нужно указать скрытый запуск (app.hideOnLaunch).
 */
export function setAutoStartMacOS(enable: boolean, app: App): void {
    if (process.platform !== 'darwin') return;

    try {
        app.setLoginItemSettings({
            openAtLogin: enable,
            openAsHidden: true,   // macOS: запускать скрыто (только в трее)
            name: 'CloudSnap'
        });
    } catch (e) {
        const errorMessage = e instanceof Error ? e.message : String(e);
        console.error('[macOS] Ошибка настройки автозапуска:', errorMessage);
    }
}