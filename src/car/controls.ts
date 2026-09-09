/**
 * Органы управления: превращает мышь, клавиши и геймпад в четыре числа,
 * которые понимает машина — руль, газ, тормоз, ручник.
 *
 * Задача не «прочитать нажатия», а починить главную беду клавиатурного
 * управления: у клавиши два положения, а у руля и педали — бесконечно много.
 * Поэтому:
 *
 * 1. РУЛЬ — это ПОЛОЖЕНИЕ, а не команда «влево». Мышь задаёт его целиком:
 *    сдвинул на треть — держится треть, пока не сдвинешь обратно. Именно это
 *    и называется «держать руль». Возврат к нулю — отдельная кнопка, потому
 *    что в настоящей машине руль возвращает не рулевая, а шины.
 *
 * 2. ПЕДАЛЬ — это НОГА, у которой есть время хода. Клавиша не включает газ,
 *    а начинает его нажимать: до пола примерно четверть секунды, отпускается
 *    быстрее. Короткое касание даёт короткий газ — вот и дозирование.
 *
 * Схемы различаются только тем, чем задаётся газ. Руль всегда мышью.
 */

import type { Controls } from './car.ts';

export type SchemeId = 'педали' | 'мышь' | 'ручной';

export interface Scheme {
  readonly id: SchemeId;
  readonly label: string;
  readonly hint: string;
}

export const SCHEMES: readonly Scheme[] = [
  { id: 'педали', label: 'педали', hint: 'мышь — руль, W/S — газ и тормоз с ходом ноги, Shift — в пол' },
  { id: 'мышь', label: 'мышь целиком', hint: 'мышь: вбок — руль, от себя — газ, на себя — тормоз' },
  { id: 'ручной', label: 'ручной газ', hint: 'колёсико держит газ как ручку на катере, пробел — тормоз' },
];

/**
 * Сколько пикселей мыши от нуля до упора руля. Это ЕДИНСТВЕННАЯ настройка
 * ощущения, и её меняют клавишами [ и ]: подобрать её можно только руками.
 */
const LOCK_DEFAULT = 360;
/** Сколько пикселей мыши от нуля до полного газа во второй схеме. */
const PEDAL_PIXELS = 220;
/** Время хода педали до пола и обратно, с. */
const PRESS = 0.22;
const RELEASE = 0.14;

export interface Driver {
  /** Сколько пикселей мыши от нуля до упора руля. */
  sensitivity: number;
  /** Опросить и посчитать. `speed` — м/с, нужна возврату руля. */
  read(dt: number, speed: number): Controls;
  scheme: SchemeId;
  /** Возвращать ли руль самому, как в настоящей машине. */
  selfCentre: boolean;
  /** Подключён ли геймпад — тогда он главнее мыши. */
  pad(): boolean;
  detach(): void;
}

const clamp = (v: number, lo: number, hi: number): number => (v < lo ? lo : v > hi ? hi : v);

/** Педаль догоняет клавишу со скоростью ноги, а не мгновенно. */
function pedal(now: number, want: number, dt: number): number {
  const rate = want > now ? dt / PRESS : dt / RELEASE;
  return clamp(now + clamp(want - now, -rate, rate), 0, 1);
}

export function createDriver(target: HTMLElement): Driver {
  const keys = new Set<string>();
  let lockPixels = LOCK_DEFAULT;
  let steer = 0;      // −1..1, положение руля
  let mouseGas = 0;   // −1..1 для схемы «мышь»: плюс газ, минус тормоз
  let handGas = 0;    // 0..1 для схемы «ручной газ»
  let throttle = 0, brake = 0;

  const down = (e: KeyboardEvent): void => {
    keys.add(e.code);
    // [ и ] — чувствительность руля. Единственное, что подбирается только руками
    if (e.code === 'BracketLeft') lockPixels = clamp(lockPixels - 40, 120, 900);
    if (e.code === 'BracketRight') lockPixels = clamp(lockPixels + 40, 120, 900);
    if (e.code === 'Space' || e.code.startsWith('Arrow')) e.preventDefault();
  };
  const up = (e: KeyboardEvent): void => { keys.delete(e.code); };
  const move = (e: MouseEvent): void => {
    if (document.pointerLockElement !== target) return;
    steer = clamp(steer - e.movementX / lockPixels, -1, 1);
    mouseGas = clamp(mouseGas - e.movementY / PEDAL_PIXELS, -1, 1);
  };
  const wheel = (e: WheelEvent): void => {
    if (document.pointerLockElement !== target) return;
    e.preventDefault();
    handGas = clamp(handGas - e.deltaY / 400, 0, 1);
  };
  const click = (e: MouseEvent): void => {
    if (document.pointerLockElement !== target) { target.requestPointerLock(); return; }
    if (e.button === 0) handGas = 0; // левая кнопка — сбросить ручной газ
  };

  addEventListener('keydown', down);
  addEventListener('keyup', up);
  addEventListener('mousemove', move);
  target.addEventListener('wheel', wheel, { passive: false });
  target.addEventListener('mousedown', click);

  const driver: Driver = {
    scheme: 'педали',
    selfCentre: false,
    get sensitivity(): number { return lockPixels; },
    set sensitivity(value: number) { lockPixels = clamp(value, 120, 900); },
    pad(): boolean {
      return typeof navigator.getGamepads === 'function' && [...navigator.getGamepads()].some((g) => g !== null);
    },
    detach(): void {
      removeEventListener('keydown', down);
      removeEventListener('keyup', up);
      removeEventListener('mousemove', move);
      target.removeEventListener('wheel', wheel);
      target.removeEventListener('mousedown', click);
      if (document.pointerLockElement === target) document.exitPointerLock();
    },
    read(dt: number, speed: number): Controls {
      // геймпад главнее: у него настоящие аналоговые оси
      const gamepad = typeof navigator.getGamepads === 'function'
        ? [...navigator.getGamepads()].find((g) => g !== null) ?? null : null;

      let wantThrottle = 0, wantBrake = 0;

      if (gamepad) {
        const dead = (v: number): number => (Math.abs(v) < 0.12 ? 0 : v);
        steer = clamp(-dead(gamepad.axes[0] ?? 0), -1, 1);
        wantThrottle = gamepad.buttons[7]?.value ?? 0;
        wantBrake = gamepad.buttons[6]?.value ?? 0;
        throttle = wantThrottle;
        brake = wantBrake;
      } else {
        const keyLeft = keys.has('KeyA') || keys.has('ArrowLeft');
        const keyRight = keys.has('KeyD') || keys.has('ArrowRight');
        // клавиши остаются как запасной руль — но крутят его, а не дёргают
        if (keyLeft !== keyRight) steer = clamp(steer + (keyLeft ? 1 : -1) * dt * 1.6, -1, 1);

        if (driver.scheme === 'мышь') {
          wantThrottle = Math.max(0, mouseGas);
          wantBrake = Math.max(0, -mouseGas);
          throttle = wantThrottle; brake = wantBrake; // мышь уже аналоговая, ход ноги не нужен
        } else if (driver.scheme === 'ручной') {
          throttle = handGas;
          brake = pedal(brake, keys.has('Space') || keys.has('KeyS') ? 1 : 0, dt);
        } else {
          const gas = keys.has('KeyW') || keys.has('ArrowUp') ? (keys.has('ShiftLeft') ? 1 : 0.85) : 0;
          const stop = keys.has('KeyS') || keys.has('ArrowDown') || keys.has('Space') ? 1 : 0;
          throttle = pedal(throttle, gas, dt);
          brake = pedal(brake, stop, dt);
        }
      }

      // возврат руля: чем быстрее едем, тем сильнее шины тянут его к нулю
      if (driver.selfCentre && !gamepad) {
        const pull = Math.min(1, Math.abs(speed) / 12) * dt * 2.2;
        steer -= clamp(steer, -pull, pull);
      }
      if (keys.has('KeyR')) steer = 0; // «отпустить руль»

      return {
        steer,
        throttle: clamp(throttle, 0, 1),
        brake: clamp(brake, 0, 1),
        handbrake: keys.has('KeyX') || (gamepad?.buttons[0]?.pressed ?? false),
      };
    },
  };
  return driver;
}
