/**
 * Примитивный трафик: машины, которые едут по дорожной сети сами.
 *
 * Это второй уровень подробности из docs/how-cars-work.md §12: не четыре
 * пятна контакта, а точка, которая едет по своей полосе с ограничением по
 * скорости и по повороту. Шин, подвески и коробки у неё нет и не нужно —
 * на расстоянии их всё равно не видно, а стоит такая машина в двести раз
 * дешевле игроковой.
 *
 * Про экран не знает: отдаёт положение и курс, рисует их кто-то другой.
 */

import type { World } from '../world/world.ts';

const G = 9.80665;
/** С какой боковой перегрузкой ездит обычный водитель. */
const COMFORT = 0.28;
/** Быстрее этого по городу никто не едет, м/с. */
const CRUISE = 16;
/** Ближе этого к перекрёстку — снижаем до сорока. */
const JUNCTION_ZONE = 14;
/** Ближе этого не подъезжаем ни при каких условиях, м: машина длиной 4.4. */
const MIN_GAP = 6;

export interface Mover {
  /** По какой дороге едет. */
  shape: number;
  /** Метров от начала дороги. */
  s: number;
  /** В какую сторону: +1 по возрастанию s, −1 навстречу. */
  dir: number;
  speed: number;
  /** Сглаженный курс: на перекрёстке дорога ломается, а машина — нет. */
  yaw: number;
  colour: number;
  /** Своя крейсерская скорость: одни торопятся, другие нет. */
  cruise: number;
  /** Метры до ближайшей развилки, где можно снова повернуть. */
  hold: number;
}

interface Link { shape: number; s: number }

export interface Network {
  readonly length: number[];
  /** По узлам: какие дороги через них проходят и на каком метре. */
  readonly atJunction: Link[][];
  /** По дорогам: на каких метрах у них узлы. */
  readonly nodes: { s: number; junction: number }[][];
}

/**
 * Связи дорог считаются один раз по геометрии: у мира нет графа развязок,
 * есть только точки узлов. Дорога проходит через узел, если её станция
 * оказалась к нему ближе шести метров.
 */
export function buildNetwork(world: World): Network {
  const length = world.shapes.map((sh) => sh.stations.at(-1)?.s ?? 0);
  const atJunction: Link[][] = world.junctions.map(() => []);
  const nodes: { s: number; junction: number }[][] = world.shapes.map(() => []);

  world.junctions.forEach((j, ji) => {
    world.shapes.forEach((shape, si) => {
      let best = Infinity, bestS = 0;
      for (const st of shape.stations) {
        const d = Math.hypot(st.x - j.x, st.z - j.z);
        if (d < best) { best = d; bestS = st.s; }
      }
      if (best < 6) {
        atJunction[ji].push({ shape: si, s: bestS });
        nodes[si].push({ s: bestS, junction: ji });
      }
    });
  });
  for (const list of nodes) list.sort((a, b) => a.s - b.s);
  return { length, atJunction, nodes };
}

/** Где дорога в этом месте и куда она смотрит. */
export function along(world: World, shape: number, s: number): { x: number; z: number; fx: number; fz: number } {
  const st = world.shapes[shape].stations;
  const total = st.at(-1)?.s ?? 0;
  const t = Math.max(0, Math.min(total, s));
  let i = 0;
  while (i + 2 < st.length && st[i + 1].s < t) i++;
  const a = st[i], b = st[i + 1];
  const k = (t - a.s) / Math.max(1e-6, b.s - a.s);
  const dx = b.x - a.x, dz = b.z - a.z;
  const len = Math.hypot(dx, dz) || 1;
  return { x: a.x + dx * k, z: a.z + dz * k, fx: dx / len, fz: dz / len };
}

/** Насколько круто дорога заворачивает здесь: радиус в метрах. */
function radius(world: World, shape: number, s: number): number {
  const back = along(world, shape, s - 5), fwd = along(world, shape, s + 5);
  const turn = Math.atan2(fwd.fz, fwd.fx) - Math.atan2(back.fz, back.fx);
  const wrapped = Math.abs(Math.atan2(Math.sin(turn), Math.cos(turn)));
  return wrapped < 1e-4 ? 1e5 : 10 / wrapped;
}

const COLOURS = [0x9fa5ab, 0x2b3a4a, 0x7d2b2b, 0xd8d3c6, 0x35513f, 0x1c1e22, 0x8a7b4f];

/** Расставить машины по дорогам. Расстановка одинакова при одном и том же зерне. */
export function placeTraffic(world: World, net: Network, count: number, seed = 1): Mover[] {
  let rnd = seed * 9301 + 49297;
  const next = (): number => { rnd = (rnd * 9301 + 49297) % 233280; return rnd / 233280; };

  const movers: Mover[] = [];
  for (let attempt = 0; attempt < count * 40 && movers.length < count; attempt++) {
    const shape = Math.floor(next() * world.shapes.length) % world.shapes.length;
    const total = net.length[shape];
    if (total < 30) continue;
    const dir = next() < 0.5 ? 1 : -1;
    const s = 10 + next() * (total - 20);
    // не ставим машину в багажник другой: разъехаться из такого они уже
    // не смогут — держать дистанцию умеют, а увеличивать её нечем
    if (movers.some((o) => o.shape === shape && Math.abs(o.s - s) < 16)) continue;
    const spot = along(world, shape, s);
    movers.push({
      shape, s, dir, speed: 8 + next() * 5, hold: 0,
      // разные характеры: без этого все едут ровно и никто никого не догоняет
      cruise: CRUISE * (0.6 + next() * 0.4),
      yaw: Math.atan2(spot.fz * dir, spot.fx * dir),
      colour: COLOURS[Math.floor(next() * COLOURS.length) % COLOURS.length],
    });
  }
  return movers;
}

/** Куда машина смотрит и где стоит: с учётом своей полосы (правостороннее). */
export function poseOf(world: World, m: Mover): { x: number; z: number; yaw: number } {
  const spot = along(world, m.shape, m.s);
  const fx = spot.fx * m.dir, fz = spot.fz * m.dir;
  // Право по ходу — это cross(вперёд, вверх) = (−fz, fx). Знак здесь стоял
  // наоборот, и весь трафик ездил по левой стороне.
  const rx = -fz, rz = fx;
  const lane = world.shapes[m.shape].halfWidth * 0.5;
  return { x: spot.x + rx * lane, z: spot.z + rz * lane, yaw: Math.atan2(fz, fx) };
}

/**
 * Один шаг всего трафика. Каждая машина:
 * 1) держит скорость, с какой проходится поворот и подъезжается к узлу;
 * 2) не наезжает на того, кто впереди на её же дороге и в её же сторону;
 * 3) на узле иногда сворачивает на другую дорогу;
 * 4) доехав до конца дороги — разворачивается.
 */
export function moveTraffic(
  world: World, net: Network, movers: Mover[], dt: number,
  options: { headway?: boolean } = {},
): void {
  const headway = options.headway ?? true;
  for (const m of movers) {
    const total = net.length[m.shape];

    // предел по повороту дороги
    let target = Math.min(m.cruise, Math.sqrt(COMFORT * G * radius(world, m.shape, m.s)));

    // перед узлом притормаживаем
    for (const node of net.nodes[m.shape]) {
      const ahead = (node.s - m.s) * m.dir;
      if (ahead > 0 && ahead < JUNCTION_ZONE) target = Math.min(target, 11);
    }

    /**
     * Кто впереди на этой же дороге и в ту же сторону. Дистанция —
     * ЖЁСТКОЕ условие, а не пожелание: ближе минимума скорость просто ноль.
     * Плавного «сбавить пропорционально» не хватает — на нём машины
     * доезжали друг до друга на три метра, то есть въезжали в багажник.
     */
    for (const other of movers) {
      if (!headway) break;
      if (other === m || other.shape !== m.shape || other.dir !== m.dir) continue;
      const gap = (other.s - m.s) * m.dir;
      const want = 8 + m.speed * 1.2;
      if (gap <= 0 || gap >= want) continue;
      target = gap <= MIN_GAP
        ? 0
        : Math.min(target, other.speed * ((gap - MIN_GAP) / (want - MIN_GAP)));
    }

    const accel = target > m.speed ? 2.2 : 5.5;
    m.speed += Math.max(-accel * dt, Math.min(accel * dt, target - m.speed));
    m.speed = Math.max(0, m.speed);

    m.s += m.speed * m.dir * dt;
    m.hold = Math.max(0, m.hold - m.speed * dt);

    /**
     * Развязка. В нашем мире дороги УЖЕ разрезаны узлами (решение о том, что
     * перекрёсток рождается сам), поэтому участок — это ребро графа, а его
     * концы — узлы. Значит сворачивать надо не посреди дороги, а доехав
     * до её конца: там выбираем следующий участок из тех, что сходятся
     * в этом же узле.
     */
    const nearEnd = m.dir > 0 ? m.s > total - 3 : m.s < 3;
    if (nearEnd) {
      const endS = m.dir > 0 ? total : 0;
      const node = net.nodes[m.shape].find((n) => Math.abs(n.s - endS) < 8);
      const exits = node === undefined ? [] : net.atJunction[node.junction]
        .filter((l) => l.shape !== m.shape)
        .filter((l) => {
          // не выезжаем прямо в бок тому, кто уже там
          const busy = movers.some((o) => o !== m && o.shape === l.shape && Math.abs(o.s - l.s) < 14);
          return !busy;
        });
      if (exits.length > 0) {
        const pick = exits[Math.floor(Math.random() * exits.length)];
        const tail = net.length[pick.shape];
        m.shape = pick.shape;
        m.s = pick.s;
        m.dir = pick.s < tail / 2 ? 1 : -1; // едем ОТ узла, вглубь участка
        m.s += m.dir * 3;
      } else {
        /**
         * Тупик — разворот. Но только если встречная полоса свободна:
         * развернувшись, машина ОКАЗЫВАЕТСЯ в чужой полосе, и если там
         * кто-то есть, они встанут в трёх метрах друг от друга. Именно
         * на этом проверка дистанции и падала.
         */
        const back = -m.dir;
        const busy = movers.some((o) => o !== m && o.shape === m.shape
          && o.dir === back && Math.abs(o.s - m.s) < 14);
        if (busy) {
          m.speed = 0;
          m.s = Math.max(2, Math.min(total - 2, m.s));
        } else {
          m.dir = back;
          m.s = Math.max(3, Math.min(total - 3, m.s + m.dir * 2));
        }
      }
    }

    // курс догоняет дорогу, а не прыгает вместе с ней
    const want = poseOf(world, m).yaw;
    const turn = Math.atan2(Math.sin(want - m.yaw), Math.cos(want - m.yaw));
    m.yaw += Math.max(-2.5 * dt, Math.min(2.5 * dt, turn));
  }
}
