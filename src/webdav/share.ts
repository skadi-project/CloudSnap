/**
 * Публичные ссылки через Nextcloud OCS Share API.
 * Вынесено из webdav-uploader.ts для лучшего разделения ответственности.
 */

import * as http from 'http';
import * as https from 'https';

export interface ShareResult {
    success: boolean;
    url?: string;
    error?: string;
}

/**
 * Создание публичной ссылки через Nextcloud OCS Share API.
 * Таймаут увеличен до 60с — для больших файлов серверу нужно больше времени.
 */
export async function createPublicShare(
    serverUrl: string,
    login: string,
    password: string,
    filePath: string
): Promise<ShareResult> {
    try {
        const proto = serverUrl.startsWith('https') ? https : http;
        const urlObj = new URL(serverUrl);
        const auth = 'Basic ' + Buffer.from(login + ':' + password).toString('base64');

        // filePath — декодированный путь (/Скриншоты/file.png).
        // OCS API ожидает URL-encoded путь, но / не должны быть закодированы.
        const encodedPath = filePath.split('/').map(p => encodeURIComponent(p)).join('/');
        const body = `path=${encodedPath}&shareType=3&permissions=1`;

        const options: http.RequestOptions = {
            hostname: urlObj.hostname,
            port: urlObj.port || (urlObj.protocol === 'https:' ? 443 : 80),
            path: '/ocs/v2.php/apps/files_sharing/api/v1/shares',
            method: 'POST',
            headers: {
                'Authorization': auth,
                'OCS-APIRequest': 'true',
                'Content-Type': 'application/x-www-form-urlencoded',
                'Accept': 'application/json',
                'Content-Length': Buffer.byteLength(body)
            }
        };

        return new Promise<ShareResult>((resolve) => {
            const req = proto.request(options, (res) => {
                let data = '';
                res.on('data', (chunk) => data += chunk);
                res.on('end', () => {
                    try {
                        const json = JSON.parse(data);
                        const shareUrl = json.ocs?.data?.url;
                        if (shareUrl) {
                            console.log(`[OCS] Публичная ссылка создана: ${shareUrl}`);
                            resolve({ success: true, url: shareUrl });
                        } else {
                            console.error('[OCS] Ответ без URL:', data);
                            resolve({ success: false, error: 'Не удалось получить публичную ссылку' });
                        }
                    } catch (e) {
                        console.error('[OCS] Ошибка парсинга ответа:', data);
                        resolve({ success: false, error: 'Ошибка ответа сервера при создании ссылки' });
                    }
                });
            });

            req.setTimeout(60000, () => {
                req.destroy();
                resolve({ success: false, error: 'Таймаут создания публичной ссылки (60 сек)' });
            });

            req.on('error', (e) => {
                console.error('[OCS] Ошибка запроса:', e.message);
                resolve({ success: false, error: 'Ошибка сети при создании ссылки' });
            });

            req.write(body);
            req.end();
        });
    } catch (error) {
        console.error('[OCS] Исключение:', error);
        return { success: false, error: 'Ошибка создания публичной ссылки' };
    }
}