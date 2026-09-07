/**
 * ВАРИАНТ A — «единый раскрой плоскости».
 *
 * Город замощён плоскими областями. Асфальт — это объединение коридоров вдоль
 * осевых линий; перекрёсток никто не строит, он ПОЛУЧАЕТСЯ сам. Тротуар —
 * это «всё, что в двух метрах от асфальта», то есть он выведен из асфальта
 * и разойтись с ним не может. Разметка лежит строго внутри асфальта.
 *
 * Плоскость режется на треугольники ОДИН раз, все границы идут в раскрой
 * обязательными рёбрами, а материал треугольника выясняется потом — по тому,
 * куда попал его центр.
 *
 * Что из этого следует:
 *   — дорога впадает в дорогу идеально, потому что стыка нет: это одна область;
 *   — тротуар не может «торчать» на остром угле: он не самостоятельная лента,
 *     а окрестность асфальта;
 *   — щель между областями невыразима: границы у них общие, точка в точку;
 *   — ручной сшивки торцов, подрезки и площадок нет — нет и их поломок.
 *
 * Высота берётся из мира и здесь нигде не выдумывается.
 */

import type { Point2 } from '../world/road.ts';
import type { World } from '../world/world.ts';
import type { Region } from './clip.ts';
import type { Surface } from './mesh.ts';
import { bands } from '../world/road.ts';
import { WORLD_HALF } from '../world/terrain.ts';
import { roadHeightAt, shelfHeight } from '../world/world.ts';
import { box, corridor, densify, disc, grow, inside, intersect, subtract, union, unionAll } from './clip.ts';
import { CURB_FOOT, CURB_TOP, MeshBuilder, ROAD, SHELF, carvePlane } from './mesh.ts';
import type { Material } from './mesh.ts';

/**
 * Радиус скругления угла перекрёстка. У настоящих городских улиц 5–9 метров.
 * Скругление делается расширением контура наружу и обратным сжатием: приём
 * убирает острые внутренние углы, оставляя внешние на месте.
 */
const CORNER_RADIUS = 6;
/** Длиннее этого ребра границы не бывает: иначе край дороги врёт про высоту. */
const MAX_EDGE = 4;
/** Шаг сетки земли, метры. */
const GRID_STEP = 4;
/** Насколько точки сетки сбиты с ровных мест, доля шага. */
const WOBBLE = 0.34;
/** Ближе этого к границе внутренние точки не ставим: там рождаются иглы. */
const CLEARANCE = 0.7;
/** Насколько разметка не доходит до края асфальта. */
const MARKING_INSET = 0.5;
/** На каких расстояниях наружу от тротуара ставим точки вдоль откоса. */
const SLOPE_RINGS = [0.9, 2.5, 5, 9, 14, 20, 28, 38];

/** Скругление внутренних углов: расширить контур наружу и сжать обратно. */
function closeCorners(region: Region, radius: number): Region {
  if (region.length === 0 || radius <= 0) return region;
  return grow(grow(region, radius), -radius);
}

const lineOf = (shape: World['shapes'][number]): Point2[] =>
  shape.stations.map((st) => ({ x: st.x, z: st.z }));

export function buildSurface(world: World): Surface {
  // Мир — квадрат. Всё мощёное обрезается по нему, поэтому «край мира»
  // ровно один: у земли и у дороги он не может оказаться разным.
  const edge = box(WORLD_HALF);

  // --- 1. Области ---
  const paved = intersect(closeCorners(
    unionAll(world.shapes.map((s) => corridor(lineOf(s), s.halfWidth))),
    CORNER_RADIUS,
  ), edge);

  // Тротуар выведен из асфальта: «всё, что не дальше своей ширины от асфальта».
  // Поэтому его ширина одинакова везде, включая скруглённый угол перекрёстка,
  // и он не может ни оторваться от дороги, ни налезть на соседнюю.
  const narrowest = world.shapes.reduce((w, s) => Math.min(w, s.type.sidewalk), Infinity);
  const outer = world.shapes.length === 0 ? [] : intersect(union(
    grow(paved, Number.isFinite(narrowest) ? narrowest : 0),
    unionAll(world.shapes.map((s) => grow(corridor(lineOf(s), s.halfWidth), s.type.sidewalk))),
  ), edge);

  // Разметка: тонкие полосы вдоль границ полос, отступившие от края асфальта
  // и убранные с перекрёстков — там разметка идёт иначе, это отдельная тема.
  const stripes: Region[] = [];
  for (const shape of world.shapes) {
    for (const band of bands(shape.type)) {
      if (band.kind !== 'marking') continue;
      const middle = (band.from + band.to) / 2;
      const width = band.to - band.from;
      const shifted = shape.stations.map((st) => ({ x: st.x + st.nx * middle, z: st.z + st.nz * middle }));
      stripes.push(corridor(shifted, width / 2));
    }
  }
  let marking = intersect(unionAll(stripes), grow(paved, -MARKING_INSET));
  for (const j of world.junctions) {
    marking = subtract(marking, disc({ x: j.x, z: j.z }, junctionRadius(world, j)));
  }

  // --- 2. Границы: короткими рёбрами, иначе край дороги врёт про высоту ---
  const edgePaved = densify(paved, MAX_EDGE);
  const edgeOuter = densify(outer, MAX_EDGE);
  const edgeMark = densify(marking, MAX_EDGE);
  const edgeBox = densify(edge, GRID_STEP);

  // --- 3. Точки внутри: без них поверхность натянулась бы между краями ---
  const interior: Point2[] = [];
  for (const shape of world.shapes) {
    for (const st of shape.stations) {
      for (const k of [-0.62, -0.2, 0.2, 0.62]) {
        interior.push({ x: st.x + st.nx * shape.halfWidth * k, z: st.z + st.nz * shape.halfWidth * k });
      }
      for (const away of SLOPE_RINGS) {
        for (const side of [1, -1]) {
          const off = side * (shape.outerHalf + away);
          interior.push({ x: st.x + st.nx * off, z: st.z + st.nz * off });
        }
      }
    }
  }
  // Сетка нарочно неровная. На идеально ровной сетке целый столбец точек лежит
  // на одной прямой, и в раскрое заводятся треугольники нулевой площади: их
  // потом нечем починить, потому что у них нет описанной окружности. Сбитая
  // сетка делает точное совпадение трёх точек на прямой невозможным — и заодно
  // трава перестаёт бликовать полосами.
  const steps = Math.round((WORLD_HALF * 2) / GRID_STEP);
  const wobble = (i: number, j: number): number => {
    const h = Math.sin(i * 127.1 + j * 311.7) * 43758.545;
    return (h - Math.floor(h) - 0.5) * 2 * WOBBLE * GRID_STEP;
  };
  for (let i = 1; i < steps; i++) {
    for (let j = 1; j < steps; j++) {
      interior.push({
        x: -WORLD_HALF + i * GRID_STEP + wobble(i, j),
        z: -WORLD_HALF + j * GRID_STEP + wobble(j + 1000, i),
      });
    }
  }

  // --- 4. Один раскрой на всё ---
  // За краем мира точек не существует: тогда внешняя граница раскроя — ровно
  // квадрат мира, и треугольников, торчащих наружу, взяться неоткуда.
  const within = interior.filter((p) => Math.abs(p.x) < WORLD_HALF && Math.abs(p.z) < WORLD_HALF);
  const plane = carvePlane([edgePaved, edgeOuter, edgeMark, edgeBox], within, CLEARANCE);

  // --- 5. Высоты ---
  // «Сколько метров наружу от тротуара» считается по ТОЙ ЖЕ границе, которая
  // тротуар и рисует. Поэтому полка и её край совпадают всегда.
  const outward = outwardDistance(edgeOuter, inside(outer));
  const inPaved = inside(paved);
  const inOuter = inside(outer);
  const inMark = inside(marking);

  const roadY = (x: number, z: number): number => roadHeightAt(world, x, z);
  const shelfY = (x: number, z: number): number => shelfHeight(world, x, z, outward(x, z));

  const mesh = new MeshBuilder();
  const roadVertex = new Map<number, number>();
  const shelfVertex = new Map<number, number>();
  const vertexAt = (i: number, level: number): number => {
    const cache = level === ROAD ? roadVertex : shelfVertex;
    const found = cache.get(i);
    if (found !== undefined) return found;
    const p = plane.points[i];
    const made = mesh.vertex(p.x, level === ROAD ? roadY(p.x, p.z) : shelfY(p.x, p.z), p.z, level);
    cache.set(i, made);
    return made;
  };

  // --- 6. Материал треугольника — по тому, куда попал его центр ---
  for (const f of plane.faces) {
    let material: Material;
    let level: number;
    if (inPaved(f.x, f.z)) {
      material = inMark(f.x, f.z) ? 'marking' : 'asphalt';
      level = ROAD;
    } else if (inOuter(f.x, f.z)) {
      material = 'sidewalk';
      level = SHELF;
    } else {
      material = 'grass';
      level = SHELF;
    }
    mesh.triUp(material, vertexAt(f.a, level), vertexAt(f.b, level), vertexAt(f.c, level));
  }

  // --- 7. Бордюр: стенка по границе асфальта, точка в точку с раскроем ---
  for (const ring of edgePaved) {
    for (let i = 0; i < ring.length; i++) {
      const a = ring[i], b = ring[(i + 1) % ring.length];
      if (Math.hypot(b.x - a.x, b.z - a.z) < 1e-6) continue;
      mesh.wall(
        'curb',
        mesh.vertex(a.x, roadY(a.x, a.z), a.z, CURB_FOOT),
        mesh.vertex(b.x, roadY(b.x, b.z), b.z, CURB_FOOT),
        mesh.vertex(a.x, shelfY(a.x, a.z), a.z, CURB_TOP),
        mesh.vertex(b.x, shelfY(b.x, b.z), b.z, CURB_TOP),
        { x: (a.x + b.x) / 2, z: (a.z + b.z) / 2 },
      );
    }
  }

  return mesh.build();
}

/** Радиус, в котором перекрёсток считается перекрёстком. */
function junctionRadius(world: World, j: World['junctions'][number]): number {
  let widest = 0;
  for (const shape of world.shapes) {
    const st = shape.stations;
    for (const tip of [st[0], st[st.length - 1]]) {
      if (Math.hypot(tip.x - j.x, tip.z - j.z) < 1) widest = Math.max(widest, shape.halfWidth);
    }
  }
  return widest * 1.6 + 2;
}

/**
 * Расстояние наружу от области: ноль внутри, метры до границы снаружи.
 * Считается по отрезкам границы, разложенным по клеткам, с расширением поиска,
 * пока найденное не станет заведомо ближайшим.
 */
function outwardDistance(border: Region, isInside: (x: number, z: number) => boolean) {
  const CELL = 8;
  const buckets = new Map<string, number[]>();
  const put = (i: number, j: number, seg: number[]): void => {
    const key = `${i},${j}`;
    const list = buckets.get(key);
    if (list) list.push(...seg);
    else buckets.set(key, [...seg]);
  };
  for (const ring of border) {
    for (let i = 0; i < ring.length; i++) {
      const a = ring[i], b = ring[(i + 1) % ring.length];
      const seg = [a.x, a.z, b.x, b.z];
      const i0 = Math.floor(Math.min(a.x, b.x) / CELL), i1 = Math.floor(Math.max(a.x, b.x) / CELL);
      const j0 = Math.floor(Math.min(a.z, b.z) / CELL), j1 = Math.floor(Math.max(a.z, b.z) / CELL);
      for (let ii = i0; ii <= i1; ii++) for (let jj = j0; jj <= j1; jj++) put(ii, jj, seg);
    }
  }

  return (x: number, z: number): number => {
    if (isInside(x, z)) return 0;
    if (buckets.size === 0) return Infinity;
    const ci = Math.floor(x / CELL), cj = Math.floor(z / CELL);
    let best = Infinity;
    for (let r = 0; r < 200; r++) {
      for (let i = ci - r; i <= ci + r; i++) {
        for (let j = cj - r; j <= cj + r; j++) {
          if (r > 0 && Math.abs(i - ci) !== r && Math.abs(j - cj) !== r) continue;
          const list = buckets.get(`${i},${j}`);
          if (!list) continue;
          for (let k = 0; k < list.length; k += 4) {
            const ax = list[k], az = list[k + 1], dx = list[k + 2] - ax, dz = list[k + 3] - az;
            const lenSq = dx * dx + dz * dz;
            let t = lenSq > 0 ? ((x - ax) * dx + (z - az) * dz) / lenSq : 0;
            t = t < 0 ? 0 : t > 1 ? 1 : t;
            best = Math.min(best, Math.hypot(x - (ax + dx * t), z - (az + dz * t)));
          }
        }
      }
      if (best <= r * CELL) return best;
    }
    return best;
  };
}
