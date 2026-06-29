// Recording overlay indicator — wires up timer updates and pause/stop buttons.

const recDot = document.getElementById('recDot');
const timer = document.getElementById('timer');
const pauseBtn = document.getElementById('pauseBtn');
const stopBtn = document.getElementById('stopBtn');

const ICON_PAUSE = '<svg class="ov-icon" viewBox="0 0 24 24" fill="currentColor"><rect x="6" y="4" width="4" height="16" rx="1"/><rect x="14" y="4" width="4" height="16" rx="1"/></svg>';
const ICON_PLAY = '<svg class="ov-icon" viewBox="0 0 24 24" fill="currentColor"><polygon points="6,3 20,12 6,21"/></svg>';

function formatTime(seconds) {
    const m = Math.floor(seconds / 60);
    const s = seconds % 60;
    return String(m).padStart(2, '0') + ':' + String(s).padStart(2, '0');
}

window.electronAPI.onRecordingStarted(() => {});

window.electronAPI.onRecordingTimerUpdate((seconds) => {
    timer.textContent = formatTime(seconds);
});

window.electronAPI.onRecordingPaused(() => {
    recDot.classList.add('paused');
    pauseBtn.innerHTML = ICON_PLAY;
});

window.electronAPI.onRecordingResumed(() => {
    recDot.classList.remove('paused');
    pauseBtn.innerHTML = ICON_PAUSE;
});

pauseBtn.addEventListener('click', async () => {
    await window.electronAPI.togglePauseRecording();
});

stopBtn.addEventListener('click', async () => {
    await window.electronAPI.stopRecording();
});