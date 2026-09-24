/**
 * Захват указателя и движение мыши — одно место на весь проект.
 *
 * Мышь тут не курсор, а ПОЛОЖЕНИЕ: за рулём это руль, пешком это взгляд.
 * Оба обязаны одинаково обходить две ловушки браузера: сразу после захвата
 * приходят огромные отсчёты (курсор прыгает в середину окна), а захват
 * теряется в любой миг — нажали Escape, переключили окно.
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

/**
 * Сколько миллисекунд после захвата движение не считается.
 *
 * Прыжок курсора браузер присылает не «одним первым событием»: на GitHub
 * (24.09) руль после захвата оказывался в упоре в одном прогоне из трёх,
 * хотя первое событие выбрасывалось. Прыжок приходит одним или несколькими
 * событиями, до `pointerlockchange` или после — ни число, ни порядок
 * не гарантированы. Окно по времени не зависит ни от того, ни от другого,
 * а игрок за 150 мс после щелчка рулить ещё не начал.
 */
const ТИШИНА = 150;

export function createAim(surface: HTMLElement): Aim {
  const moved: ((dx: number, dy: number) => void)[] = [];
  const taken: (() => void)[] = [];
  /**
   * Когда захват начался. Замечает его тот, кто узнал первым: событие
   * движения или событие захвата, — поэтому порядок их прихода не важен.
   */
  let захвачен = false;
  let с = -Infinity;
  const заметить = (когда: number): void => {
    if (held() && !захвачен) с = когда;
    захвачен = held();
  };

  const held = (): boolean => document.pointerLockElement === surface;

  const move = (event: MouseEvent): void => {
    заметить(event.timeStamp);
    if (!захвачен || event.timeStamp - с < ТИШИНА) return;
    for (const handler of moved) handler(event.movementX, event.movementY);
  };

  const changed = (): void => {
    заметить(performance.now());
    if (захвачен) for (const handler of taken) handler();
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
