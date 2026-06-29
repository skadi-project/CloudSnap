# Recording — state machine

State machine для `RecordingManager`. Изолирует переходы между
состояниями записи в одной таблице, устраняя разбросанные inline
присваивания `this.state = 'recording'`.

## Файлы

| Файл | Назначение |
|------|------------|
| `state-machine.ts` | Таблица переходов, `transition()`, `tryTransition()`, `canTransition()` |
| `recording-manager.ts` | Окна, таймер, IPC; использует `state-machine.ts` для всех переходов |

## Состояния

```
   ┌────────┐  START_FULLSCREEN    ┌────────────┐
   │  idle  │ ───────────────────→ │ recording  │
   └───┬────┘  START_AREA_SELECTION└──────┬─────┘
       │  ↖                              │ ↑ ↓ PAUSE / RESUME
       │   │                             │ ↓
       │   │                  CONFIRM_AREA
       │   │   ┌─────────────┐
       │   └── │  selecting  │
       │       └──────┬──────┘
       │              │ CANCEL_AREA_SELECTION
       │              │
       │  CLEANUP /   ↓
       │  FORCE_STOP  ┌────────────┐
       │  ⤺───────────│  stopping  │
       │              └────────────┘
       │
       │  EMERGENCY_STOP ───────────────→ idle
       │  FORCE_STOP ──────────────────→ idle
       ↓
   (idle)
```

## Таблица переходов

| From | Event | To |
|------|-------|-----|
| `idle` | `START_FULLSCREEN` | `recording` |
| `idle` | `START_AREA_SELECTION` | `selecting` |
| `idle` | `FORCE_STOP` | `idle` |
| `selecting` | `CONFIRM_AREA` | `recording` |
| `selecting` | `CANCEL_AREA_SELECTION` | `idle` |
| `selecting` | `FORCE_STOP` | `idle` |
| `recording` | `PAUSE` | `paused` |
| `recording` | `STOP` | `stopping` |
| `recording` | `FORCE_STOP` | `idle` |
| `recording` | `EMERGENCY_STOP` | `idle` |
| `paused` | `RESUME` | `recording` |
| `paused` | `STOP` | `stopping` |
| `paused` | `FORCE_STOP` | `idle` |
| `paused` | `EMERGENCY_STOP` | `idle` |
| `stopping` | `CLEANUP` | `idle` |
| `stopping` | `FORCE_STOP` | `idle` |

## Side-effects по переходам

Side-effects (закрытие окон, IPC, notifications, таймеры) делает
**RecordingManager**, а не state machine. State machine только
валидирует переход. Это разделение позволяет тестировать таблицу
переходов без поднятия Electron.

| Переход | Side-effect |
|---------|-------------|
| `idle → recording` (START_FULLSCREEN) | создать recorderWindow + indicatorWindow, запустить таймер, уведомление "Запись видео начата" |
| `idle → selecting` (START_AREA_SELECTION) | создать selectorWindow, отправить screenshot-captured с thumbnail |
| `selecting → recording` (CONFIRM_AREA) | закрыть selectorWindow, создать recorderWindow + indicatorWindow + boundaryWindow, таймер |
| `selecting → idle` (CANCEL_AREA_SELECTION) | закрыть selectorWindow |
| `recording → paused` (PAUSE) | отправить pause-recording IPC, recording-paused overlay, уведомление |
| `paused → recording` (RESUME) | отправить resume-recording IPC, recording-resumed overlay |
| `recording\|paused → stopping` (STOP) | остановить таймер, отправить stop-recording IPC, закрыть indicator + boundary |
| `stopping → idle` (CLEANUP) | закрыть recorderWindow, сбросить activeDisplay / recordingArea |
| `* → idle` (FORCE_STOP) | уничтожить все окна (destroy), остановить таймер |
| `recording\|paused → idle` (EMERGENCY_STOP) | закрыть окна, уведомление "Запись остановлена: <reason>" |

## Использование

```ts
import { RecordingManager } from './recording-manager';
import { canTransition, allowedEventsFrom } from './state-machine';

const rm = new RecordingManager((state) => {
    console.log('state →', state);
});

rm.startFullscreen(display);  // idle → recording
rm.pause();                    // recording → paused
rm.resume();                   // paused → recording
rm.stop();                     // recording → stopping
rm.cleanup();                  // stopping → idle

// В тестах
if (canTransition('idle', 'START_FULLSCREEN')) { /* ... */ }
console.log(allowedEventsFrom('recording')); // ['PAUSE', 'STOP', 'FORCE_STOP', 'EMERGENCY_STOP']
```

## Дизайн-решения

1. **`START_FULLSCREEN` сразу переводит в `recording`**, не ждём
   `did-finish-load`. Упрощает модель: после успешного вызова
   `startFullscreen()` состояние гарантированно `'recording'`.
   Race condition с pause/resume до загрузки MediaRecorder —
   ответственность renderer'а (он сам решает, готов ли MediaRecorder).

2. **`cleanup()` гибкий**: из `stopping` — нормальный `CLEANUP`,
   из других состояний — fallback на `FORCE_STOP` (через warning).
   Это позволяет вызывать `cleanup()` без проверки состояния.

3. **Невалидные переходы не бросают исключение**, а логируют warning
   и оставляют state неизменным. Используется `tryTransition()` —
   штатный путь для IPC-handlers, где повторный pause после stop —
   нормальная ситуация, не ошибка.

4. **`FORCE_STOP` доступен из любого состояния** — для app quit
   нельзя падать, нужно остановить запись принудительно.

## Тесты (Phase 3.1)

Smoke-тесты для state-machine пишутся в Фазе 3.1 (vitest).
Без Electron можно протестировать:
- Все допустимые переходы возвращают правильный next state
- Все недопустимые переходы возвращают null (tryTransition) / бросают (transition)
- `allowedEventsFrom()` соответствует таблице
- `isTerminal()` корректно (для future-proof)

Пример:

```ts
import { tryTransition, canTransition, allowedEventsFrom } from './state-machine';
import { describe, it, expect } from 'vitest';

describe('recording state machine', () => {
    it('idle → recording on START_FULLSCREEN', () => {
        expect(tryTransition('idle', { type: 'START_FULLSCREEN' })).toBe('recording');
    });

    it('recording → paused on PAUSE', () => {
        expect(tryTransition('recording', { type: 'PAUSE' })).toBe('paused');
    });

    it('paused → recording on RESUME', () => {
        expect(tryTransition('paused', { type: 'RESUME' })).toBe('recording');
    });

    it('recording → idle on EMERGENCY_STOP', () => {
        expect(tryTransition('recording', { type: 'EMERGENCY_STOP' })).toBe('idle');
    });

    it('STOP is no-op from idle', () => {
        expect(tryTransition('idle', { type: 'STOP' })).toBe(null);
    });

    it('CLEANUP from recording forces via FORCE_STOP (logged warning)', () => {
        // Implementation in RecordingManager: cleanup from non-stopping → forceStop
        expect(tryTransition('recording', { type: 'CLEANUP' })).toBe(null);
        expect(tryTransition('recording', { type: 'FORCE_STOP' })).toBe('idle');
    });

    it('FORCE_STOP from any state → idle', () => {
        for (const state of ['idle', 'selecting', 'recording', 'paused', 'stopping'] as const) {
            expect(tryTransition(state, { type: 'FORCE_STOP' })).toBe('idle');
        }
    });
});
```