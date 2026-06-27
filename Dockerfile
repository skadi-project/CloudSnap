# CloudSnap — единый Docker-контейнер для сборки под обе платформы
#
# Windows:  NSIS-инсталлер (.exe) через wine + electron-builder
# macOS:    unsigned .zip (.app bundle) через electron-builder --mac zip
#
# Запуск:
#   docker compose run --rm -v ./dist/output:/output cloudsnap        # обе платформы
#   docker compose run --rm -v ./dist/output:/output cloudsnap win     # только .exe
#   docker compose run --rm -v ./dist/output:/output cloudsnap mac     # только macOS .zip

FROM node:20-bookworm

# Wine + Xvfb + xauth + все зависимости для кросс-сборки Windows
RUN dpkg --add-architecture i386 && \
    apt-get update && \
    apt-get install -y --no-install-recommends \
        wine64 wine32 xvfb xauth \
        wine-binfmt \
        fonts-liberation \
        ca-certificates git curl && \
    apt-get clean && rm -rf /var/lib/apt/lists/*

# Инициализация wine prefix — electron-builder требует рабочий wine environment
# Запускаем Xvfb вручную (не xvfb-run — он требует xauth которого нет в slim)
RUN Xvfb :99 -screen 0 1024x768x24 -ac & \
    sleep 2 && \
    DISPLAY=:99 wineboot --init && \
    wineserver -w && \
    kill $(cat /tmp/.X99-lock) 2>/dev/null || true && \
    rm -rf ~/.wine/drive_c/users/*/Temp

WORKDIR /app

# Layer caching: package.json → npm ci → остальное
COPY package.json package-lock.json ./
RUN npm ci

COPY tsconfig.json ./
COPY main.ts preload.ts ./
COPY src/ ./src/
COPY icon.ico icon.icns tray-icon.png tray-icon-mac.png ./
COPY entitlements.mac.plist ./

# Компиляция TypeScript
RUN npx tsc

# Сборочный скрипт
COPY build-all.sh /usr/local/bin/build-all.sh
RUN chmod +x /usr/local/bin/build-all.sh

ENV DISPLAY=:99
ENV WINEDEBUG=-all
ENV WINEPREFIX=/root/.wine
ENV ELECTRON_BUILDER_ALLOW_UNRESOLVED_DEPENDENCIES=true

VOLUME ["/output"]

ENTRYPOINT ["/usr/local/bin/build-all.sh"]
CMD ["all"]
