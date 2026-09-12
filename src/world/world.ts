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
import { limitCurvature, resample, roadWidth, stationsFromLine } from './road.ts';
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

/** Сколько раз послабление проходит по поперечным связям высот. */
const RELAX_PASSES = 400;
const SMOOTH_PASSES = 12;

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
  /** номера узлов сети на концах участка: где он начинается и где кончается */
  readonly from: number;
  readonly to: number;
}

/**
 * Узел: место, где сходятся дороги. Ни формы площадки, ни своей высоты у него
 * нет — высота в любой точке спрашивается у полотна, и другого ответа не бывает.
 */
export interface Junction {
  readonly x: number;
  readonly z: number;
  readonly degree: number;
}

export interface World {
  readonly shapes: readonly RoadShape[];
  readonly junctions: readonly Junction[];
  /** Сколько узлов в сети всего — включая простые концы дорог. */
  readonly nodeCount: number;
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

/**
 * Связь между двумя точками полотна: их высоты не могут разойтись сильнее,
 * чем на `allowed` метров.
 */
interface Link {
  readonly a: number;
  readonly b: number;
  readonly allowed: number;
}

/** Цепочка точек вдоль одной дороги: по ней предел уклона выполняется точно. */
interface Chain {
  readonly from: number;
  readonly count: number;
  readonly steps: readonly number[];
}

/**
 * Высоты всего полотна разом.
 *
 * ОДНО правило вместо двух. Раньше предельный уклон держали только ВДОЛЬ
 * каждой дороги, а поперёк — никто. Две дороги, идущие рядом под малым углом,
 * могли разойтись по высоте на три метра при пяти метрах между ними: полотно
 * вставало ступенькой в 60%, и никакая проверка этого не видела.
 *
 * Теперь правило звучит так: **любые две точки полотна, отстоящие друг от
 * друга на d метров, различаются по высоте не больше чем на d × предельный
 * уклон** — вдоль дороги, поперёк, между разными дорогами, всё равно.
 * «Полотно встало стеной» перестало быть выразимым.
 *
 * Решается послаблением: пока какая-то связь нарушена, обе её точки
 * подтягиваются навстречу. Точки, сошедшиеся в узле сети, — одна и та же
 * точка, у них связь с нулевым запасом.
 */
function solveHeights(
  places: readonly Point2[],
  chains: readonly Chain[],
  links: readonly Link[],
  terrain: Terrain,
): number[] {
  const wanted = places.map((p) => terrain(p.x, p.z));

  /**
   * Сколько получится, если ТОЛЬКО срезать: каждая точка опускается до
   * самой низкой, до которой можно дойти по связям, плюс разрешённый подъём.
   * Величина только убывает, поэтому счёт заведомо сходится.
   */
  const shave = (sign: number): number[] => {
    const h = wanted.map((v) => v * sign);
    const sweepChains = (): boolean => {
      let moved = false;
      for (const chain of chains) {
        for (let i = 1; i < chain.count; i++) {
          const a = chain.from + i - 1, b = chain.from + i;
          const limit = h[a] + chain.steps[i - 1] * MAX_GRADE;
          if (h[b] > limit) { h[b] = limit; moved = true; }
        }
        for (let i = chain.count - 2; i >= 0; i--) {
          const a = chain.from + i + 1, b = chain.from + i;
          const limit = h[a] + chain.steps[i] * MAX_GRADE;
          if (h[b] > limit) { h[b] = limit; moved = true; }
        }
      }
      return moved;
    };

    for (let pass = 0; pass < RELAX_PASSES; pass++) {
      let moved = sweepChains();
      for (const link of links) {
        if (h[link.b] > h[link.a] + link.allowed) { h[link.b] = h[link.a] + link.allowed; moved = true; }
        if (h[link.a] > h[link.b] + link.allowed) { h[link.a] = h[link.b] + link.allowed; moved = true; }
      }
      if (!moved) break;
    }
    // последним словом всегда предел ВДОЛЬ дороги: он — обещание, которое
    // видно игроку, а поперечные связи только помогают его выполнить
    while (sweepChains());
    return h.map((v) => v * sign);
  };

  // Срезать (сверху) и засыпать (снизу) — не два действия, а одно правило,
  // применённое в две стороны. Полотно ложится ровно между ними, поэтому
  // земляных работ поровну, а предел уклона выполняется по построению:
  // среднее двух функций с ограниченным наклоном тоже имеет его ограниченным.
  const cut = shave(1);
  const fill = shave(-1);
  const h = cut.map((v, i) => (v + fill[i]) / 2);

  // Сглаживание переломов — и сразу же принуждение к пределу. Сглаживание
  // не трогает концы цепочки, а соседа с краю двигает: на коротком последнем
  // отрезке в полметра это давало уклон в 26% при пределе восемь. Предел
  // должен быть последним словом всегда, иначе он не предел.
  for (const chain of chains) {
    for (let pass = 0; pass < SMOOTH_PASSES; pass++) {
      const prev = h.slice(chain.from, chain.from + chain.count);
      for (let i = 1; i < chain.count - 1; i++) {
        h[chain.from + i] = (prev[i - 1] + 2 * prev[i] + prev[i + 1]) / 4;
      }
    }
  }
  for (let pass = 0; pass < RELAX_PASSES; pass++) {
    let moved = false;
    for (const chain of chains) {
      for (let i = 1; i < chain.count; i++) {
        const a = chain.from + i - 1, b = chain.from + i;
        const d = chain.steps[i - 1] * MAX_GRADE;
        const was = h[b];
        h[b] = Math.min(h[a] + d, Math.max(h[a] - d, h[b]));
        if (h[b] !== was) moved = true;
      }
      for (let i = chain.count - 2; i >= 0; i--) {
        const a = chain.from + i + 1, b = chain.from + i;
        const d = chain.steps[i] * MAX_GRADE;
        const was = h[b];
        h[b] = Math.min(h[a] + d, Math.max(h[a] - d, h[b]));
        if (h[b] !== was) moved = true;
      }
    }
    if (!moved) break;
  }
  return h;
}

export function buildWorld(roads: readonly Road[], terrainName: string = DEFAULT_TERRAIN): World {
  const terrain = (TERRAINS[terrainName] ?? TERRAINS[DEFAULT_TERRAIN]).height;
  const net = planarize(roads);
  // Предел поворота. У настоящей городской улицы минимальный радиус 15–25 м;
  // у нас это три полуширины полотна — 18 метров для дороги шириной 12.
  // Круче дорога завернуть не может: внутренний край полотна начинает
  // заворачиваться сам на себя, поверхность встаёт пандусом, и на ней
  // появляется ступенька. Измерено: до 166% при пределе уклона 8%.
  const lines = net.edges.map((edge) => {
    const outerHalf = roadWidth(edge.type) / 2 + edge.type.sidewalk;
    // ровный шаг — до предела поворота: иначе радиус из трёх соседних точек
    // ничего не значит и предел не срабатывает
    return stationsFromLine(limitCurvature(resample(edge.line, STATION_STEP), outerHalf * 3));
  });

  // Все точки полотна в один список: дальше они связываются между собой
  // независимо от того, какой дороге принадлежат.
  const places: Point2[] = [];
  const first: number[] = [];
  const widths: number[] = [];
  net.edges.forEach((edge, e) => {
    first.push(places.length);
    const half = roadWidth(edge.type) / 2 + edge.type.sidewalk;
    for (const st of lines[e]) {
      places.push({ x: st.x, z: st.z });
      widths.push(half);
    }
  });

  const links: Link[] = [];
  const chains: Chain[] = lines.map((st, e) => ({
    from: first[e],
    count: st.length,
    steps: st.slice(1).map((s, i) => s.s - st[i].s),
  }));
  // концы, сошедшиеся в одном узле, — одна и та же точка
  const atNode = new Map<number, number[]>();
  net.edges.forEach((edge, e) => {
    for (const [node, at] of [[edge.from, first[e]], [edge.to, first[e] + lines[e].length - 1]] as const) {
      const list = atNode.get(node);
      if (list) list.push(at);
      else atNode.set(node, [at]);
    }
  });
  for (const list of atNode.values()) {
    for (let i = 1; i < list.length; i++) links.push({ a: list[0], b: list[i], allowed: 0 });
  }
  // поперёк: точки разных дорог, оказавшиеся рядом. Клетки — чтобы не
  // перебирать миллион пар на большой сцене.
  const CROSS = places.reduce((w, _, i) => Math.max(w, widths[i]), 0) * 2 + 4;
  if (CROSS > 0 && places.length > 1) {
    const cells = new Map<number, number[]>();
    const key = (x: number, z: number): number =>
      (Math.floor(x / CROSS) + 4096) * 8192 + Math.floor(z / CROSS) + 4096;
    places.forEach((p, i) => {
      const k = key(p.x, p.z);
      const list = cells.get(k);
      if (list) list.push(i);
      else cells.set(k, [i]);
    });
    const roadOf = new Int32Array(places.length);
    const along = new Float64Array(places.length);
    lines.forEach((st, e) => {
      for (let i = 0; i < st.length; i++) {
        roadOf[first[e] + i] = e;
        along[first[e] + i] = st[i].s;
      }
    });

    places.forEach((p, i) => {
      const ci = Math.floor(p.x / CROSS), cj = Math.floor(p.z / CROSS);
      for (let di = -1; di <= 1; di++) {
        for (let dj = -1; dj <= 1; dj++) {
          const list = cells.get((ci + di + 4096) * 8192 + cj + dj + 4096);
          if (!list) continue;
          for (const j of list) {
            if (j <= i) continue;
            const d = Math.hypot(places[j].x - p.x, places[j].z - p.z);
            if (d > CROSS) continue;
            // Точки ОДНОЙ дороги связываем, только если она свернулась к себе:
            // у соседних станций путь вдоль дороги равен расстоянию по прямой,
            // и связывать их второй раз незачем. У серпантина же соседние
            // по земле точки разделены сотней метров дороги — и вот их высоты
            // обязаны сходиться, иначе полотно встанет ступенькой.
            if (roadOf[j] === roadOf[i] && Math.abs(along[j] - along[i]) < d * 2) continue;
            // Считаем не расстояние между осями, а ЗАЗОР между краями полотна:
            // предел уклона — свойство поверхности, а не осевых линий. У двух
            // дорог, чьи полотна сомкнулись, зазор ноль, и высоты обязаны
            // совпасть — иначе на их стыке встанет ступенька.
            const gap = Math.max(0, d - widths[i] - widths[j]);
            links.push({ a: i, b: j, allowed: gap * MAX_GRADE });
          }
        }
      }
    });
  }

  const solved = solveHeights(places, chains, links, terrain);

  const shapes: RoadShape[] = net.edges.map((edge, e) => {
    const stations = lines[e];
    const height = solved.slice(first[e], first[e] + stations.length);
    return {
      type: edge.type,
      stations,
      height,
      halfWidth: roadWidth(edge.type) / 2,
      outerHalf: roadWidth(edge.type) / 2 + edge.type.sidewalk,
      grade: steepest(stations, height),
      lift: stations.reduce((m, st, i) => Math.max(m, Math.abs(height[i] - terrain(st.x, st.z))), 0),
      from: edge.from,
      to: edge.to,
    };
  });

  const junctions: Junction[] = net.nodes
    .map((node) => ({ x: node.x, z: node.z, degree: node.degree }))
    .filter((j) => j.degree > 1);

  return {
    shapes,
    junctions,
    nodeCount: net.nodes.length,
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

/** Через сколько метров стоят станции вдоль дороги. */
const STATION_STEP = 2;

/**
 * Строит раскладку отрезков по клеткам и возвращает вопрос «какая тут высота».
 *
 * ГЛАВНОЕ. Высота полотна — не «профиль ближайшей дороги». «Ближайшая» скачком
 * меняется на равном удалении от двух дорог, и на перекрёстке из-за этого
 * появлялся ОБРЫВ: измерено 1.1 м на тротуаре и 0.9 м на асфальте в десяти
 * метрах от узла, где профили двух дорог успели разойтись. Картинка это
 * скрывала, а машина бы в него въехала.
 *
 * Поэтому высота — взвешенная смесь профилей всех дорог, которые сюда
 * дотягиваются. Вес равен единице на своей проезжей части и плавно сходит на
 * ноль на расстоянии `reach` от её края. Смесь непрерывных величин непрерывна,
 * значит обрыв стал невыразим, а не пойман.
 *
 * `reach` не подобран: это ширина самой широкой дороги в сети. Дальше своей
 * ширины дорога соседке уже не мешает.
 *
 * Клетки лежат сплошным массивом, а не словарём по строковому ключу: вопрос
 * задаётся десятки тысяч раз за сборку.
 */
function indexRoads(shapes: readonly RoadShape[]): (x: number, z: number) => RoadProximity | null {
  interface Seg {
    ax: number; az: number; dx: number; dz: number; lenSq: number;
    h0: number; h1: number; shape: RoadShape; which: number;
  }
  const segments: { seg: Seg; i0: number; i1: number; j0: number; j1: number }[] = [];
  let widest = 0;
  let minI = Infinity, maxI = -Infinity, minJ = Infinity, maxJ = -Infinity;

  shapes.forEach((shape, which) => {
    widest = Math.max(widest, shape.outerHalf);
    const st = shape.stations;
    for (let i = 0; i + 1 < st.length; i++) {
      const seg: Seg = {
        ax: st[i].x, az: st[i].z,
        dx: st[i + 1].x - st[i].x, dz: st[i + 1].z - st[i].z,
        lenSq: 0, h0: shape.height[i], h1: shape.height[i + 1], shape, which,
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
  });
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

  const reach = Math.max(1, widest);
  // черновики переиспользуются между вопросами: их десятки тысяч
  const nearOf = new Float64Array(shapes.length).fill(Infinity);
  const heightOf = new Float64Array(shapes.length);
  const touched: number[] = [];

  return (x, z) => {
    const ci = Math.floor(x / CELL), cj = Math.floor(z / CELL);
    let best: RoadShape | null = null;
    let bestKey = Infinity;
    let bestDistance = Infinity;
    touched.length = 0;

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
            if (nearOf[seg.which] === Infinity) touched.push(seg.which);
            if (distance < nearOf[seg.which]) {
              nearOf[seg.which] = distance;
              heightOf[seg.which] = seg.h0 + (seg.h1 - seg.h0) * t;
            }
            const key = distance - seg.shape.outerHalf;
            if (key >= bestKey) continue;
            bestKey = key;
            bestDistance = distance;
            best = seg.shape;
          }
        }
      }
      // дальше следующего кольца не может лежать ни выигравшая дорога,
      // ни та, что ещё вносит вклад в смесь
      if (best !== null && (r - 1) * CELL - widest - reach > bestKey) break;
    }
    if (best === null) return null;

    let sum = 0;
    let weight = 0;
    for (const which of touched) {
      const outside = Math.max(0, nearOf[which] - shapes[which].outerHalf);
      const w = outside >= reach ? 0 : (1 - outside / reach) ** 2;
      nearOf[which] = Infinity;
      if (w === 0) continue;
      sum += w * heightOf[which];
      weight += w;
    }

    return {
      distance: bestDistance,
      // если ни одна дорога сюда не дотягивается — берём ближайшую: там уже
      // всё равно, потому что земля давно вернулась к нетронутой
      roadHeight: weight > 0 ? sum / weight : heightOf[shapes.indexOf(best)],
      halfWidth: best.halfWidth,
      outerHalf: best.outerHalf,
      curb: best.type.curb,
    };
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
