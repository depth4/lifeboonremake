/**
 * Органы управления: мышь — руль, клавиши — педали.
 *
 * Сделано как в Assetto Corsa: **положение курсора И ЕСТЬ угол руля.**
 * Не накопленные сдвиги, а положение. Разница принципиальная: у накопителя
 * нет нуля, и рука со временем уплывает — центр приходится искать глазами.
 * У положения ноль есть всегда.
 *
 * Ноль ставится в тот миг, когда садишься за руль: где рука в этот момент,
 * там и «прямо». Иначе, сев с курсором у края экрана, получаешь руль сразу
 * в упоре. `R` переставляет ноль на текущее место — это «перехватить руль»,
 * ровно как перехватывают настоящий, доехав до края хода рук.
 *
 * Педали — на клавишах (так у всех трёх: Assetto Corsa, Euro Truck, BeamNG),
 * и клавиша не включает газ, а начинает нажимать педаль: до пола 0.22 с.
 * Короткое касание даёт короткий газ — вот и дозирование.
 *
 * Помощь рулю (её считает сама машина, здесь только выключатель) — два
 * помощника, как в BeamNG: предел по сцеплению передних колёс и контрруль,
 * изображающий кастор.
 */

import type { Controls } from './car.ts';

/** Какая доля половины окна соответствует полному вывороту руля. */
const LOCK_SHARE_DEFAULT = 0.3;
/** Мёртвая зона у центра, доля от той же половины окна. */
const DEAD = 0.03;
/** Время хода педали до пола и обратно, с. */
const PRESS = 0.22;
const RELEASE = 0.14;

export interface Driver {
  read(dt: number): Controls;
  /** Помощь рулю: предел по сцеплению и контрруль. */
  assist: boolean;
  /** Какая доля половины окна = полный выворот. Меньше — острее. */
  share: number;
  /** Положение руля, заданное игроком, −1..1 — приборке. */
  command: number;
  /** Считать текущее место курсора нулём руля. */
  anchor(): void;
  pad(): boolean;
  detach(): void;
}

const clamp = (v: number, lo: number, hi: number): number => (v < lo ? lo : v > hi ? hi : v);

/** Педаль догоняет клавишу со скоростью ноги, а не мгновенно. */
function pedal(now: number, want: number, dt: number): number {
  const rate = want > now ? dt / PRESS : dt / RELEASE;
  return clamp(now + clamp(want - now, -rate, rate), 0, 1);
}

export function createDriver(): Driver {
  const keys = new Set<string>();
  let pointerX: number | null = null;
  let origin: number | null = null;
  let throttle = 0, brake = 0, keySteer = 0;

  const down = (e: KeyboardEvent): void => {
    keys.add(e.code);
    if (e.code === 'Space' || e.code.startsWith('Arrow')) e.preventDefault();
    // острота руля: сколько коврика уходит на полный выворот
    if (e.code === 'BracketLeft') driver.share = clamp(driver.share + 0.04, 0.1, 0.7);
    if (e.code === 'BracketRight') driver.share = clamp(driver.share - 0.04, 0.1, 0.7);
  };
  const up = (e: KeyboardEvent): void => { keys.delete(e.code); };
  const move = (e: MouseEvent): void => { pointerX = e.clientX; };

  addEventListener('keydown', down);
  addEventListener('keyup', up);
  addEventListener('mousemove', move);

  const driver: Driver = {
    assist: true,
    share: LOCK_SHARE_DEFAULT,
    command: 0,
    anchor(): void { origin = pointerX; },
    pad(): boolean {
      return typeof navigator.getGamepads === 'function' && [...navigator.getGamepads()].some((g) => g !== null);
    },
    detach(): void {
      removeEventListener('keydown', down);
      removeEventListener('keyup', up);
      removeEventListener('mousemove', move);
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
        // руль: где курсор относительно нуля, с мёртвой зоной
        if (keys.has('KeyR')) origin = pointerX;
        const half = innerWidth / 2;
        const zero = origin ?? half;
        const offset = pointerX === null ? 0 : (zero - pointerX) / (half * driver.share);
        const size = Math.abs(offset);
        const beyond = size <= DEAD ? 0 : (size - DEAD) / (1 - DEAD);
        const fromMouse = clamp(Math.sign(offset) * beyond, -1, 1);

        // клавиши — запасной руль: крутят его, а не дёргают
        const left = keys.has('KeyA') || keys.has('ArrowLeft');
        const right = keys.has('KeyD') || keys.has('ArrowRight');
        if (left !== right) keySteer = clamp(keySteer + (left ? 1 : -1) * dt * 1.6, -1, 1);
        else keySteer -= clamp(keySteer, -dt * 2.2, dt * 2.2);
        steer = keySteer !== 0 ? clamp(fromMouse + keySteer, -1, 1) : fromMouse;

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
