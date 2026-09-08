/**
 * Мир целиком: рельеф + дорожная сеть.
 *
 * Здесь живёт ЕДИНСТВЕННЫЙ ответ на вопрос «какая высота поверхности в этой
 * точке». Из чего сделана поверхность в этой точке — асфальт, тротуар или
 * трава — отдельный вопрос, и на него отвечает уже сборщик поверхности.
 * Два независимых вопроса не могут противоречить друг другу.
 *
 * Про экран этот файл не знает ничего — его можно считать без браузера.
 */

import type { Point2, Road, RoadType, Station } from './road.ts';
import type { Terrain } from './terrain.ts';
import { roadWidth, stationsFromLine } from './road.ts';
import { DEFAULT_TERRAIN, TERRAINS } from './terrain.ts';
import { planarize } from './network.ts';

/**
 * Предельный продольный уклон дороги.
 * Настоящие нормы: магистраль 4–6%, сложный рельеф 8–12%, местные до 15%.
 * Дорога НЕ повторяет рельеф — она держит свой уклон, а земля подстраивается.
 */
export const MAX_GRADE = 0.08;

/**
 * Крутизна откосов: метров по горизонтали на метр по вертикали.
 * Выемка круче насыпи — как в настоящем строительстве (1.5:1 против 2:1).
 */
const CUT_SLOPE = 1.5;
const FILL_SLOPE = 2.0;

const LIMIT_PASSES = 8;
const SMOOTH_PASSES = 25;

export interface RoadShape {
  readonly type: RoadType;
  readonly stations: readonly Station[];
  readonly height: readonly number[];
  /** полуширина проезжей части */
  readonly halfWidth: number;
  /** полуширина вместе с тротуарами */
  readonly outerHalf: number;
  readonly grade: number;
  readonly lift: number;
}

/** Узел: место, где сходятся дороги. Форму площадки мир не знает — это дело сборщика. */
export interface Junction {
  readonly x: number;
  readonly z: number;
  readonly height: number;
  readonly degree: number;
}

export interface World {
  readonly shapes: readonly RoadShape[];
  readonly junctions: readonly Junction[];
  readonly terrain: Terrain;
  readonly grade: number;
  readonly lift: number;
  /**
   * Раскладка отрезков дорог по клеткам. Считается один раз вместе с миром,
   * поэтому устареть не может: мира без своей раскладки не существует.
   * Без неё каждый вопрос «какая дорога ближе» перебирал ВСЕ отрезки, и на
   * большой сцене на это уходили секунды.
   */
  readonly near: (x: number, z: number) => RoadProximity | null;
}

function steepest(stations: readonly Station[], h: readonly number[]): number {
  let worst = 0;
  for (let i = 1; i < h.length; i++) {
    const ds = stations[i].s - stations[i - 1].s;
    if (ds > 0) worst = Math.max(worst, Math.abs(h[i] - h[i - 1]) / ds);
  }
  return worst;
}

/** Прижимает профиль к допустимому уклону. Концы закреплены на высотах узлов. */
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
  for (let pass = 0; pass < 40; pass++) {
    let moved = false;
    for (const edge of net.edges) {
      let length = 0;
      for (let i = 1; i < edge.line.length; i++) {
        length += Math.hypot(edge.line[i].x - edge.line[i - 1].x, edge.line[i].z - edge.line[i - 1].z);
      }
      const allowed = length * MAX_GRADE;
      const diff = nodeHeight[edge.to] - nodeHeight[edge.from];
      if (Math.abs(diff) <= allowed) continue;
      const pull = ((Math.abs(diff) - allowed) / 2) * Math.sign(diff);
      nodeHeight[edge.from] += pull;
      nodeHeight[edge.to] -= pull;
      moved = true;
    }
    if (!moved) break;
  }

  const shapes: RoadShape[] = net.edges.map((edge) => {
    const stations = stationsFromLine(edge.line);
    const height = profile(stations, terrain, [nodeHeight[edge.from], nodeHeight[edge.to]]);
    return {
      type: edge.type,
      stations,
      height,
      halfWidth: roadWidth(edge.type) / 2,
      outerHalf: roadWidth(edge.type) / 2 + edge.type.sidewalk,
      grade: steepest(stations, height),
      lift: stations.reduce((m, st, i) => Math.max(m, Math.abs(height[i] - terrain(st.x, st.z))), 0),
    };
  });

  const junctions: Junction[] = net.nodes
    .map((node, i) => ({ x: node.x, z: node.z, height: nodeHeight[i], degree: node.degree }))
    .filter((j) => j.degree > 1);

  return {
    shapes,
    junctions,
    terrain,
    grade: shapes.reduce((g, s) => Math.max(g, s.grade), 0),
    lift: shapes.reduce((l, s) => Math.max(l, s.lift), 0),
    near: indexRoads(shapes),
  };
}

export interface RoadProximity {
  readonly distance: number;
  readonly roadHeight: number;
  readonly halfWidth: number;
  readonly outerHalf: number;
  readonly curb: number;
}

/** Ближайшая дорога и её высота в этой точке. */
export function nearestRoad(world: World, x: number, z: number): RoadProximity | null {
  return world.near(x, z);
}

/** Размер клетки раскладки, метры. */
const CELL = 16;

/**
 * Строит раскладку отрезков по клеткам и возвращает вопрос «кто здесь ближе».
 *
 * Сравниваем не по голому расстоянию, а по «насколько вылезли за край дороги»:
 * иначе широкая дорога рядом проигрывала бы узкой. Поиск расширяется кольцами
 * клеток и останавливается, когда следующее кольцо заведомо не может выиграть
 * даже самой широкой дорогой. Приблизительных ответов тут не бывает.
 *
 * Клетки лежат сплошным массивом, а не словарём по строковому ключу: этот
 * вопрос задаётся десятки тысяч раз за сборку, и склейка строк для ключа
 * съедала больше времени, чем вся триангуляция.
 */
function indexRoads(shapes: readonly RoadShape[]): (x: number, z: number) => RoadProximity | null {
  interface Seg {
    ax: number; az: number; dx: number; dz: number; lenSq: number;
    h0: number; h1: number; shape: RoadShape;
  }
  const segments: { seg: Seg; i0: number; i1: number; j0: number; j1: number }[] = [];
  let widest = 0;
  let minI = Infinity, maxI = -Infinity, minJ = Infinity, maxJ = -Infinity;

  for (const shape of shapes) {
    widest = Math.max(widest, shape.outerHalf);
    const st = shape.stations;
    for (let i = 0; i + 1 < st.length; i++) {
      const seg: Seg = {
        ax: st[i].x, az: st[i].z,
        dx: st[i + 1].x - st[i].x, dz: st[i + 1].z - st[i].z,
        lenSq: 0, h0: shape.height[i], h1: shape.height[i + 1], shape,
      };
      seg.lenSq = seg.dx * seg.dx + seg.dz * seg.dz;
      const i0 = Math.floor(Math.min(seg.ax, seg.ax + seg.dx) / CELL);
      const i1 = Math.floor(Math.max(seg.ax, seg.ax + seg.dx) / CELL);
      const j0 = Math.floor(Math.min(seg.az, seg.az + seg.dz) / CELL);
      const j1 = Math.floor(Math.max(seg.az, seg.az + seg.dz) / CELL);
      segments.push({ seg, i0, i1, j0, j1 });
      minI = Math.min(minI, i0); maxI = Math.max(maxI, i1);
      minJ = Math.min(minJ, j0); maxJ = Math.max(maxJ, j1);
    }
  }
  if (segments.length === 0) return () => null;

  const cols = maxI - minI + 1;
  const rows = maxJ - minJ + 1;
  const cells: (Seg[] | undefined)[] = new Array(cols * rows);
  for (const { seg, i0, i1, j0, j1 } of segments) {
    for (let ii = i0; ii <= i1; ii++) {
      for (let jj = j0; jj <= j1; jj++) {
        const at = (ii - minI) * rows + (jj - minJ);
        const list = cells[at];
        if (list) list.push(seg);
        else cells[at] = [seg];
      }
    }
  }

  return (x, z) => {
    const ci = Math.floor(x / CELL), cj = Math.floor(z / CELL);
    let best: RoadProximity | null = null;
    let bestKey = Infinity;

    // сколько колец придётся обойти в худшем случае — считаем, а не гадаем
    const limit = Math.max(cols, rows) + Math.abs(ci - minI) + Math.abs(cj - minJ) + 2;
    for (let r = 0; r <= limit; r++) {
      const iFrom = Math.max(ci - r, minI), iTo = Math.min(ci + r, maxI);
      const jFrom = Math.max(cj - r, minJ), jTo = Math.min(cj + r, maxJ);
      for (let i = iFrom; i <= iTo; i++) {
        const edgeI = i === ci - r || i === ci + r;
        const base = (i - minI) * rows;
        for (let j = jFrom; j <= jTo; j++) {
          if (r > 0 && !edgeI && j !== cj - r && j !== cj + r) continue;
          const list = cells[base + (j - minJ)];
          if (list === undefined) continue;
          for (const seg of list) {
            let t = seg.lenSq > 0 ? ((x - seg.ax) * seg.dx + (z - seg.az) * seg.dz) / seg.lenSq : 0;
            t = t < 0 ? 0 : t > 1 ? 1 : t;
            const ex = x - (seg.ax + seg.dx * t), ez = z - (seg.az + seg.dz * t);
            const distance = Math.sqrt(ex * ex + ez * ez);
            const key = distance - seg.shape.outerHalf;
            if (key >= bestKey) continue;
            bestKey = key;
            best = {
              distance,
              roadHeight: seg.h0 + (seg.h1 - seg.h0) * t,
              halfWidth: seg.shape.halfWidth,
              outerHalf: seg.shape.outerHalf,
              curb: seg.shape.type.curb,
            };
          }
        }
      }
      // отрезок из следующего кольца лежит не ближе (r-1)*CELL, и даже самая
      // широкая дорога не сделает его лучше найденного — искать больше нечего
      if (best !== null && (r - 1) * CELL - widest > bestKey) break;
    }
    return best;
  };
}

/**
 * Высота ПРОЕЗЖЕЙ ЧАСТИ в этой точке. Ровно профиль ближайшей дороги.
 * Асфальт всегда лежит на ней и ни на чём другом.
 */
export function roadHeightAt(world: World, x: number, z: number): number {
  const near = nearestRoad(world, x, z);
  return near === null ? world.terrain(x, z) : near.roadHeight;
}

/**
 * Высота ВСЕГО ОСТАЛЬНОГО: тротуарной полки и земли вокруг.
 *
 * `outward` — сколько метров точка находится СНАРУЖИ мощёной части.
 * Ноль — мы ещё на полке. Считает это тот, кто рисует поверхность: только он
 * знает, где на самом деле проходит край тротуара. Если бы высота считала край
 * по-своему, у полки и её края было бы два разных края — и они бы разошлись.
 *
 * Полка стоит на высоте бордюра над дорогой. Дальше земля уходит под
 * постоянным углом откоса и КОНЧАЕТСЯ, догнав нетронутый рельеф: отсюда
 * чёткий край насыпи вместо размазанного вала.
 */
export function shelfHeight(world: World, x: number, z: number, outward: number): number {
  const natural = world.terrain(x, z);
  const near = nearestRoad(world, x, z);
  if (near === null) return natural;

  const shelf = near.roadHeight + near.curb;
  const free = Math.max(0, outward);
  return Math.min(shelf + free / CUT_SLOPE, Math.max(shelf - free / FILL_SLOPE, natural));
}

/**
 * То же самое, когда край мощёной части считать некому: край берётся по
 * расстоянию до осевой линии. Годится для предпросмотра одной дороги.
 */
export function groundHeightAt(world: World, x: number, z: number): number {
  const near = nearestRoad(world, x, z);
  if (near === null) return world.terrain(x, z);
  return shelfHeight(world, x, z, Math.max(0, near.distance - near.outerHalf));
}

/**
 * Привязка точки к существующей сети — то, чем инструмент помогает игроку.
 * Рядом с узлом прилипаем к узлу, рядом со свободным торцом — к торцу,
 * рядом с осевой линией — на линию (получится примыкание).
 */
export interface Snap {
  readonly point: Point2;
  readonly kind: 'узел' | 'торец' | 'дорога';
}

export function snapPoint(world: World, x: number, z: number, radius: number): Snap | null {
  let best: { snap: Snap; score: number } | null = null;
  const offer = (point: Point2, kind: Snap['kind'], distance: number, pull: number): void => {
    if (distance > radius) return;
    const score = distance - pull;
    if (best === null || score < best.score) best = { snap: { point, kind }, score };
  };

  for (const j of world.junctions) {
    offer({ x: j.x, z: j.z }, 'узел', Math.hypot(x - j.x, z - j.z), radius * 0.55);
  }

  for (const shape of world.shapes) {
    const st = shape.stations;
    for (const tip of [st[0], st[st.length - 1]]) {
      const atNode = world.junctions.some((j) => Math.hypot(tip.x - j.x, tip.z - j.z) < 1);
      if (atNode) continue;
      offer({ x: tip.x, z: tip.z }, 'торец', Math.hypot(x - tip.x, z - tip.z), radius * 0.4);
    }
    for (let i = 0; i + 1 < st.length; i++) {
      const dx = st[i + 1].x - st[i].x, dz = st[i + 1].z - st[i].z;
      const lenSq = dx * dx + dz * dz;
      if (lenSq < 1e-9) continue;
      let t = ((x - st[i].x) * dx + (z - st[i].z) * dz) / lenSq;
      t = Math.max(0, Math.min(1, t));
      const px = st[i].x + dx * t, pz = st[i].z + dz * t;
      offer({ x: px, z: pz }, 'дорога', Math.hypot(x - px, z - pz), 0);
    }
  }
  return best === null ? null : (best as { snap: Snap }).snap;
}
