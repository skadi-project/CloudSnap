// Monitor picker renderer — populates a grid of display cards and wires up clicks.
// CSP: no inline scripts/styles allowed.

const grid = document.getElementById('grid');
const subtitle = document.getElementById('subtitle');
const cancelBtn = document.getElementById('cancelBtn');

const MODE_LABELS = {
    capture: 'снимка экрана',
    'record-fullscreen': 'записи всего экрана',
    'record-area': 'записи области'
};

window.electronAPI.onDisplaysList((data) => {
    subtitle.textContent = `Кликните на экран для ${MODE_LABELS[data.mode] || 'захвата'}`;
    grid.innerHTML = '';

    for (const d of data.displays) {
        const card = document.createElement('div');
        card.className = 'monitor-card' + (d.isPrimary ? ' primary' : '');
        card.innerHTML = `
            <div class="thumb-wrap">
                ${d.thumbnail
                    ? `<img src="${d.thumbnail}" alt="">`
                    : '<div class="thumb-placeholder">🖥</div>'}
            </div>
            <div class="monitor-info">
                <div class="monitor-name">${d.label}</div>
                <div class="monitor-size">${Math.round(d.bounds.width * (d.scaleFactor || 1))} × ${Math.round(d.bounds.height * (d.scaleFactor || 1))}</div>
            </div>
        `;
        card.addEventListener('click', () => {
            window.electronAPI.selectMonitor(d.id);
        });
        grid.appendChild(card);
    }
});

cancelBtn.addEventListener('click', () => window.electronAPI.cancelMonitorPicker());

document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') window.electronAPI.cancelMonitorPicker();
});