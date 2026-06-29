/**
 * IPC: credentials. save-credentials, load-credentials, test-connection.
 *
 * Пароль НЕ возвращается в renderer (раньше возвращался, но нигде не
 * использовался — лишний attack surface).
 */

import { ipcMain, safeStorage } from 'electron';
import Store from 'electron-store';

import { testConnection } from '../../webdav/uploader';
import { validateServerUrl, getDecryptedPassword } from '../security';
import {
    initConnectionMonitor,
    resetConnectionState,
    stopHeartbeat,
    stopReconnectTimer
} from '../services/connection-monitor';

export function registerCredentialsIpc(store: Store): void {
    ipcMain.handle('save-credentials', async (_event, config: any) => {
        try {
            const urlValidation = validateServerUrl(config.url || '');
            if (!urlValidation.ok) {
                return { success: false, error: urlValidation.error };
            }
            store.set('url', urlValidation.url);
            if (urlValidation.protocol === 'http:') {
                console.warn('[security] save-credentials: HTTP URL (no TLS):', urlValidation.url);
            }
            store.set('login', config.login || '');
            store.set('rememberMe', config.rememberMe ?? true);
            if (config.rememberMe && config.password) {
                const encryptedPassword = safeStorage.encryptString(config.password);
                store.set('password', encryptedPassword.toString('base64'));
            } else {
                store.delete('password');
                stopHeartbeat();
                stopReconnectTimer();
                resetConnectionState();
                return { success: true };
            }
            // Пароль сохранён — перезапускаем мониторинг соединения
            await initConnectionMonitor();
            return { success: true };
        } catch (error: any) {
            return { success: false, error: error.message };
        }
    });

    ipcMain.handle('load-credentials', async () => {
        const decrypted = getDecryptedPassword(store);
        return {
            url: store.get('url', ''),
            login: store.get('login', ''),
            rememberMe: store.get('rememberMe', true),
            hasPassword: store.has('password'),
            // Пароль НЕ возвращается в renderer — лишний surface для утечки
            password: decrypted ? '' : null
        };
    });

    ipcMain.handle('test-connection', async (_event, config: any) => {
        const urlValidation = validateServerUrl(config.url || '');
        if (!urlValidation.ok) {
            return { success: false, error: urlValidation.error };
        }
        const url = urlValidation.url;
        const login = config.login || '';
        const password = config.password || '';

        if (!login || !password) {
            return { success: false, error: 'Заполните все поля' };
        }

        return await testConnection(url, login, password);
    });
}