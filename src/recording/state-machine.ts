/**
 * State machine для RecordingManager.
 *
 * Раньше переходы между состояниями были разбросаны по 10+ методам
 * (startFullscreen, pause, stop, _emergencyStop, …) с inline
 * `this.state = 'recording'`. Легко было пропустить edge case:
 *   - startFullscreen → state=recording через did-finish-load (race window)
 *   - pause() check `state !== 'recording'` отбрасывал паузу в этом окне
 *   - cleanup() вызывался из processRecordingData() — но если finishRecording
 *     приходил между pause и resume, state мог остаться в 'paused'
 *
 * Теперь все переходы — в одной таблице. Каждый переход атомарен через
 * `transition()` с явной проверкой. Невалидный переход бросает
 * InvalidTransitionError (для тестов + логирования).
 *
 * Таблица переходов (from → event → to):
 *
 *   idle ──START_FULLSCREEN──→ recording
 *   idle ──START_AREA_SELECTION──→ selecting
 *   idle ──FORCE_STOP──→ idle
 *
 *   selecting ──CONFIRM_AREA──→ recording
 *   selecting ──CANCEL_AREA_SELECTION──→ idle
 *   selecting ──FORCE_STOP──→ idle
 *
 *   recording ──PAUSE──→ paused
 *   recording ──STOP──→ stopping
 *   recording ──FORCE_STOP──→ idle
 *   recording ──EMERGENCY_STOP──→ idle
 *
 *   paused ──RESUME──→ recording
 *   paused ──STOP──→ stopping
 *   paused ──FORCE_STOP──→ idle
 *   paused ──EMERGENCY_STOP──→ idle
 *
 *   stopping ──CLEANUP──→ idle
 *   stopping ──FORCE_STOP──→ idle
 *
 * NOTE: START_FULLSCREEN и CONFIRM_AREA переводят сразу в 'recording' (а не в
 * новое 'starting' состояние). Это упрощает модель: после успешного
 * `_createRecorderAndOverlay()` мы гарантируем, что state='recording', даже
 * если окно ещё не загрузилось. Защита от pause/resume в этом окне
 * достигается тем, что MediaRecorder в renderer'е стартует только после
 * init-recording IPC (отправляется из did-finish-load обработчика, когда
 * state уже 'recording').
 */

export type RecordingState = 'idle' | 'selecting' | 'recording' | 'paused' | 'stopping';

/** Допустимые события state machine. */
export type RecordingEventType =
    | 'START_FULLSCREEN'
    | 'START_AREA_SELECTION'
    | 'CONFIRM_AREA'
    | 'CANCEL_AREA_SELECTION'
    | 'PAUSE'
    | 'RESUME'
    | 'STOP'
    | 'CLEANUP'
    | 'FORCE_STOP'
    | 'EMERGENCY_STOP';

/** Структура события для логирования/тестов. */
export interface RecordingEvent {
    type: RecordingEventType;
    /** Дополнительные поля для контекста (причина emergency stop, и т.п.). */
    reason?: string;
}

/** Бросается при попытке выполнить недопустимый переход. */
export class InvalidTransitionError extends Error {
    constructor(
        public readonly from: RecordingState,
        public readonly event: RecordingEvent
    ) {
        super(`Invalid transition: ${event.type} from state '${from}'${event.reason ? ` (${event.reason})` : ''}`);
        this.name = 'InvalidTransitionError';
    }
}

/**
 * Таблица переходов. Ключ — текущее состояние, значение — карта
 * (event.type → следующее состояние). Отсутствие перехода означает,
 * что событие в этом состоянии игнорируется (см. {@link canTransition}).
 */
const TRANSITIONS: Record<RecordingState, Partial<Record<RecordingEventType, RecordingState>>> = {
    idle: {
        START_FULLSCREEN: 'recording',
        START_AREA_SELECTION: 'selecting',
        FORCE_STOP: 'idle'
    },
    selecting: {
        CONFIRM_AREA: 'recording',
        CANCEL_AREA_SELECTION: 'idle',
        FORCE_STOP: 'idle'
    },
    recording: {
        PAUSE: 'paused',
        STOP: 'stopping',
        FORCE_STOP: 'idle',
        EMERGENCY_STOP: 'idle'
    },
    paused: {
        RESUME: 'recording',
        STOP: 'stopping',
        FORCE_STOP: 'idle',
        EMERGENCY_STOP: 'idle'
    },
    stopping: {
        CLEANUP: 'idle',
        FORCE_STOP: 'idle'
    }
};

/**
 * Возвращает true, если переход из `from` по событию `type` допустим.
 * Используется для guard-условий (например, чтобы не падать в
 * обработчике IPC, когда событие пришло в неподходящем состоянии).
 */
export function canTransition(from: RecordingState, type: RecordingEventType): boolean {
    return TRANSITIONS[from][type] !== undefined;
}

/**
 * Возвращает true, если состояние `from` "терминальное" в смысле
 * state machine — из него нельзя выйти нормальными переходами.
 * Сейчас таких нет (все имеют FORCE_STOP), но интерфейс зарезервирован.
 */
export function isTerminal(state: RecordingState): boolean {
    return Object.keys(TRANSITIONS[state]).length === 0;
}

/**
 * Выполняет переход из `from` по событию. Бросает InvalidTransitionError,
 * если переход недопустим. Возвращает новое состояние.
 */
export function transition(from: RecordingState, event: RecordingEvent): RecordingState {
    const to = TRANSITIONS[from][event.type];
    if (to === undefined) {
        throw new InvalidTransitionError(from, event);
    }
    return to;
}

/**
 * Безопасная версия transition — возвращает null вместо броска исключения.
 * Используется в hot paths (обработчики IPC), где невалидный переход —
 * штатная ситуация (например, повторный pause после stop).
 */
export function tryTransition(from: RecordingState, event: RecordingEvent): RecordingState | null {
    const to = TRANSITIONS[from][event.type];
    return to ?? null;
}

/**
 * Возвращает список допустимых событий из данного состояния.
 * Полезно для документации, логирования и тестов.
 */
export function allowedEventsFrom(state: RecordingState): RecordingEventType[] {
    return Object.keys(TRANSITIONS[state]) as RecordingEventType[];
}