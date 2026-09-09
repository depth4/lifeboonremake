/**
 * Пешеходы: ходят по тротуарам и переходят дорогу на перекрёстках.
 *
 * Третий уровень подробности: точка, которая идёт вдоль дороги по своей
 * стороне и на узле либо сворачивает, либо переходит на другую сторону.
 * Ни сил, ни толкотни, ни обхода друг друга — это следующий слой, если
 * понадобится. Сейчас нужно, чтобы город не был пустым и чтобы машина
 * кого-то пропускала.
 *
 * Скорость взята из норм проектирования переходов: расчётный пешеход идёт
 * 1.0–1.4 м/с, и время зелёного для него считают именно по этой цифре.
 */

import type { World } from '../world/world.ts';
import { type Network, along } from './traffic.ts';
import { walkLight } from './signals.ts';

/** Быстрее этого никто не идёт, м/с. */
const PACE = 1.35;
/** Ширина перехода: в неё пешеход должен уложиться. */
const CROSS_SPEED = 1.2;

export interface Walker {
  /** По какой дороге идёт вдоль. */
  shape: number;
  /** Метров от начала дороги. */
  s: number;
  /** В какую сторону идёт по s. */
  dir: number;
  /** По какой стороне: +1 право по возрастанию s, −1 лево. */
  side: number;
  speed: number;
  /** Если переходит дорогу: сколько уже прошёл поперёк, доля. */
  crossing: number;
  colour: number;
  seed: number;
  /** Чем занят: для проверок. */
  state: 'идёт' | 'ждёт' | 'переходит';
}

const CLOTHES = [0x2f3a44, 0x6b4a3a, 0x8f8574, 0x3d5a4a, 0x77303a, 0x4a4a58, 0xa89a7c];

function roll(w: Walker): number {
  w.seed = (w.seed * 1103515245 + 12345) % 2147483648;
  return w.seed / 2147483648;
}

export function placeWalkers(world: World, net: Network, count: number, seed = 3): Walker[] {
  let rnd = seed * 7919 + 104729;
  const next = (): number => { rnd = (rnd * 1103515245 + 12345) % 2147483648; return rnd / 2147483648; };

  const walkers: Walker[] = [];
  for (let attempt = 0; attempt < count * 30 && walkers.length < count; attempt++) {
    const shape = Math.floor(next() * world.shapes.length) % world.shapes.length;
    const total = net.length[shape];
    if (total < 25) continue;
    walkers.push({
      shape,
      s: 6 + next() * (total - 12),
      dir: next() < 0.5 ? 1 : -1,
      side: next() < 0.5 ? 1 : -1,
      speed: PACE * (0.65 + next() * 0.5),
      crossing: 0,
      colour: CLOTHES[Math.floor(next() * CLOTHES.length) % CLOTHES.length],
      seed: Math.floor(next() * 2147483647),
      state: 'идёт',
    });
  }
  return walkers;
}

/** Где пешеход стоит и куда смотрит. */
export function walkerPose(world: World, w: Walker): { x: number; z: number; yaw: number } {
  const spot = along(world, w.shape, w.s);
  const shape = world.shapes[w.shape];
  // тротуар: чуть внутрь от внешнего края мощёной части
  const kerb = shape.outerHalf - 1.1;
  // при переходе едем от своей стороны к противоположной
  const offset = kerb * (w.side * (1 - 2 * w.crossing));
  // право по ходу возрастания s — это (−fz, fx)
  const x = spot.x - spot.fz * offset;
  const z = spot.z + spot.fx * offset;
  const heading = w.crossing > 0
    ? Math.atan2(spot.fx * -w.side, spot.fz * w.side) + Math.PI / 2
    : Math.atan2(spot.fz * w.dir, spot.fx * w.dir);
  return { x, z, yaw: heading };
}

/**
 * Шаг всех пешеходов. Переходят они только на перекрёстке и только когда
 * их пускает светофор — тот же, что держит машины, только смотрится с
 * другой стороны: пешеходу зелёный тогда, когда красный тем, кого он
 * пересекает.
 */
export function moveWalkers(
  world: World, net: Network, walkers: Walker[], dt: number, time: number,
): void {
  for (const w of walkers) {
    const total = net.length[w.shape];

    if (w.crossing > 0) {
      w.state = 'переходит';
      w.crossing += (CROSS_SPEED * dt) / Math.max(2, world.shapes[w.shape].outerHalf * 2);
      if (w.crossing >= 1) { w.crossing = 0; w.side = -w.side; w.state = 'идёт'; }
      continue;
    }

    w.state = 'идёт';
    w.s += w.speed * w.dir * dt;

    /**
     * Решение принимается на УГЛУ ТРОТУАРА, а не у центра перекрёстка.
     * Иначе пешеход доходит до середины поперечной проезжей части и там
     * разворачивается — то есть гуляет по дороге.
     */
    const corner = world.shapes[w.shape].outerHalf + 1;
    const atEnd = w.dir > 0 ? w.s > total - corner : w.s < corner;
    if (!atEnd) continue;

    const endS = w.dir > 0 ? total : 0;
    const node = net.nodes[w.shape].find((n) => Math.abs(n.s - endS) < 8);
    if (node === undefined) { w.dir = -w.dir; continue; }

    const decision = roll(w);
    if (decision < 0.45) {
      // перейти дорогу поперёк — если пускает светофор
      const signal = net.signals.find((sg) => sg.junction === node.junction);
      const approach = signal?.approaches.find((a) => a.shape === w.shape);
      const green = signal === undefined || approach === undefined
        ? true
        : walkLight(signal, approach.group, time).light === 'зелёный';
      if (green) { w.crossing = 1e-4; }
      else { w.state = 'ждёт'; w.s -= w.speed * w.dir * dt; }
      continue;
    }

    // свернуть на другую улицу или пойти обратно
    const exits = net.atJunction[node.junction].filter((l) => l.shape !== w.shape);
    if (exits.length > 0 && decision < 0.9) {
      const pick = exits[Math.floor(roll(w) * exits.length) % exits.length];
      const tail = net.length[pick.shape];
      w.shape = pick.shape;
      w.s = pick.s;
      w.dir = pick.s < tail / 2 ? 1 : -1;
      w.s += w.dir * (world.shapes[pick.shape].outerHalf + 1);
      if (roll(w) < 0.5) w.side = -w.side;
    } else {
      w.dir = -w.dir;
      w.s += w.dir * 1.5;
    }
  }
}
