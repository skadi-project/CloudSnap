#!/bin/bash
# CloudSnap — единый сборочный скрипт для Windows + macOS
# Entrypoint Docker-контейнера
#
# Аргументы: all | win | mac
#   all — собрать обе платформы
#   win — только NSIS .exe
#   mac — только unsigned .zip для macOS

set -euo pipefail

TARGET="${1:-all}"

echo "========================================"
echo "  CloudSnap Builder"
echo "  Target: ${TARGET}"
echo "========================================"

# Запуск Xvfb (wine + electron-builder требует GUI)
Xvfb :99 -screen 0 1024x768x24 -ac &
sleep 2

# Проверка wine
echo "[0] Verifying wine environment..."
wineboot --update || true
wineserver -w || true
echo "wine prefix: ${WINEPREFIX:-/root/.wine}"

# Компиляция TypeScript (на всякий случай — может уже скомпилировано)
echo "[1] Compiling TypeScript..."
npx tsc

mkdir -p /output

# ===================== Windows NSIS =====================
if [ "$TARGET" = "all" ] || [ "$TARGET" = "win" ]; then
    echo ""
    echo "[2] Building Windows installer (NSIS)..."

    # electron-builder использует app-builder-bin через wine
    # wineboot уже инициализирован в Dockerfile, но обновляем на всякий случай
    DISPLAY=:99 npx electron-builder --win --x64

    echo "Copying Windows artifacts..."
    cp -v dist/*.exe /output/ 2>/dev/null || true
    cp -v dist/*.blockmap /output/ 2>/dev/null || true
fi

# ===================== macOS unsigned .zip =====================
if [ "$TARGET" = "all" ] || [ "$TARGET" = "mac" ]; then
    echo ""
    echo "[3] Building macOS unsigned .zip..."
    # electron-builder --mac zip создаёт .zip с .app bundle внутри
    # Code signing / DMG невозможны в Linux — нужна macOS-машина
    # Для production: используйте GitHub Actions (macos-latest runner)
    DISPLAY=:99 npx electron-builder --mac zip --x64

    echo "Copying macOS artifacts..."
    cp -v dist/*.zip /output/ 2>/dev/null || true
    cp -v dist/mac/*.zip /output/ 2>/dev/null || true
fi

echo ""
echo "========================================"
echo "  Build complete!"
echo "  Artifacts in /output:"
echo "========================================"
ls -lh /output/
