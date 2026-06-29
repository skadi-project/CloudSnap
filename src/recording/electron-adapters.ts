/**
 * Реализации DI-интерфейсов на основе настоящего electron.
 *
 * Используются по умолчанию в RecordingManager, если явно не переданы
 * другие. Изолируют RecordingManager от прямого `import * from 'electron'`
 * и позволяют тестам подменять зависимости.
 *
 * Импорт electron сюда (а не в recording-manager.ts) — намеренный.
 * Благодаря этому unit-тесты могут импортировать RecordingManager и
 * types без electron в графе зависимостей.
 */

import {
    BrowserWindow as ElectronBrowserWindow,
    Notification as ElectronNotification,
    screen as ElectronScreen,
    Rectangle
} from 'electron';

import {
    INotifier,
    IDisplaySource,
    IBrowserWindowFactory,
    IRecorderWindow,
    IWebContents,
    BrowserWindowCreateOptions,
    DisplayDescriptor
} from './types';

/**
 * Адаптер для системных уведомлений. Notification.show() возвращает
 * Promise — мы его не ждём (fire-and-forget), как и оригинальный код.
 */
export class ElectronNotifier implements INotifier {
    notify(title: string, body: string): void {
        new ElectronNotification({ title, body }).show();
    }
}

/** Преобразует electron.Display в наш минимальный DisplayDescriptor. */
function toDescriptor(display: { id: number; bounds: Rectangle }): DisplayDescriptor {
    return {
        id: display.id,
        bounds: {
            x: display.bounds.x,
            y: display.bounds.y,
            width: display.bounds.width,
            height: display.bounds.height
        }
    };
}

/**
 * Адаптер для electron.screen. Возвращает минимальные дескрипторы —
 * RecordingManager'у нужны только id и bounds для размещения окна.
 */
export class ElectronDisplaySource implements IDisplaySource {
    getAllDisplays(): DisplayDescriptor[] {
        return ElectronScreen.getAllDisplays().map(toDescriptor);
    }

    getPrimaryDisplay(): DisplayDescriptor {
        return toDescriptor(ElectronScreen.getPrimaryDisplay());
    }
}

/**
 * Адаптер для одного BrowserWindow. Содержит ссылку на реальное окно
 * и делегирует каждый метод. При destroy()/close() ссылка становится
 * невалидной — это нормально: RecordingManager после этих вызовов
 * устанавливает соответствующее поле в null и больше не обращается.
 */
class BrowserWindowAdapter implements IRecorderWindow {
    private readonly win: ElectronBrowserWindow;

    constructor(win: ElectronBrowserWindow) {
        this.win = win;
    }

    loadFile(filePath: string): Promise<void> {
        return this.win.loadFile(filePath);
    }

    close(): void {
        this.win.close();
    }

    destroy(): void {
        this.win.destroy();
    }

    isDestroyed(): boolean {
        return this.win.isDestroyed();
    }

    setIgnoreMouseEvents(ignore: boolean, options?: { forward?: boolean }): void {
        this.win.setIgnoreMouseEvents(ignore, options);
    }

    setBackgroundThrottling(allow: boolean): void {
        // setBackgroundThrottling живёт на webContents, а не на BrowserWindow.
        // В IRecorderWindow экспонируем его на уровне окна — RecordingManager
        // не должен знать про webContents для тривиального «не глушить
        // MediaRecorder, когда окно в фоне».
        this.win.webContents.setBackgroundThrottling(allow);
    }

    on(event: 'did-finish-load' | 'closed', listener: () => void): void {
        // У Electron много перегрузок BrowserWindow.on(), и TS выбирает
        // самую строгую из подходящих. Наша сигнатура (event: 'closed' |
        // 'did-finish-load', listener: () => void) совпадает с несколькими,
        // и при этом самая поздняя перегрузка требует 'will-resize'.
        // cast необходим, чтобы обойти несовместимость перегрузок.
        (this.win.on as (e: string, l: () => void) => void)(event, listener);
    }

    get webContents(): IWebContents {
        const wc = this.win.webContents;
        return {
            send(channel: string, ...args: unknown[]): void {
                wc.send(channel, ...args);
            },
            on(event: 'did-finish-load', listener: () => void): void {
                wc.on(event, listener);
            }
        };
    }
}

/**
 * Фабрика BrowserWindow'ов на основе electron. Передаёт опции как есть —
 * за валидацию отвечает сам electron при создании окна. В тестах эта
 * фабрика заменяется на fake-фабрику, которая не делает ничего.
 */
export class ElectronBrowserWindowFactory implements IBrowserWindowFactory {
    create(opts: BrowserWindowCreateOptions): IRecorderWindow {
        return new BrowserWindowAdapter(
            new ElectronBrowserWindow(opts as Electron.BrowserWindowConstructorOptions)
        );
    }
}

/**
 * Оборачивает уже существующий BrowserWindow (например, главное окно,
 * созданное в src/main/index.ts до RecordingManager) в IRecorderWindow.
 * Используется в src/main/index.ts при вызове recordingManager.setMainWindow().
 */
export function wrapBrowserWindow(win: ElectronBrowserWindow): IRecorderWindow {
    return new BrowserWindowAdapter(win);
}