/**
 * Интерфейсы для dependency injection RecordingManager.
 *
 * RecordingManager исторически напрямую дёргал electron.Notification,
 * electron.screen и создавал BrowserWindow через `new`. Это делало
 * невозможным юнит-тестирование без мока electron и привязывало
 * state machine к UI.
 *
 * Этот файл выделяет минимальный контракт, который RecordingManager
 * реально использует. Конкретные реализации (на основе реального
 * electron) лежат в ./electron-adapters.ts.
 *
 * Принципы:
 * - Поверхность минимальна: только методы, которые вызывает RecordingManager.
 * - Никаких `any` в интерфейсах — тесты должны иметь возможность писать
 *   строгие моки без unsafe-кастов.
 * - Не пытаемся абстрагировать «весь electron» — это другая задача и
 *   сейчас не нужна.
 */

/**
 * Показывает пользователю короткое системное сообщение.
 * Заменяет `new Notification({title, body}).show()`.
 */
export interface INotifier {
    notify(title: string, body: string): void;
}

/**
 * Минимальное описание дисплея, которое RecordingManager использует
 * для размещения indicator window. Не зависит от типа
 * electron.Display, чтобы тесты могли строить fake-дисплеи без моков.
 */
export interface DisplayDescriptor {
    id: number;
    bounds: { x: number; y: number; width: number; height: number };
}

/**
 * Источник информации о дисплеях. Заменяет electron.screen.
 * RecordingManager вызывает два метода:
 *   - getAllDisplays() — для поиска активного дисплея по id
 *   - getPrimaryDisplay() — fallback, если активный дисплей не найден
 */
export interface IDisplaySource {
    getAllDisplays(): DisplayDescriptor[];
    getPrimaryDisplay(): DisplayDescriptor;
}

/** События webContents, на которые подписывается RecordingManager. */
export type WebContentsEvent = 'did-finish-load' | 'closed';

/**
 * Минимальная обёртка над webContents. Содержит только то, что
 * RecordingManager реально вызывает: send() для IPC и on() для
 * did-finish-load.
 */
export interface IWebContents {
    send(channel: string, ...args: unknown[]): void;
    on(event: 'did-finish-load', listener: () => void): void;
}

/**
 * Минимальная абстракция над BrowserWindow. Включает только методы,
 * которые вызывает RecordingManager:
 *   - loadFile/close/destroy/isDestroyed для управления окнами
 *   - setIgnoreMouseEvents для boundary
 *   - setBackgroundThrottling для recorder (MediaRecorder должен
 *     продолжать писать, когда окно свёрнуто)
 *   - on('closed' | 'did-finish-load') для cleanup-логики
 *   - webContents для IPC в renderer
 */
export interface IRecorderWindow {
    loadFile(path: string): Promise<void>;
    close(): void;
    destroy(): void;
    isDestroyed(): boolean;
    setIgnoreMouseEvents(ignore: boolean, options?: { forward?: boolean }): void;
    setBackgroundThrottling(allow: boolean): void;
    on(event: WebContentsEvent, listener: () => void): void;
    webContents: IWebContents;
}

/**
 * Опции для создания окна. Структура совпадает с
 * electron.BrowserWindowConstructorOptions — но мы не хотим
 * наследовать тип electron.BrowserWindow, чтобы интерфейс был
 * тестируемым без electron. Используем intersection типа с
 * electron.BrowserWindowConstructorOptions в electron-adapters.ts.
 */
export interface BrowserWindowCreateOptions {
    [key: string]: unknown;
}

/**
 * Фабрика окон. Заменяет `new BrowserWindow(opts)` в RecordingManager.
 * Позволяет тестам инжектить fake-фабрику, которая возвращает
 * IRecorderWindow без реального electron.
 */
export interface IBrowserWindowFactory {
    create(opts: BrowserWindowCreateOptions): IRecorderWindow;
}

/**
 * Полный набор зависимостей RecordingManager. Передаётся вторым
 * аргументом конструктора; если не передан — используются
 * реализации по умолчанию на основе electron.
 */
export interface RecordingManagerDeps {
    notifier?: INotifier;
    displaySource?: IDisplaySource;
    windowFactory?: IBrowserWindowFactory;
}