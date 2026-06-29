/**
 * Регистрация всех IPC-обработчиков. Вызывается один раз из src/main/index.ts.
 */

import Store from 'electron-store';
import { registerCredentialsIpc } from './credentials';
import { registerUploadIpc } from './upload';
import { registerCaptureIpc } from './capture';
import { registerRecordingIpc } from './recording';
import { registerHistoryIpc } from './history';
import { registerSettingsIpc } from './settings';
import { registerConnectionIpc } from '../services/connection-monitor';
import { generateFileId } from '../../filename-utils';

export interface IpcRegistrationDeps {
    store: Store;
    getMainWindow: () => import('electron').BrowserWindow | null;
    buildFilename: (type: string, monitorIndex: number | null) => string;
}

export function registerAllIpcHandlers(deps: IpcRegistrationDeps): void {
    registerCredentialsIpc(deps.store);
    registerUploadIpc(deps.store, deps.getMainWindow, deps.buildFilename, generateFileId);
    registerCaptureIpc(deps.store, deps.getMainWindow);
    registerRecordingIpc();
    registerHistoryIpc(deps.store, deps.getMainWindow);
    registerSettingsIpc(deps.store);
    registerConnectionIpc();
}