/**
 * Захват указателя и движение мыши — одно место на весь проект.
 *
 * Мышь тут не курсор, а ПОЛОЖЕНИЕ: за рулём это руль, пешком это взгляд.
 * Оба обязаны одинаково обходить две ловушки браузера: первый отсчёт после
 * захвата бывает огромным (курсор прыгает в середину окна), а захват теряется
 * в любой миг — нажали Escape, переключили окно.
 *
 * **Движение отдаётся СОБЫТИЕМ, а не суммой за кадр.** Разница не косметическая:
 * под захватом браузер присылает движения скачками вперёд-назад, и сумма за кадр
 * взаимно уничтожается, а последовательное применение каждого события — нет.
 * Первая редакция суммировала за кадр, и руль перестал слушаться мыши; поймала
 * это браузерная проверка `npm run ride`.
 */

export interface Aim {
  /** Взять мышь: она перестаёт быть курсором и становится положением. */
  take(): void;
  /** Отдать мышь: снова курсор, снова можно попасть по кнопкам. */
  give(): void;
  /** Мышь сейчас у нас? */
  held(): boolean;
  /** Подписаться на движение. Приходит только пока мышь захвачена. */
  onMove(handler: (dx: number, dy: number) => void): void;
  /** Позвать, когда мышь взяли: руль ставится в ноль именно здесь. */
  onTake(handler: () => void): void;
  detach(): void;
}

export function createAim(surface: HTMLElement): Aim {
  const moved: ((dx: number, dy: number) => void)[] = [];
  const taken: (() => void)[] = [];
  /** Первый отсчёт после захвата врёт: курсор прыгает в середину экрана. */
  let skipNext = false;

  const held = (): boolean => document.pointerLockElement === surface;

  const move = (event: MouseEvent): void => {
    if (!held()) return;
    if (skipNext) { skipNext = false; return; }
    for (const handler of moved) handler(event.movementX, event.movementY);
  };

  const changed = (): void => {
    skipNext = true;
    if (held()) for (const handler of taken) handler();
  };

  addEventListener('mousemove', move);
  document.addEventListener('pointerlockchange', changed);

  return {
    take(): void { if (!held()) surface.requestPointerLock(); },
    give(): void { if (held()) document.exitPointerLock(); },
    held,
    onMove(handler): void { moved.push(handler); },
    onTake(handler): void { taken.push(handler); },
    detach(): void {
      removeEventListener('mousemove', move);
      document.removeEventListener('pointerlockchange', changed);
      moved.length = 0;
      taken.length = 0;
      if (held()) document.exitPointerLock();
    },
  };
}
