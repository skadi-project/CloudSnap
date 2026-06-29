/**
 * Окно «О программе»: проверка обновлений и оформление ссылок.
 *
 * Фетчит https://api.github.com/repos/skadi-project/CloudSnap/releases/latest
 * прямо из рендерера (CORS разрешён для неаутентифицированных запросов к публичному
 * API). Результат сравнивается с версией, выведенной из <span id="current-version">,
 * и показывается в <span id="update-status">. Повторная проверка — кнопкой ↻.
 */
(function () {
    'use strict';

    const REPO = 'skadi-project/CloudSnap';
    const RELEASES_URL = 'https://api.github.com/repos/' + REPO + '/releases/latest';
    const RELEASE_PAGE_URL = 'https://github.com/' + REPO + '/releases/latest';

    const statusEl = document.getElementById('update-status');
    const recheckBtn = document.getElementById('update-recheck');
    const versionEl = document.getElementById('current-version');

    if (!statusEl || !versionEl) return;

    function getCurrentVersion() {
        const v = (versionEl.textContent || '').trim();
        const m = v.match(/\d+\.\d+\.\d+/);
        return m ? m[0] : '0.0.0';
    }

    function compareVersions(a, b) {
        const norm = (v) => v.trim().replace(/^v/i, '').split('-')[0]
            .split('.').map((p) => {
                const n = parseInt(p, 10);
                return Number.isFinite(n) ? n : 0;
            });
        const pa = norm(a), pb = norm(b);
        const len = Math.max(pa.length, pb.length);
        for (let i = 0; i < len; i++) {
            const ai = pa[i] || 0, bi = pb[i] || 0;
            if (ai < bi) return -1;
            if (ai > bi) return 1;
        }
        return 0;
    }

    function setStatus(text, cls) {
        statusEl.textContent = text;
        statusEl.className = 'update-status ' + (cls || '');
        if (cls === 'available') {
            statusEl.dataset.url = statusEl.dataset.url || RELEASE_PAGE_URL;
        } else {
            delete statusEl.dataset.url;
        }
    }

    async function check() {
        if (recheckBtn) recheckBtn.disabled = true;
        setStatus('проверка…', 'checking');
        try {
            const res = await fetch(RELEASES_URL, {
                headers: { 'Accept': 'application/vnd.github+json' }
            });
            if (!res.ok) throw new Error('HTTP ' + res.status);
            const data = await res.json();
            const latest = (data.tag_name || '').replace(/^v/i, '');
            if (!latest) {
                setStatus('нет данных о релизах', 'error');
                return;
            }
            const pageUrl = data.html_url || RELEASE_PAGE_URL;
            if (compareVersions(getCurrentVersion(), latest) < 0) {
                setStatus('доступно ' + latest + ' — открыть', 'available');
                statusEl.dataset.url = pageUrl;
            } else {
                setStatus('актуальная (' + getCurrentVersion() + ')', 'ok');
            }
        } catch (e) {
            setStatus('не удалось проверить (' + (e && e.message ? e.message : 'ошибка') + ')', 'error');
        } finally {
            if (recheckBtn) recheckBtn.disabled = false;
        }
    }

    statusEl.addEventListener('click', () => {
        const url = statusEl.dataset.url;
        if (url) {
            window.open(url, '_blank');
        } else {
            check();
        }
    });

    if (recheckBtn) recheckBtn.addEventListener('click', check);

    check();
})();
