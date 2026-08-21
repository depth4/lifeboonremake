/**
 * Мир целиком: рельеф + дороги.
 * Здесь живёт единственный ответ на вопрос «какая высота земли в этой точке».
 * Про экран этот файл не знает ничего — его можно считать без браузера.
 */

import { naturalHeight } from './terrain.ts';
import type { Road, Station } from './road.ts';
import { roadWidth, sampleCenterline } from './road.ts';

/** Ширина насыпи: на сколько метров в стороны земля тянется за дорогой. */
const EMBANKMENT = 9;

/** Дорога, разложенная в точки: где идёт и на какой высоте. */
export interface RoadShape {
  readonly road: Road;
  readonly stations: readonly Station[];
  /** высота дороги в каждой станции */
  readonly height: readonly number[];
  readonly halfWidth: number;
}

export interface World {
  readonly shapes: readonly RoadShape[];
}

/**
 * Высота дороги — это сглаженный рельеф под ней.
 * Настоящая дорога не повторяет каждый бугор: она их срезает и засыпает.
 */
function heightProfile(stations: readonly Station[]): number[] {
  const raw = stations.map((st) => naturalHeight(st.x, st.z));
  const window = 12;
  return raw.map((_, i) => {
    let sum = 0;
    let n = 0;
    for (let k = -window; k <= window; k++) {
      const j = i + k;
      if (j >= 0 && j < raw.length) {
        sum += raw[j];
        n++;
      }
    }
    return sum / n;
  });
}

export function buildWorld(roads: readonly Road[]): World {
  const shapes = roads.map((road) => {
    const stations = sampleCenterline(road, 2);
    return {
      road,
      stations,
      height: heightProfile(stations),
      halfWidth: roadWidth(road.type) / 2,
    };
  });
  return { shapes };
}

/** Насколько точка близка к дороге и какая там высота дороги. */
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
      const bx = st[i + 1].x, bz = st[i + 1].z;
      const dx = bx - ax, dz = bz - az;
      const lenSq = dx * dx + dz * dz;
      let t = lenSq > 0 ? ((x - ax) * dx + (z - az) * dz) / lenSq : 0;
      t = Math.max(0, Math.min(1, t));
      const px = ax + dx * t, pz = az + dz * t;
      const distance = Math.hypot(x - px, z - pz);
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

function smoothstep(t: number): number {
  const c = Math.max(0, Math.min(1, t));
  return c * c * (3 - 2 * c);
}

/**
 * Единственный источник правды о высоте земли.
 * Под дорогой земля равна дороге — поэтому «земля торчит сквозь дорогу»
 * не может случиться: это одна и та же высота.
 */
export function groundHeightAt(world: World, x: number, z: number): number {
  const near = nearestRoad(world, x, z);
  const natural = naturalHeight(x, z);
  if (near === null) return natural;

  const inner = near.halfWidth;
  const outer = near.halfWidth + EMBANKMENT;
  if (near.distance <= inner) return near.roadHeight;
  if (near.distance >= outer) return natural;

  const t = smoothstep((near.distance - inner) / (outer - inner));
  return near.roadHeight * (1 - t) + natural * t;
}
