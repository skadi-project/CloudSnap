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
    title: string; // base64-encoded title (для матчинга с desktopCapturer)
}

// Интерфейс для информации о трей-иконке
export interface TrayIconInfo {
    filePath: string | null;
    isTemplate: boolean;
}

// Утилита для base64-кодирования UTF-8 строки в JXA/AppleScript-контексте
function b64Encode(s: string): string {
    return Buffer.from(s, 'utf8').toString('base64');
}
function b64Decode(s: string): string {
    try { return Buffer.from(s, 'base64').toString('utf8'); } catch { return ''; }
}

/**
 * Получение координат и размеров видимых окон на macOS.
 * Использует JXA (System Events) через osascript для перечисления окон,
 * а screen height берётся из Electron — не нужен ObjC.bridge.
 *
 * Возвращает массив { x, y, w, h, title } в top-left координатах,
 * совместимых с desktopCapturer thumbnail. Title — base64.
 */
export function getWindowBounds(): WindowBounds[] {
    if (process.platform !== 'darwin') return [];

    try {
        const script = `
var sysEvents = Application('System Events');
var lines = [];
var procs = sysEvents.processes.whose({visible: true, backgroundOnly: false});

// Хелпер для base64 (используем встроенную ObjC через JXA)
ObjC.import('Foundation');
function b64(s) {
    if (!s) return '';
    var data = $.NSString.alloc.initWithUTF8String(s).dataUsingEncoding($.NSUTF8StringEncoding);
    return ObjC.unwrap(data.base64EncodedStringWithOptions(0));
}

for (var i = 0; i < procs.length; i++) {
    try {
        var wins = procs[i].windows();
        for (var j = 0; j < wins.length; j++) {
            try {
                var pos = wins[j].position();
                var sz = wins[j].size();
                var x = pos[0];
                var y = pos[1];
                var w = sz[0];
                var h = sz[1];
                if (w > 100 && h > 100 && x >= 0) {
                    var title = wins[j].name();
                    var titleB64 = b64(title || '');
                    lines.push(x + ',' + y + ',' + w + ',' + h + ',' + titleB64);
                }
            } catch(e) {}
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
            const parts = line.split(',');
            if (parts.length < 5) return null;
            const x = Number(parts[0]);
            const y = Number(parts[1]);
            const w = Number(parts[2]);
            const h = Number(parts[3]);
            if (!isFinite(x) || !isFinite(y) || !isFinite(w) || !isFinite(h)) return null;
            const titleB64 = parts.slice(4).join(',');
            return { x, y, w, h, title: b64Decode(titleB64) };
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
on b64(s)
    try
        do shell script "echo -n " & quoted form of s & " | base64"
    on error
        return ""
    end try
end b64

tell application "System Events"
    set output to ""
    repeat with proc in (every process whose visible is true and background only is false)
        try
            repeat with w in (every window of proc)
                try
                    set winPos to position of w
                    set winSize to size of w
                    set x to item 1 of winPos
                    set y to item 2 of winPos
                    set wWidth to item 1 of winSize
                    set wHeight to item 2 of winSize
                    if wWidth > 100 and wHeight > 100 then
                        set winTitle to name of w
                        set titleB64 to b64(winTitle)
                        set output to output & x & "," & y & "," & wWidth & "," & wHeight & "," & titleB64 & "|"
                    end if
                end try
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
            const parts = line.split(',');
            if (parts.length < 5) return null;
            const x = Number(parts[0]);
            const y = Number(parts[1]);
            const w = Number(parts[2]);
            const h = Number(parts[3]);
            if (!isFinite(x) || !isFinite(y) || !isFinite(w) || !isFinite(h)) return null;
            const titleB64 = parts.slice(4).join(',');
            return { x, y, w, h, title: b64Decode(titleB64) };
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