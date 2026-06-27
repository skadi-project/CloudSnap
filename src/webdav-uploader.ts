import * as http from 'http';
import * as https from 'https';
import { createClient } from 'webdav';

// Интерфейс для результата загрузки файла
export interface UploadResult {
    success: boolean;
    url?: string;
    filePath?: string;
    error?: string;
}

// Интерфейс для результата проверки соединения
export interface TestResult {
    success: boolean;
    error?: string;
}

// Интерфейс для результата создания публичной ссылки
export interface ShareResult {
    success: boolean;
    url?: string;
    error?: string;
}

/**
 * Загрузка файла на Nextcloud через WebDAV с автоматическим рекурсивным созданием папок.
 */
export async function uploadToNextcloud(
    targetUrl: string,
    login: string,
    password: string,
    filename: string,
    buffer: Buffer
): Promise<UploadResult> {
    try {
        const baseUrl = targetUrl.endsWith('/') ? targetUrl : targetUrl + '/';
        const urlParts = new URL(targetUrl);
        
        // url.pathname сохраняет percent-encoding (%D0%A1...), НЕ декодирует.
        // Нужно вручную decodeURIComponent, чтобы получить кириллические строки.
        const pathParts = urlParts.pathname.split('/').filter(Boolean).map(decodeURIComponent);
        const webdavIdx = pathParts.indexOf('webdav');
        const folderPath = webdavIdx >= 0 ? pathParts.slice(webdavIdx + 1) : [pathParts[pathParts.length - 1] || ''];

        console.log(`[WebDAV] targetUrl: ${targetUrl}, folderPath: ${folderPath.join('/') || '(пусто)'}`);

        // Создаём клиента на базовом уровне /remote.php/webdav/
        const baseWebdavUrl = `${urlParts.origin}/remote.php/webdav/`;
        const baseClient = createClient(baseWebdavUrl, {
            username: login,
            password: password
        });

        // Рекурсивное создание вложенных папок
        for (let i = 0; i < folderPath.length; i++) {
            const subPath = '/' + folderPath.slice(0, i + 1).join('/');
            try {
                await baseClient.createDirectory(subPath);
                console.log(`[WebDAV] Папка ${subPath} создана`);
            } catch (e: any) {
                if (e?.status === 405) {
                    console.log(`[WebDAV] Папка ${subPath} уже существует`);
                } else {
                    console.log(`[WebDAV] createDirectory ${subPath} error: ${e?.status} ${e?.message}`);
                }
            }
        }

        const client = createClient(baseUrl, {
            username: login,
            password: password
        });

        // filename передаётся как есть — библиотека webdav URL-encode'ит его
        await client.putFileContents(`/${filename}`, buffer);

        const fileUrl = `${baseUrl}${encodeURIComponent(filename)}`;
        // filePath — декодированный путь для OCS API (/Скриншоты/file.png)
        const filePath = '/' + folderPath.join('/') + '/' + filename;

        return { success: true, url: fileUrl, filePath };
    } catch (error) {
        console.error('Ошибка WebDAV:', error);
        return {
            success: false,
            error: 'Ошибка сети. Файл добавлен в очередь отправки.'
        };
    }
}

/**
 * Проверка подключения к серверу (выполняет PROPFIND запрос на корень).
 */
export async function testConnection(url: string, login: string, password: string): Promise<TestResult> {
    try {
        const baseUrl = url.endsWith('/') ? url : url + '/';
        const client = createClient(baseUrl, {
            username: login,
            password: password
        });

        // PROPFIND на корень для проверки доступности и авторизации
        await client.getDirectoryContents('/');

        return { success: true };
    } catch (error: any) {
        console.error('Ошибка проверки подключения:', error);
        let message = 'Не удалось подключиться к серверу';
        if (error?.status === 401) message = 'Неверный логин или пароль (401)';
        else if (error?.status === 404) message = 'Сервер не найден (404)';
        else if (error?.code === 'ECONNREFUSED' || error?.cause?.code === 'ECONNREFUSED') {
            message = 'Сервер недоступен. Проверьте адрес.';
        }
        return { success: false, error: message };
    }
}

/**
 * Создание публичной ссылки через Nextcloud OCS Share API.
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

            req.setTimeout(15000, () => {
                req.destroy();
                resolve({ success: false, error: 'Таймаут создания публичной ссылки (15 сек)' });
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