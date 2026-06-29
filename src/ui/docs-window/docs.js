// Docs window — only behavior is the close button (was inline onclick).

const closeBtn = document.getElementById('closeBtn');
if (closeBtn) {
    closeBtn.addEventListener('click', () => window.close());
}