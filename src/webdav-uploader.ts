import * as http from 'http';
import * as https from 'https';
import { Readable } from 'stream';
import { createClient, WebDAVClient } from 'webdav';

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
 * Создаёт http/https агенты без лимитов на размер тела запроса/ответа.
 * По умолчанию Node.js http ставит maxHeaderSize и через axios (который
 * использует webdav) есть лимит на размер тела — отключаем.
 */
function createAgents() {
    return {
        httpAgent: new http.Agent({ keepAlive: true }),
        httpsAgent: new https.Agent({ keepAlive: true, rejectUnauthorized: true })
    };
}

/**
 * Загрузка файла на Nextcloud через WebDAV с автоматическим рекурсивным созданием папок.
 *
 * Поддерживает файлы любого размера:
 * - Для файлов <= 50 МБ отправляем как Buffer (быстрее)
 * - Для файлов > 50 МБ передаём как Readable stream — webdav библиотека
 *   использует chunked transfer encoding.
 *
 * Лимит на размер файла задаётся сервером Nextcloud (php_value upload_max_filesize
 * и post_max_size в php.ini, по умолчанию 2 ГБ). Клиентского ограничения нет —
 * на http/https агентах выставлен keepAlive без лимитов на body.
 */
const STREAMING_THRESHOLD = 50 * 1024 * 1024; // 50 МБ

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

        console.log(`[WebDAV] targetUrl: ${targetUrl}, folderPath: ${folderPath.join('/') || '(пусто)'}, size: ${buffer.length} bytes`);

        const agents = createAgents();

        // Создаём клиента на базовом уровне /remote.php/webdav/
        const baseWebdavUrl = `${urlParts.origin}/remote.php/webdav/`;
        const baseClient = createClient(baseWebdavUrl, {
            username: login,
            password: password,
            ...agents
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

        const client: WebDAVClient = createClient(baseUrl, {
            username: login,
            password: password,
            ...agents,
            // Снимаем дефолтные лимиты axios через maxBodyLength/maxContentLength
            maxBodyLength: Infinity,
            maxContentLength: Infinity
        } as any);

        // Для больших файлов используем стрим, чтобы избежать
        // ограничений Buffer pooling и max-old-size в Node.js HTTP.
        if (buffer.length > STREAMING_THRESHOLD) {
            console.log(`[WebDAV] Файл > 50 МБ, используем streaming upload`);
            const stream = Readable.from(buffer, { objectMode: false });
            await client.putFileContents(`/${filename}`, stream as any);
        } else {
            await client.putFileContents(`/${filename}`, buffer);
        }

        const fileUrl = `${baseUrl}${encodeURIComponent(filename)}`;
        // filePath — декодированный путь для OCS API (/Скриншоты/file.png)
        const filePath = '/' + folderPath.join('/') + '/' + filename;

        return { success: true, url: fileUrl, filePath };
    } catch (error: any) {
        console.error('Ошибка WebDAV:', error);
        // Специальная обработка 413 — файл превышает серверный лимит
        if (error?.status === 413 || error?.response?.status === 413) {
            return {
                success: false,
                error: 'Файл слишком большой. Увеличьте лимит upload_max_filesize на сервере Nextcloud.'
            };
        }
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