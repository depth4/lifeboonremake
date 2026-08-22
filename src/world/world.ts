/**
 * Мир целиком: рельеф + дороги.
 * Здесь живёт единственный ответ на вопрос «какая высота земли в этой точке».
 * Про экран этот файл не знает ничего — его можно считать без браузера.
 */

import type { Road, Station } from './road.ts';
import type { Terrain } from './terrain.ts';
import { roadWidth, sampleCenterline } from './road.ts';
import { DEFAULT_TERRAIN, TERRAINS } from './terrain.ts';

/**
 * Предельный продольный уклон дороги.
 * Настоящие нормы: магистраль 4–6%, сложный рельеф 8–12%, местные до 15%.
 * Дорога НЕ повторяет рельеф — она держит свой уклон, а земля подстраивается.
 * Позже станет свойством типа дороги.
 */
export const MAX_GRADE = 0.08;

/**
 * Крутизна откосов: метров по горизонтали на метр по вертикали.
 * Выемка круче насыпи — так и в настоящем строительстве (1.5:1 против 2:1).
 * Земля идёт от дороги под этим углом и КОНЧАЕТСЯ, встретив нетронутую землю.
 */
const CUT_SLOPE = 1.5;
const FILL_SLOPE = 2.0;

/** Сколько раз прогоняем ограничение уклона и сглаживание переломов. */
const LIMIT_PASSES = 8;
const SMOOTH_PASSES = 25;

export interface RoadShape {
  readonly road: Road;
  readonly stations: readonly Station[];
  /** высота дороги в каждой станции */
  readonly height: readonly number[];
  readonly halfWidth: number;
  /** самый крутой участок этой дороги, доля (0.08 = 8%) */
  readonly grade: number;
  /** насколько дорога дальше всего отошла от земли, метры */
  readonly lift: number;
}

export interface World {
  readonly shapes: readonly RoadShape[];
  readonly terrain: Terrain;
  /** самый крутой участок среди всех дорог */
  readonly grade: number;
  /** самый большой отрыв дороги от земли: где нужен мост или тоннель */
  readonly lift: number;
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
 * После этого дорога круче предела быть НЕ МОЖЕТ — не потому что мы проверили,
 * а потому что такое состояние здесь нельзя записать.
 */
function limitGrade(stations: readonly Station[], h: number[]): void {
  for (let pass = 0; pass < LIMIT_PASSES; pass++) {
    for (let i = 1; i < h.length; i++) {
      const d = (stations[i].s - stations[i - 1].s) * MAX_GRADE;
      h[i] = Math.min(h[i - 1] + d, Math.max(h[i - 1] - d, h[i]));
    }
    for (let i = h.length - 2; i >= 0; i--) {
      const d = (stations[i + 1].s - stations[i].s) * MAX_GRADE;
      h[i] = Math.min(h[i + 1] + d, Math.max(h[i + 1] - d, h[i]));
    }
  }
}

/** Сглаживание переломов. Уклон от него только уменьшается, поэтому предел цел. */
function smooth(h: number[]): void {
  for (let pass = 0; pass < SMOOTH_PASSES; pass++) {
    const prev = h.slice();
    for (let i = 1; i < h.length - 1; i++) h[i] = (prev[i - 1] + 2 * prev[i] + prev[i + 1]) / 4;
  }
}

/**
 * Продольный профиль дороги.
 *
 * Настоящую дорогу проектируют так: задают её собственную линию высоты
 * с ограниченным уклоном, а землю потом режут и сыплют под неё.
 * Здесь то же самое: берём рельеф, прижимаем к пределу уклона, потом
 * скругляем переломы — получаются те самые прямые уклоны, сшитые кривыми.
 *
 * Там, где земля круче предела, дорога от неё отрывается. Насколько —
 * видно в `lift`. Большой отрыв означает, что здесь нужен мост или тоннель,
 * а не земляные работы.
 */
function profile(stations: readonly Station[], terrain: Terrain): number[] {
  const h = stations.map((st) => terrain(st.x, st.z));
  limitGrade(stations, h);
  smooth(h);
  limitGrade(stations, h);
  return h;
}

export function buildWorld(roads: readonly Road[], terrainName: string = DEFAULT_TERRAIN): World {
  const terrain = (TERRAINS[terrainName] ?? TERRAINS[DEFAULT_TERRAIN]).height;

  const shapes = roads.map((road) => {
    const stations = sampleCenterline(road, 2);
    const height = profile(stations, terrain);
    const lift = stations.reduce((m, st, i) => Math.max(m, Math.abs(height[i] - terrain(st.x, st.z))), 0);
    return {
      road,
      stations,
      height,
      halfWidth: roadWidth(road.type) / 2,
      grade: steepest(stations, height),
      lift,
    };
  });

  return {
    shapes,
    terrain,
    grade: shapes.reduce((g, s) => Math.max(g, s.grade), 0),
    lift: shapes.reduce((l, s) => Math.max(l, s.lift), 0),
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
  return best;
}

/**
 * Единственный источник правды о высоте земли.
 *
 * Под дорогой земля равна дороге — поэтому «земля торчит сквозь дорогу»
 * не может случиться: это одна и та же высота. В стороны земля уходит
 * под постоянным углом откоса и КОНЧАЕТСЯ, как только догонит нетронутую
 * землю. Отсюда чёткий край насыпи вместо размазанного вала.
 */
export function groundHeightAt(world: World, x: number, z: number): number {
  const natural = world.terrain(x, z);
  const near = nearestRoad(world, x, z);
  if (near === null) return natural;

  const free = Math.max(0, near.distance - near.halfWidth);
  const canRise = free / CUT_SLOPE;
  const canDrop = free / FILL_SLOPE;
  return Math.min(near.roadHeight + canRise, Math.max(near.roadHeight - canDrop, natural));
}
