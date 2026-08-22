/**
 * Мир целиком: рельеф + дорожная сеть.
 * Здесь живёт единственный ответ на вопрос «какая высота земли в этой точке».
 * Про экран этот файл не знает ничего — его можно считать без браузера.
 */

import type { Point2, RoadType, Road, Station } from './road.ts';
import type { Terrain } from './terrain.ts';
import { roadWidth, stationsFromLine } from './road.ts';
import { DEFAULT_TERRAIN, TERRAINS, WORLD_HALF } from './terrain.ts';
import { planarize, trimRadius } from './network.ts';

/**
 * Предельный продольный уклон дороги.
 * Настоящие нормы: магистраль 4–6%, сложный рельеф 8–12%, местные до 15%.
 * Дорога НЕ повторяет рельеф — она держит свой уклон, а земля подстраивается.
 */
export const MAX_GRADE = 0.08;

/**
 * Крутизна откосов: метров по горизонтали на метр по вертикали.
 * Выемка круче насыпи — так и в настоящем строительстве (1.5:1 против 2:1).
 */
const CUT_SLOPE = 1.5;
const FILL_SLOPE = 2.0;

const LIMIT_PASSES = 8;
const SMOOTH_PASSES = 25;
/** Меньше стольких станций участок не живёт: подрезать нечего. */
const MIN_STATIONS = 4;

export interface RoadShape {
  readonly type: RoadType;
  readonly stations: readonly Station[];
  readonly height: readonly number[];
  readonly halfWidth: number;
  readonly grade: number;
  readonly lift: number;
}

/** Торец участка, приходящий в узел. */
export interface JunctionEnd {
  readonly shape: number;
  /** торец в начале участка (иначе в конце) */
  readonly atStart: boolean;
}

/** Площадка перекрёстка: обход по торцам подрезанных коридоров. */
export interface Junction {
  readonly x: number;
  readonly z: number;
  readonly height: number;
  /** торцы, упорядоченные по кругу */
  readonly ends: readonly JunctionEnd[];
}

export interface World {
  readonly shapes: readonly RoadShape[];
  readonly junctions: readonly Junction[];
  readonly terrain: Terrain;
  readonly grade: number;
  readonly lift: number;
  /** почему постройку не удалось собрать; null — всё в порядке */
  readonly rejected: string | null;
}

function steepest(stations: readonly Station[], h: readonly number[]): number {
  let worst = 0;
  for (let i = 1; i < h.length; i++) {
    const ds = stations[i].s - stations[i - 1].s;
    if (ds > 0) worst = Math.max(worst, Math.abs(h[i] - h[i - 1]) / ds);
  }
  return worst;
}

/**
 * Прижимает профиль к допустимому уклону: проходим вперёд и назад, не давая
 * соседним точкам разойтись по высоте сильнее, чем позволяет уклон.
 * Концы закреплены на высоте узлов — иначе сходящиеся дороги разойдутся
 * по высоте, и перекрёсток окажется ступенькой.
 */
function limitGrade(stations: readonly Station[], h: number[], ends: [number, number]): void {
  for (let pass = 0; pass < LIMIT_PASSES; pass++) {
    h[0] = ends[0];
    for (let i = 1; i < h.length; i++) {
      const d = (stations[i].s - stations[i - 1].s) * MAX_GRADE;
      h[i] = Math.min(h[i - 1] + d, Math.max(h[i - 1] - d, h[i]));
    }
    h[h.length - 1] = ends[1];
    for (let i = h.length - 2; i >= 0; i--) {
      const d = (stations[i + 1].s - stations[i].s) * MAX_GRADE;
      h[i] = Math.min(h[i + 1] + d, Math.max(h[i + 1] - d, h[i]));
    }
    h[0] = ends[0];
  }
}

/** Сглаживание переломов. Уклон от него только уменьшается, предел остаётся цел. */
function smooth(h: number[]): void {
  for (let pass = 0; pass < SMOOTH_PASSES; pass++) {
    const prev = h.slice();
    for (let i = 1; i < h.length - 1; i++) h[i] = (prev[i - 1] + 2 * prev[i] + prev[i + 1]) / 4;
  }
}

/**
 * Продольный профиль участка.
 * Настоящую дорогу проектируют так: сначала своя линия высоты с ограниченным
 * уклоном, потом землю режут и сыплют под неё. Здесь то же самое.
 */
function profile(stations: readonly Station[], terrain: Terrain, ends: [number, number]): number[] {
  const h = stations.map((st) => terrain(st.x, st.z));
  limitGrade(stations, h, ends);
  smooth(h);
  h[0] = ends[0];
  h[h.length - 1] = ends[1];
  limitGrade(stations, h, ends);
  return h;
}

export function buildWorld(roads: readonly Road[], terrainName: string = DEFAULT_TERRAIN): World {
  const terrain = (TERRAINS[terrainName] ?? TERRAINS[DEFAULT_TERRAIN]).height;
  const net = planarize(roads);
  const nodeHeight = net.nodes.map((n) => terrain(n.x, n.z));

  // Высоты узлов тоже обязаны укладываться в предельный уклон: между двумя
  // близкими узлами с разной высотой земли дорога встала бы стеной.
  // Сближаем их, пока каждый участок не станет проходимым.
  for (let pass = 0; pass < 40; pass++) {
    let moved = false;
    for (const edge of net.edges) {
      const line = edge.line;
      let length = 0;
      for (let i = 1; i < line.length; i++) length += Math.hypot(line[i].x - line[i - 1].x, line[i].z - line[i - 1].z);
      const allowed = length * MAX_GRADE;
      const diff = nodeHeight[edge.to] - nodeHeight[edge.from];
      if (Math.abs(diff) <= allowed) continue;
      const pull = (Math.abs(diff) - allowed) / 2 * Math.sign(diff);
      nodeHeight[edge.from] += pull;
      nodeHeight[edge.to] -= pull;
      moved = true;
    }
    if (!moved) break;
  }

  const shapes: RoadShape[] = [];
  /** для каждого участка: индексы узлов и торцы */
  const ownerNode: { from: number; to: number }[] = [];
  let rejected: string | null = null;
  let dropped = 0;

  for (const edge of net.edges) {
    const full = stationsFromLine(edge.line);
    const halfWidth = roadWidth(edge.type) / 2;
    const height = profile(full, terrain, [nodeHeight[edge.from], nodeHeight[edge.to]]);

    // подрезаем торцы там, где сходятся дороги: полотна не должны налезать
    const cutFrom = net.nodes[edge.from].degree > 1 ? trimRadius(net, edge.from) : 0;
    const cutTo = net.nodes[edge.to].degree > 1 ? trimRadius(net, edge.to) : 0;
    const total = full[full.length - 1].s;

    const keep: number[] = [];
    for (let i = 0; i < full.length; i++) {
      if (full[i].s >= cutFrom - 1e-6 && total - full[i].s >= cutTo - 1e-6) keep.push(i);
    }
    // слишком короткий участок между перекрёстками просто не строится:
    // он всё равно целиком ушёл бы под площадку
    if (keep.length < MIN_STATIONS) {
      dropped++;
      continue;
    }

    const stations = keep.map((i) => full[i]);
    const cut = keep.map((i) => height[i]);

    // за краем мира земли нет — пришить к ней полотно не к чему
    const outside = stations.some(
      (st) => Math.abs(st.x) + halfWidth > WORLD_HALF || Math.abs(st.z) + halfWidth > WORLD_HALF,
    );
    if (outside) {
      rejected = 'дорога выходит за край мира';
      continue;
    }

    ownerNode.push({ from: edge.from, to: edge.to });
    shapes.push({
      type: edge.type,
      stations,
      height: cut,
      halfWidth,
      grade: steepest(stations, cut),
      lift: stations.reduce((m, st, i) => Math.max(m, Math.abs(cut[i] - terrain(st.x, st.z))), 0),
    });
  }

  // --- площадки перекрёстков: обход торцов по кругу ---
  const junctions: Junction[] = [];
  net.nodes.forEach((node, index) => {
    if (node.degree < 2) return;
    const ends: { end: JunctionEnd; angle: number }[] = [];

    shapes.forEach((shape, s) => {
      const owner = ownerNode[s];
      for (const atStart of [true, false]) {
        if ((atStart ? owner.from : owner.to) !== index) continue;
        const st = atStart ? shape.stations[0] : shape.stations[shape.stations.length - 1];
        ends.push({ end: { shape: s, atStart }, angle: Math.atan2(st.z - node.z, st.x - node.x) });
      }
    });

    if (ends.length < 2) return;
    ends.sort((a, b) => a.angle - b.angle);
    junctions.push({ x: node.x, z: node.z, height: nodeHeight[index], ends: ends.map((e) => e.end) });
  });

  if (shapes.length === 0 && roads.length > 0 && rejected === null) {
    rejected = dropped > 0 ? 'все участки короче перекрёстка' : 'дорога слишком короткая';
  }

  return {
    shapes,
    junctions,
    terrain,
    grade: shapes.reduce((g, s) => Math.max(g, s.grade), 0),
    lift: shapes.reduce((l, s) => Math.max(l, s.lift), 0),
    rejected,
  };
}

export interface RoadProximity {
  readonly distance: number;
  readonly roadHeight: number;
  readonly halfWidth: number;
}

export function nearestRoad(world: World, x: number, z: number): RoadProximity | null {
  let best: RoadProximity | null = null;

  for (const shape of world.shapes) {
    const st = shape.stations;
    for (let i = 0; i + 1 < st.length; i++) {
      const ax = st[i].x, az = st[i].z;
      const dx = st[i + 1].x - ax, dz = st[i + 1].z - az;
      const lenSq = dx * dx + dz * dz;
      let t = lenSq > 0 ? ((x - ax) * dx + (z - az) * dz) / lenSq : 0;
      t = Math.max(0, Math.min(1, t));
      const distance = Math.hypot(x - (ax + dx * t), z - (az + dz * t));
      if (best === null || distance < best.distance) {
        best = {
          distance,
          roadHeight: shape.height[i] + (shape.height[i + 1] - shape.height[i]) * t,
          halfWidth: shape.halfWidth,
        };
      }
    }
  }

  // площадка перекрёстка тоже держит землю: иначе вокруг неё будет провал
  for (const j of world.junctions) {
    const distance = Math.hypot(x - j.x, z - j.z);
    let radius = 0;
    for (const e of j.ends) radius = Math.max(radius, world.shapes[e.shape].halfWidth);
    if (best === null || distance - radius < best.distance - best.halfWidth) {
      best = { distance, roadHeight: j.height, halfWidth: radius };
    }
  }
  return best;
}

/**
 * Единственный источник правды о высоте земли.
 *
 * Под дорогой земля равна дороге — поэтому «земля торчит сквозь дорогу»
 * не может случиться: это одна и та же высота. В стороны земля уходит
 * под постоянным углом откоса и КОНЧАЕТСЯ, догнав нетронутую землю.
 */
export function groundHeightAt(world: World, x: number, z: number): number {
  const natural = world.terrain(x, z);
  const near = nearestRoad(world, x, z);
  if (near === null) return natural;

  const free = Math.max(0, near.distance - near.halfWidth);
  return Math.min(near.roadHeight + free / CUT_SLOPE, Math.max(near.roadHeight - free / FILL_SLOPE, natural));
}

/** Точки поперечника торца, от -полуширины к +полуширине в системе станции. */
export function endProfile(shape: RoadShape, atStart: boolean): { station: Station; height: number } {
  const i = atStart ? 0 : shape.stations.length - 1;
  return { station: shape.stations[i], height: shape.height[i] };
}

export type { Point2 };
