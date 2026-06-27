# CloudSnap — Makefile 

.PHONY: all dev build build-win build-mac build-local-win build-local-mac clean clean-docker help

all: help

# ===================== Разработка =====================

dev:              ## Запуск приложения (tsc + electron .)
	npx tsc && npx electron .

watch:            ## TypeScript watch-режим
	npx tsc -w

# ===================== Контейнерная сборка (один Dockerfile) =====================

build:            ## Собрать обе платформы через Docker (all)
	docker compose run --rm -v ./dist/output:/output cloudsnap all

build-win:        ## Собрать .exe через Docker (win)
	docker compose run --rm -v ./dist/output:/output cloudsnap win

build-mac:        ## Собрать macOS .zip через Docker (mac)
	docker compose run --rm -v ./dist/output:/output cloudsnap mac

# ===================== Локальная сборка =====================

build-local-win:  ## Собрать .exe на Windows-машине
	npx tsc && npx electron-builder --win

build-local-mac:  ## Собрать signed .dmg на Mac-машине
	npx tsc && npx electron-builder --mac

# ===================== Очистка =====================

clean:            ## Удалить dist/ + скомпилированные .js
	rm -rf dist dist/output
	rm -f main.js preload.js
	rm -f src/*.js

clean-docker:     ## Удалить Docker-образы
	docker compose down --rmi all

# ===================== Справка =====================

help:             ## Показать список команд
	@echo "CloudSnap — команды:"
	@echo ""
	@echo "  dev              — Запуск (tsc + electron .)"
	@echo "  watch            — TypeScript watch"
	@echo ""
	@echo "  build            — Docker: обе платформы (.exe + macOS .zip)"
	@echo "  build-win        — Docker: только Windows .exe"
	@echo "  build-mac        — Docker: только macOS .zip (unsigned)"
	@echo ""
	@echo "  build-local-win  — Локально: .exe на Windows"
	@echo "  build-local-mac  — Локально: signed .dmg на Mac"
	@echo ""
	@echo "  clean            — Удалить dist/ и .js"
	@echo "  clean-docker     — Удалить Docker-образы"
