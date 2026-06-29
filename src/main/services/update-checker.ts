/**
 * Проверка обновлений через GitHub Releases API.
 *
 * Делает HTTPS-запрос к `https://api.github.com/repos/{owner}/{repo}/releases/latest`,
 * сравнивает версию из package.json (через `app.getVersion()`) с `tag_name` релиза и
 * возвращает структурированный результат. Без внешних зависимостей: используется
 * встроенный модуль `https`.
 */

import { app } from 'electron';
import * as https from 'https';

const REPO_OWNER = 'skadi-project';
const REPO_NAME = 'CloudSnap';
const RELEASES_URL = `https://api.github.com/repos/${REPO_OWNER}/${REPO_NAME}/releases/latest`;
const RELEASE_PAGE_URL = `https://github.com/${REPO_OWNER}/${REPO_NAME}/releases/latest`;
const REQUEST_TIMEOUT_MS = 8000;

export interface UpdateCheckResult {
    hasUpdate: boolean;
    currentVersion: string;
    latestVersion: string;
    releaseUrl: string;
    error?: string;
}

/**
 * Сравнивает две semver-подобные строки (`1.2.3`, `v1.2.3`, `1.2.3-beta.1`).
 * Префикс `v` и суффикс после `-` игнорируются. Возвращает:
 *   -1 если a < b, 0 если равны, 1 если a > b.
 */
export function compareVersions(a: string, b: string): number {
    const norm = (v: string): number[] => {
        const cleaned = v.trim().replace(/^v/i, '').split('-')[0];
        return cleaned.split('.').map((p) => {
            const n = parseInt(p, 10);
            return Number.isFinite(n) ? n : 0;
        });
    };

    const pa = norm(a);
    const pb = norm(b);
    const len = Math.max(pa.length, pb.length);
    for (let i = 0; i < len; i++) {
        const ai = pa[i] ?? 0;
        const bi = pb[i] ?? 0;
        if (ai < bi) return -1;
        if (ai > bi) return 1;
    }
    return 0;
}

/**
 * Запрашивает последний релиз из GitHub и сравнивает с текущей версией приложения.
 * При сетевой ошибке возвращает результат с `error` — вызывающий код решает, как
 * показать пользователю.
 */
export function checkForUpdates(): Promise<UpdateCheckResult> {
    const currentVersion = app.getVersion();

    return new Promise((resolve) => {
        const req = https.get(
            RELEASES_URL,
            {
                headers: {
                    'User-Agent': `CloudSnap/${currentVersion}`,
                    'Accept': 'application/vnd.github+json'
                }
            },
            (res) => {
                if (!res.statusCode || res.statusCode < 200 || res.statusCode >= 300) {
                    res.resume();
                    resolve({
                        hasUpdate: false,
                        currentVersion,
                        latestVersion: currentVersion,
                        releaseUrl: RELEASE_PAGE_URL,
                        error: `HTTP ${res.statusCode}`
                    });
                    return;
                }

                let raw = '';
                res.setEncoding('utf8');
                res.on('data', (chunk: string) => { raw += chunk; });
                res.on('end', () => {
                    try {
                        const data = JSON.parse(raw) as {
                            tag_name?: string;
                            html_url?: string;
                            message?: string;
                        };
                        const latestVersion = (data.tag_name ?? '').replace(/^v/i, '');
                        if (!latestVersion) {
                            resolve({
                                hasUpdate: false,
                                currentVersion,
                                latestVersion: currentVersion,
                                releaseUrl: data.html_url || RELEASE_PAGE_URL,
                                error: data.message || 'Пустой ответ GitHub'
                            });
                            return;
                        }

                        const cmp = compareVersions(currentVersion, latestVersion);
                        resolve({
                            hasUpdate: cmp < 0,
                            currentVersion,
                            latestVersion,
                            releaseUrl: data.html_url || RELEASE_PAGE_URL,
                            ...(cmp < 0 ? {} : { error: undefined as unknown as string })
                        });
                    } catch (e) {
                        resolve({
                            hasUpdate: false,
                            currentVersion,
                            latestVersion: currentVersion,
                            releaseUrl: RELEASE_PAGE_URL,
                            error: `Не удалось разобрать ответ: ${(e as Error).message}`
                        });
                    }
                });
            }
        );

        req.on('error', (err) => {
            resolve({
                hasUpdate: false,
                currentVersion,
                latestVersion: currentVersion,
                releaseUrl: RELEASE_PAGE_URL,
                error: err.message
            });
        });

        req.setTimeout(REQUEST_TIMEOUT_MS, () => {
            req.destroy(new Error('Таймаут запроса'));
        });
    });
}