/**
 * Мониторинг соединения с сервером: heartbeat + авто-reconnect.
 *
 * Использует экспоненциальный backoff (RECONNECT_INTERVALS) при потере
 * соединения. Отправляет событие `connection-status` в mainWindow для UI.
 *
 * Зависимости передаются через setters, чтобы избежать циклов между модулями.
 */

import { BrowserWindow, ipcMain } from 'electron';
import Store from 'electron-store';
import { testConnection } from '../../webdav/uploader';
import { getDecryptedPassword } from '../security';
import { HEARTBEAT_INTERVAL, RECONNECT_INTERVALS } from '../config';
import type { ConnectionStatus } from '../types';

let store: Store | null = null;
let mainWindowGetter: () => BrowserWindow | null = () => null;

let connectionMonitorTimer: NodeJS.Timeout | null = null;
let reconnectTimer: NodeJS.Timeout | null = null;
let connectionState: ConnectionStatus = 'connected';
let reconnectAttemptIndex = 0;

export function setConnectionStore(s: Store): void { store = s; }
export function setConnectionMainWindowGetter(fn: () => BrowserWindow | null): void {
    mainWindowGetter = fn;
}

function sendConnectionStatus(status: ConnectionStatus, message: string): void {
    const win = mainWindowGetter();
    if (win && !win.isDestroyed()) {
        win.webContents.send('connection-status', { status, message });
    }
}

export function getConnectionState(): ConnectionStatus {
    return connectionState;
}

/**
 * Текущий «человекочитаемый» текст для активного состояния подключения.
 * Нужен IPC-обработчику get-connection-status, чтобы рендерер мог
 * синхронизироваться с main-процессом без гонки с событием connection-status.
 */
export function getConnectionMessageFor(status: ConnectionStatus): string {
    switch (status) {
        case 'connected': return 'Подключено к облаку';
        case 'disconnected': return 'Соединение потеряно';
        case 'reconnecting': return 'Переподключение...';
        case 'checking':
        default: return 'Проверка соединения...';
    }
}

async function checkServerConnection(): Promise<boolean> {
    if (!store) return false;
    const url = store.get('url', '') as string;
    const login = store.get('login', '') as string;
    if (!url || !login) return false;
    const password = getDecryptedPassword(store);
    if (!password) return false;
    try {
        const result = await testConnection(url, login, password);
        return result.success;
    } catch {
        return false;
    }
}

function startHeartbeat(): void {
    stopHeartbeat();
    connectionMonitorTimer = setInterval(async () => {
        const ok = await checkServerConnection();
        if (ok) {
            if (connectionState !== 'connected') {
                connectionState = 'connected';
                reconnectAttemptIndex = 0;
                stopReconnectTimer();
                sendConnectionStatus('connected', 'Соединение восстановлено');
            }
        } else {
            if (connectionState === 'connected') {
                connectionState = 'disconnected';
                reconnectAttemptIndex = 0;
                sendConnectionStatus('disconnected', 'Соединение потеряно');
                startReconnect();
            }
        }
    }, HEARTBEAT_INTERVAL * 1000);
}

export function stopHeartbeat(): void {
    if (connectionMonitorTimer) {
        clearInterval(connectionMonitorTimer);
        connectionMonitorTimer = null;
    }
}

function startReconnect(): void {
    stopReconnectTimer();
    if (reconnectAttemptIndex >= RECONNECT_INTERVALS.length) {
        reconnectAttemptIndex = RECONNECT_INTERVALS.length - 1;
    }
    const delay = RECONNECT_INTERVALS[reconnectAttemptIndex];
    sendConnectionStatus('reconnecting', `Повторное соединение через ${delay} сек...`);
    reconnectTimer = setTimeout(async () => {
        const ok = await checkServerConnection();
        if (ok) {
            connectionState = 'connected';
            reconnectAttemptIndex = 0;
            stopReconnectTimer();
            sendConnectionStatus('connected', 'Соединение восстановлено');
        } else {
            reconnectAttemptIndex++;
            startReconnect();
        }
    }, delay * 1000);
}

export function stopReconnectTimer(): void {
    if (reconnectTimer) {
        clearTimeout(reconnectTimer);
        reconnectTimer = null;
    }
}

export async function initConnectionMonitor(): Promise<void> {
    if (!store) return;
    const hasPassword = store.has('password');
    if (!hasPassword) return;
    connectionState = 'checking';
    sendConnectionStatus('checking', 'Проверка соединения...');
    const ok = await checkServerConnection();
    if (ok) {
        connectionState = 'connected';
        reconnectAttemptIndex = 0;
        sendConnectionStatus('connected', 'Готово к работе.');
        startHeartbeat();
    } else {
        connectionState = 'disconnected';
        sendConnectionStatus('disconnected', 'Соединение потеряно');
        startReconnect();
    }
}

export function resetConnectionState(): void {
    connectionState = 'connected';
    stopHeartbeat();
    stopReconnectTimer();
}

/**
 * Регистрирует IPC-обработчик `get-connection-status`. Используется рендерером
 * после регистрации слушателя `connection-status`, чтобы синхронизировать
 * состояние, если первое событие было потеряно из-за гонки (рендерер ещё
 * не успел подписаться, а main уже отправил «checking»). Без этого бэйдж
 * статуса подключения мог на ~60 с оставаться без стиля (default-класс),
 * пока не сработает heartbeat.
 */
export function registerConnectionIpc(): void {
    ipcMain.handle('get-connection-status', () => {
        return {
            status: connectionState,
            message: getConnectionMessageFor(connectionState)
        };
    });
}