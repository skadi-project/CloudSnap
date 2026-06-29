/**
 * IPC: app-settings. Сохранение/загрузка пользовательских настроек.
 *
 * При сохранении вызывает registerShortcuts (если изменились комбинации)
 * и buildAppMenu (для обновления отображения акселераторов в меню).
 */

import { app, ipcMain } from 'electron';
import Store from 'electron-store';

import { DEFAULT_TEMPLATE } from '../../filename-utils';
import { registerShortcuts } from '../services/shortcut-controller';
import { buildAppMenu } from '../services/menu-controller';

const isMac = process.platform === 'darwin';

let macosUtils: any = null;
if (isMac) {
    try { macosUtils = require('../../macos-utils'); } catch { /* ignore */ }
}

export function registerSettingsIpc(store: Store): void {
    ipcMain.handle('save-app-settings', async (_event, settings: any) => {
        try {
            store.set('remoteFolder', settings.remoteFolder || '');
            store.set('folderStructure', settings.folderStructure || 'none');
            store.set('linkMode', settings.linkMode || 'internal');
            store.set('defaultDelay', settings.defaultDelay || 0);
            store.set('autoStart', settings.autoStart || false);
            store.set('startMinimized', settings.startMinimized || false);
            store.set('saveLocalCopy', settings.saveLocalCopy || false);
            store.set('videoBitrate', settings.videoBitrate || 2500000);
            console.log('[bitrate] save-app-settings → store.videoBitrate =', store.get('videoBitrate'),
                `(${((store.get('videoBitrate') as number) / 1_000_000).toFixed(2)} Мбит/с)`);
            store.set('recordAudio', settings.recordAudio !== undefined ? settings.recordAudio : true);
            store.set('filenameTemplate', settings.filenameTemplate || DEFAULT_TEMPLATE);

            store.set('shortcutModifier', settings.shortcutModifier);
            store.set('shortcutKey', settings.shortcutKey);
            store.set('recordShortcutModifier', settings.recordShortcutModifier);
            store.set('recordShortcutKey', settings.recordShortcutKey);
            store.set('stopShortcutModifier', settings.stopShortcutModifier);
            store.set('stopShortcutKey', settings.stopShortcutKey);

            registerShortcuts();
            buildAppMenu();

            if (process.platform === 'win32') {
                // Передаём --hidden как аргумент автозапуска, чтобы при старте
                // Windows сразу запустить приложение в трее, не показывая окно.
                // Аргумент читается в src/main/index.ts через process.argv.
                const loginArgs = settings.startMinimized ? ['--hidden'] : [];
                app.setLoginItemSettings({
                    openAtLogin: settings.autoStart,
                    path: app.getPath('exe'),
                    args: loginArgs
                });
            } else if (isMac && macosUtils) {
                macosUtils.setAutoStartMacOS(settings.autoStart, app);
            }

            return { success: true };
        } catch (error: any) {
            return { success: false, error: error.message };
        }
    });

    ipcMain.handle('load-app-settings', async () => {
        return {
            remoteFolder: store.get('remoteFolder', ''),
            folderStructure: store.get('folderStructure', 'none'),
            linkMode: store.get('linkMode', 'internal'),
            defaultDelay: store.get('defaultDelay', 0),
            autoStart: store.get('autoStart', false),
            startMinimized: store.get('startMinimized', false),
            saveLocalCopy: store.get('saveLocalCopy', false),
            shortcutModifier: store.get('shortcutModifier', isMac ? 'Command+Shift' : 'Control+Shift'),
            shortcutKey: store.get('shortcutKey', 'A'),
            recordShortcutModifier: store.get('recordShortcutModifier', isMac ? 'Command+Shift' : 'Control+Shift'),
            recordShortcutKey: store.get('recordShortcutKey', 'V'),
            stopShortcutModifier: store.get('stopShortcutModifier', isMac ? 'Command+Shift' : 'Control+Shift'),
            stopShortcutKey: store.get('stopShortcutKey', 'S'),
            videoBitrate: store.get('videoBitrate', 2500000),
            recordAudio: store.get('recordAudio', true),
            filenameTemplate: store.get('filenameTemplate', DEFAULT_TEMPLATE)
        };
    });
}