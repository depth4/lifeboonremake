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
import { box, corridor, densify, grow, inside, intersect, union, unionAll } from './clip.ts';
import { CURB_FOOT, CURB_TOP, GROUND, MeshBuilder, ROAD, SHELF, carvePlane } from './mesh.ts';
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
/** На сколько краска лежит выше асфальта. */
const PAINT_LIFT = 0.02;
/** Пешеходный переход: длина полосок вдоль дороги и их ширина поперёк. */
const CROSS_LENGTH = 3.4;
const CROSS_STRIPE = 0.55;
/** Стоп-линия: ширина и отступ за переходом. */
const STOP_WIDTH = 0.4;
const STOP_GAP = 0.7;
/**
 * Где ставить точки на откосе — долями пути до его края.
 * Единица — сам край, где насыпь догнала нетронутую землю: там перелом,
 * и без точки ровно на нём перелом размазался бы в пологую дугу.
 * Числа больше единицы — уже нетронутая земля сразу за краем.
 */
const SLOPE_STOPS = [0.3, 0.62, 0.85, 1, 1.12, 1.4];
/** Дальше этого откос не ищем: столько метров земли не бывает даже в горах. */
const SLOPE_LIMIT = 90;

/** Скругление внутренних углов: расширить контур наружу и сжать обратно. */
function closeCorners(region: Region, radius: number): Region {
  if (region.length === 0 || radius <= 0) return region;
  return grow(grow(region, radius), -radius);
}

const lineOf = (shape: World['shapes'][number]): Point2[] =>
  shape.stations.map((st) => ({ x: st.x, z: st.z }));

/**
 * Раскладка покрытия по областям. Отдельно от треугольников, потому что это
 * отдельный вопрос: ЧТО где лежит, а не из скольких треугольников оно сделано.
 * Проверки смотрят прямо сюда.
 */
export interface Plan {
  readonly paved: Region;
  readonly outer: Region;
  readonly meeting: Region;
}

export function plan(world: World): Plan {
  // Мир — квадрат. Всё мощёное обрезается по нему, поэтому «край мира»
  // ровно один: у земли и у дороги он не может оказаться разным.
  const edge = box(WORLD_HALF);

  const corridors = world.shapes.map((s) => corridor(lineOf(s), s.halfWidth));
  const paved = intersect(closeCorners(unionAll(corridors), CORNER_RADIUS), edge);

  // Тротуар выведен из асфальта: «всё, что не дальше своей ширины от асфальта».
  // Поэтому его ширина одинакова везде, включая скруглённый угол перекрёстка,
  // и он не может ни оторваться от дороги, ни налезть на соседнюю.
  const narrowest = world.shapes.reduce((w, s) => Math.min(w, s.type.sidewalk), Infinity);
  const outer = world.shapes.length === 0 ? [] : intersect(union(
    grow(paved, Number.isFinite(narrowest) ? narrowest : 0),
    unionAll(world.shapes.map((s) => grow(corridor(lineOf(s), s.halfWidth), s.type.sidewalk))),
  ), edge);

  // Перекрёсток — это НЕ круг заданного радиуса. Это место, где коридоры
  // дорог накладываются друг на друга: его можно вычислить, а не назначить.
  const meeting = closeCorners(unionAll(overlaps(corridors)), CORNER_RADIUS);

  return { paved, outer, meeting };
}

export function buildSurface(world: World): Surface {
  const { paved, outer, meeting } = plan(world);

  // --- 2. Границы: короткими рёбрами, иначе край дороги врёт про высоту ---
  const edgePaved = densify(paved, MAX_EDGE);
  const edgeOuter = densify(outer, MAX_EDGE);
  const edgeBox = densify(box(WORLD_HALF), GRID_STEP);

  // --- 3. Точки внутри: без них поверхность натянулась бы между краями ---
  // «Сколько метров наружу от тротуара» считается по ТОЙ ЖЕ границе, которая
  // тротуар и рисует. Поэтому полка и её край совпадают всегда.
  const outward = outwardDistance(edgeOuter, inside(outer));
  const shelfY = (x: number, z: number): number => shelfHeight(world, x, z, outward(x, z));
  const roadY = (x: number, z: number): number => roadHeightAt(world, x, z);

  const interior: Point2[] = [];
  for (const shape of world.shapes) {
    for (const st of shape.stations) {
      for (const k of [-0.62, -0.2, 0.2, 0.62]) {
        interior.push({ x: st.x + st.nx * shape.halfWidth * k, z: st.z + st.nz * shape.halfWidth * k });
      }
      for (const side of [1, -1]) {
        const reach = slopeReach(world, st, side, shape.outerHalf, shelfY);
        for (const stop of SLOPE_STOPS) {
          const off = side * (shape.outerHalf + reach * stop);
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
  const plane = carvePlane([edgePaved, edgeOuter, edgeBox], within, CLEARANCE);

  // --- 5. Из чего сделана поверхность в этом месте ---
  const inPaved = inside(paved);
  const inOuter = inside(outer);

  const mesh = new MeshBuilder();
  const cache = new Map<number, number>();
  const vertexAt = (i: number, level: number): number => {
    const key = i * 8 + level;
    const found = cache.get(key);
    if (found !== undefined) return found;
    const p = plane.points[i];
    const made = mesh.vertex(p.x, level === ROAD ? roadY(p.x, p.z) : shelfY(p.x, p.z), p.z, level);
    cache.set(key, made);
    return made;
  };

  // --- 6. Материал треугольника — по тому, куда попал его центр ---
  for (const f of plane.faces) {
    let material: Material;
    let level: number;
    if (inPaved(f.x, f.z)) {
      material = 'asphalt';
      level = ROAD;
    } else if (inOuter(f.x, f.z)) {
      material = 'sidewalk';
      level = SHELF;
    } else {
      // земля держит свой уровень вершин: тротуар — ровная полка, а земля
      // сразу за ним уходит откосом. Общие вершины размазали бы этот перелом
      // в пологий скат, и выемка перестала бы читаться выемкой.
      material = 'grass';
      level = GROUND;
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

  paint(mesh, world, inside(meeting), roadY);
  return mesh.build();
}

/**
 * Разметка — КРАСКА, а не вырез в асфальте.
 *
 * Раньше каждая линия была отдельным многоугольником шириной 16 см, который
 * участвовал в алгебре областей наравне с дорогой. Тонкие многоугольники,
 * которые режут и объединяют десятки раз, вырождаются: за одну ночь этот
 * класс ломался трижды — то самопересечением контура, то волоском в
 * миллиметр между областями. Правило 8: третий раз одно и то же не чинят,
 * чинят устройство.
 *
 * Теперь линии кладутся треугольниками ПОВЕРХ асфальта, на два сантиметра
 * выше него и по тому же профилю дороги. Они не участвуют ни в одной булевой
 * операции — вырождаться нечему. Обрыв у перекрёстка делается проверкой
 * станции, а не вычитанием области.
 *
 * Цена: разметка перестала быть частью замкнутой поверхности. Она ею и не
 * была по смыслу — это краска, лежащая сверху.
 */
function paint(
  mesh: MeshBuilder,
  world: World,
  inMeeting: (x: number, z: number) => boolean,
  roadY: (x: number, z: number) => number,
): void {
  const put = (corners: readonly Point2[]): void => {
    const v = corners.map((p) => mesh.loneVertex(p.x, roadY(p.x, p.z) + PAINT_LIFT, p.z));
    mesh.triUp('marking', v[0], v[1], v[2]);
    mesh.triUp('marking', v[0], v[2], v[3]);
  };

  for (const shape of world.shapes) {
    const st = shape.stations;

    // Продольные линии рвутся там, где дорога входит в перекрёсток.
    for (const band of bands(shape.type)) {
      if (band.kind !== 'marking') continue;
      const at = (i: number, off: number): Point2 => ({ x: st[i].x + st[i].nx * off, z: st[i].z + st[i].nz * off });
      for (let i = 0; i + 1 < st.length; i++) {
        if (inMeeting(st[i].x, st[i].z) || inMeeting(st[i + 1].x, st[i + 1].z)) continue;
        put([at(i, band.from), at(i, band.to), at(i + 1, band.to), at(i + 1, band.from)]);
      }
    }

    // Переходы и стоп-линии — у выхода дороги из перекрёстка.
    for (const atStart of [true, false]) {
      for (const ring of crosswalk(shape, atStart, inMeeting)) put(ring);
    }
  }
}

/**
 * Докуда тянется откос: сколько метров от края тротуара насыпь или выемка
 * идёт, прежде чем догонит нетронутую землю. Ищем делением пополам —
 * в этом месте у поверхности перелом, и его надо знать точно, а не примерно.
 */
function slopeReach(
  world: World,
  st: World['shapes'][number]['stations'][number],
  side: number,
  outerHalf: number,
  shelfY: (x: number, z: number) => number,
): number {
  const touched = (away: number): boolean => {
    const off = side * (outerHalf + away);
    const x = st.x + st.nx * off, z = st.z + st.nz * off;
    return Math.abs(shelfY(x, z) - world.terrain(x, z)) > 0.02;
  };
  if (!touched(0.2)) return 1.5;
  let lo = 0.2, hi = SLOPE_LIMIT;
  if (touched(hi)) return hi;
  for (let i = 0; i < 12; i++) {
    const mid = (lo + hi) / 2;
    if (touched(mid)) lo = mid;
    else hi = mid;
  }
  return hi;
}

/**
 * Где коридоры дорог накладываются друг на друга. Это и есть перекрёсток:
 * не круг подобранного радиуса, а вычисленное место встречи.
 * Пары, у которых даже рамки не пересекаются, не считаем — иначе на тридцати
 * дорогах пришлось бы делать полтысячи пересечений впустую.
 */
function overlaps(corridors: readonly Region[]): Region[] {
  const boxOf = (region: Region): [number, number, number, number] => {
    let x0 = Infinity, x1 = -Infinity, z0 = Infinity, z1 = -Infinity;
    for (const ring of region) for (const p of ring) {
      x0 = Math.min(x0, p.x); x1 = Math.max(x1, p.x);
      z0 = Math.min(z0, p.z); z1 = Math.max(z1, p.z);
    }
    return [x0, x1, z0, z1];
  };
  const boxes = corridors.map(boxOf);
  const out: Region[] = [];
  for (let i = 0; i < corridors.length; i++) {
    for (let j = i + 1; j < corridors.length; j++) {
      const a = boxes[i], b = boxes[j];
      if (a[1] < b[0] || b[1] < a[0] || a[3] < b[2] || b[3] < a[2]) continue;
      const hit = intersect(corridors[i], corridors[j]);
      if (hit.length > 0) out.push(hit);
    }
  }
  return out;
}

/**
 * Пешеходный переход со стоп-линией у выхода дороги из перекрёстка.
 *
 * Место не назначается числом: идём по станциям от торца, пока не выйдем
 * из перекрёстка, и ставим переход там. Стоп-линия — только на тех полосах,
 * по которым едут К перекрёстку; какие это полосы, видно из направления
 * движения в списке полос, а не из догадки.
 */
function crosswalk(
  shape: World['shapes'][number],
  atStart: boolean,
  inMeeting: (x: number, z: number) => boolean,
): Point2[][] {
  const st = shape.stations;
  const order = atStart ? st.map((_, i) => i) : st.map((_, i) => st.length - 1 - i);
  if (!inMeeting(st[order[0]].x, st[order[0]].z)) return [];

  const found = order.find((i) => !inMeeting(st[i].x, st[i].z));
  if (found === undefined) return [];
  const s = st[found];
  // наружу от перекрёстка
  const dir = atStart ? 1 : -1;
  const tx = s.nz * dir, tz = -s.nx * dir;

  const half = Math.max(1, shape.halfWidth - MARKING_INSET);
  const corner = (along: number, across: number): Point2 => ({
    x: s.x + tx * along + s.nx * across,
    z: s.z + tz * along + s.nz * across,
  });
  const patch = (a0: number, a1: number, o0: number, o1: number): Point2[] =>
    [corner(a0, o0), corner(a1, o0), corner(a1, o1), corner(a0, o1)];

  // полоски укладываются симметрично: считаем, сколько влезает, и центруем
  const rings: Point2[][] = [];
  const step = CROSS_STRIPE * 2;
  const count = Math.max(1, Math.floor((2 * half - CROSS_STRIPE) / step) + 1);
  const first = -((count - 1) * step + CROSS_STRIPE) / 2;
  for (let i = 0; i < count; i++) {
    const o = first + i * step;
    rings.push(patch(0.4, 0.4 + CROSS_LENGTH, o, o + CROSS_STRIPE));
  }

  // К перекрёстку едут те полосы, чьё направление ведёт внутрь. Движение
  // правостороннее, попутные полосы лежат в положительных смещениях: значит
  // у конца дороги стоп-линия справа от оси, у начала — слева.
  const stopFrom = atStart ? -half : 0;
  const stopTo = atStart ? 0 : half;
  const stopAt = 0.4 + CROSS_LENGTH + STOP_GAP;
  rings.push(patch(stopAt, stopAt + STOP_WIDTH, stopFrom, stopTo));
  return rings;
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
