/**
 * Органы управления: мышь — руль, клавиши — педали.
 *
 * Сделано как в Assetto Corsa: **указатель захватывается**, и руль — это
 * накопленное движение мыши от нуля, поставленного в тот миг, когда сел
 * за руль. Захват нужен именно для нуля: пока указатель живёт своей жизнью,
 * «прямо» оказывается там, где он случайно был, — и середина экрана
 * становится упором. Ровно на этом первая версия и сломалась.
 *
 * Накопитель упирается в единицу и дальше не растёт — как настоящий руль
 * упирается в замок: крути сколько хочешь, ничего не изменится, а обратно
 * пойдёт сразу.
 *
 * Педали — на клавишах (так у всех троих: Assetto Corsa, Euro Truck, BeamNG),
 * и клавиша не включает газ, а начинает нажимать педаль: до пола 0.22 с.
 *
 * Помощь рулю (её считает сама машина, здесь только выключатель) — два
 * помощника, как в BeamNG: предел по сцеплению передних колёс и контрруль,
 * изображающий кастор.
 */

import type { Controls } from './car.ts';

/** Сколько пикселей мыши от нуля до упора руля. */
const TRAVEL_DEFAULT = 700;
/** Время хода педали до пола и обратно, с. */
const PRESS = 0.22;
const RELEASE = 0.14;

export interface Driver {
  read(dt: number): Controls;
  /** Помощь рулю: предел по сцеплению и контрруль. */
  assist: boolean;
  /** Пикселей мыши на полный выворот. Больше — спокойнее. */
  travel: number;
  /** Положение руля, заданное игроком, −1..1 — приборке. */
  command: number;
  /** Захвачен ли указатель. Без захвата рулить нечем. */
  held(): boolean;
  /** Поставить руль в ноль. */
  anchor(): void;
  /** Отпустить указатель: вышел из машины — мышь снова твоя. */
  release(): void;
  pad(): boolean;
  detach(): void;
}

const clamp = (v: number, lo: number, hi: number): number => (v < lo ? lo : v > hi ? hi : v);

/** Педаль догоняет клавишу со скоростью ноги, а не мгновенно. */
function pedal(now: number, want: number, dt: number): number {
  const rate = want > now ? dt / PRESS : dt / RELEASE;
  return clamp(now + clamp(want - now, -rate, rate), 0, 1);
}

export function createDriver(surface: HTMLElement): Driver {
  const keys = new Set<string>();
  let wheel = 0;   // −1..1, накопленное положение руля
  /**
   * Захватывая указатель, браузер сам переносит курсор в середину окна
   * и присылает это как одно огромное движение мыши. Если его засчитать,
   * руль в тот же миг оказывается в упоре — машина уезжает в поле, хотя
   * игрок мыши не касался. Первое движение после захвата выбрасываем.
   */
  let ignoreNext = false;
  let throttle = 0, brake = 0, keySteer = 0;

  const down = (e: KeyboardEvent): void => {
    keys.add(e.code);
    if (e.code === 'Space' || e.code.startsWith('Arrow')) e.preventDefault();
    // острота руля: сколько миллиметров коврика уходит на полный выворот
    if (e.code === 'BracketLeft') driver.travel = clamp(driver.travel + 100, 200, 1600);
    if (e.code === 'BracketRight') driver.travel = clamp(driver.travel - 100, 200, 1600);
    if (e.code === 'KeyR') wheel = 0;
  };
  const up = (e: KeyboardEvent): void => { keys.delete(e.code); };
  const move = (e: MouseEvent): void => {
    if (document.pointerLockElement !== surface) return;
    if (ignoreNext) { ignoreNext = false; return; }
    wheel = clamp(wheel - e.movementX / driver.travel, -1, 1);
  };
  // взял руль — руль прямой: иначе «прямо» зависело бы от того, где был курсор
  const locked = (): void => {
    if (document.pointerLockElement === surface) { wheel = 0; ignoreNext = true; }
  };
  const grab = (): void => {
    if (document.pointerLockElement !== surface) surface.requestPointerLock();
  };

  addEventListener('keydown', down);
  addEventListener('keyup', up);
  addEventListener('mousemove', move);
  surface.addEventListener('mousedown', grab);
  document.addEventListener('pointerlockchange', locked);

  const driver: Driver = {
    assist: true,
    travel: TRAVEL_DEFAULT,
    command: 0,
    held(): boolean { return document.pointerLockElement === surface; },
    anchor(): void { wheel = 0; },
    release(): void { if (document.pointerLockElement === surface) document.exitPointerLock(); },
    pad(): boolean {
      return typeof navigator.getGamepads === 'function' && [...navigator.getGamepads()].some((g) => g !== null);
    },
    detach(): void {
      removeEventListener('keydown', down);
      removeEventListener('keyup', up);
      removeEventListener('mousemove', move);
      surface.removeEventListener('mousedown', grab);
      document.removeEventListener('pointerlockchange', locked);
      if (document.pointerLockElement === surface) document.exitPointerLock();
    },
    read(dt: number): Controls {
      const gamepad = typeof navigator.getGamepads === 'function'
        ? [...navigator.getGamepads()].find((g) => g !== null) ?? null : null;

      let steer: number;
      if (gamepad) {
        const raw = gamepad.axes[0] ?? 0;
        steer = Math.abs(raw) < 0.12 ? 0 : -raw;
        throttle = gamepad.buttons[7]?.value ?? 0;
        brake = gamepad.buttons[6]?.value ?? 0;
      } else {
        // клавиши — запасной руль: крутят его, а не дёргают
        const left = keys.has('KeyA') || keys.has('ArrowLeft');
        const right = keys.has('KeyD') || keys.has('ArrowRight');
        if (left !== right) keySteer = clamp(keySteer + (left ? 1 : -1) * dt * 1.6, -1, 1);
        else keySteer -= clamp(keySteer, -dt * 2.2, dt * 2.2);
        steer = clamp(wheel + keySteer, -1, 1);

        const gas = keys.has('KeyW') || keys.has('ArrowUp') ? (keys.has('ShiftLeft') ? 1 : 0.85) : 0;
        const stop = keys.has('KeyS') || keys.has('ArrowDown') || keys.has('Space') ? 1 : 0;
        throttle = pedal(throttle, gas, dt);
        brake = pedal(brake, stop, dt);
      }

      driver.command = steer;
      return {
        steer,
        throttle: clamp(throttle, 0, 1),
        brake: clamp(brake, 0, 1),
        handbrake: keys.has('KeyX') || (gamepad?.buttons[0]?.pressed ?? false),
        assist: driver.assist,
      };
    },
  };
  return driver;
}
