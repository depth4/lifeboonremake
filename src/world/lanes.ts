/**
 * СЕТЬ ДВИЖЕНИЯ: полосы и связи между ними.
 *
 * Главная мысль, ради которой этот файл существует:
 *
 *   **Движение — это не машины. Движение — это сеть разрешённых путей.**
 *
 * Сначала строится ответ на вопрос «откуда куда МОЖНО», и только потом кто-то
 * по этому едет. Так устроено и у симуляторов движения (SUMO), и в стандарте
 * дорожных карт (OpenDRIVE): перекрёсток там — не площадка асфальта, а список
 * коротких внутренних дорожек, каждая из которых ведёт с одной входящей полосы
 * на одну исходящую.
 *
 * Что из устройства следует само:
 *   — «машина едет там, где ехать нельзя» невыразимо: ехать можно только
 *     по полосе, а полоса ведёт только туда, куда ведёт связь;
 *   — «полоса ведёт в никуда» ловится проверкой и является поломкой;
 *   — «связь висит в воздухе» невыразимо: она строится ИЗ концов двух полос,
 *     а не задаётся отдельно, поэтому разойтись с ними не может;
 *   — «кто кому уступает» вычисляется из пересечения связей, а не назначается.
 *
 * Про экран этот файл не знает ничего.
 */

import type { Point2, Station } from './road.ts';
import type { World } from './world.ts';
import { at, bands, forward } from './road.ts';

/** Точка пути: место на карте и высота. */
export interface Point3 {
  readonly x: number;
  readonly y: number;
  readonly z: number;
}

export type Turn = 'прямо' | 'налево' | 'направо' | 'разворот';

/**
 * Полоса — дорожка, по которой едут в ОДНУ сторону.
 *
 * Не «полоска краски шириной 3.5 метра», а путь: у него есть начало, конец,
 * длина и направление. Положение машины — это «полоса такая-то, столько-то
 * метров от её начала»; ни x, ни z машина знать не обязана.
 */
export interface Lane {
  readonly id: number;
  /** номер участка дороги, которому полоса принадлежит */
  readonly road: number;
  /** номер полосы внутри своего участка, считая слева направо по ходу */
  readonly index: number;
  /** узел сети, из которого выезжают */
  readonly from: number;
  /** узел сети, в который приезжают */
  readonly to: number;
  /** смещение от осевой линии, метры: то самое `t` */
  readonly offset: number;
  /** путь по направлению движения */
  readonly path: readonly Point3[];
  readonly length: number;
}

/**
 * Связь: «с этой полосы можно на ту».
 *
 * Это и есть перекрёсток. Другого перекрёстка в модели движения нет.
 * Путь связи строится из концов двух полос и их направлений, поэтому
 * оторваться от них не может.
 */
export interface Link {
  readonly id: number;
  /** номер узла, внутри которого лежит связь */
  readonly node: number;
  readonly from: number;
  readonly to: number;
  readonly turn: Turn;
  readonly path: readonly Point3[];
  readonly length: number;
}

/**
 * Помеха: две связи, которые пересекаются внутри одного перекрёстка.
 * Кто кому уступает — отдельный вопрос, здесь только факт пересечения.
 */
export interface Conflict {
  readonly a: number;
  readonly b: number;
  /** где именно пересекаются — включая высоту: дорога лежит не на нуле */
  readonly x: number;
  readonly y: number;
  readonly z: number;
}

export interface Traffic {
  readonly lanes: readonly Lane[];
  readonly links: readonly Link[];
  readonly conflicts: readonly Conflict[];
}

/** Ближе этого к узлу полоса не подходит — там начинается чужой асфальт. */
const NODE_CLEAR = 0.5;
/** Короче этого полоса не нужна: на перекрёстке из неё всё равно не поездишь. */
const MIN_LANE = 2;
/** На сколько точек разбивается дуга связи. */
const LINK_STEPS = 8;
/** Уже этого угла поворот считается «прямо», градусы. */
const STRAIGHT = 35;

/** Что можно выключить, чтобы проверка показала, что она умеет падать. */
export interface Handicap {
  /** не строить связи налево: тогда с некоторых полос уехать станет некуда */
  readonly noLeft?: boolean;
}

/**
 * Строит сеть движения из готового мира.
 *
 * Порядок: сначала полосы (они выводятся из полос дороги, а не задаются
 * рядом с ними), потом связи между полосами в каждом узле, потом помехи.
 */
export function buildTraffic(world: World, handicap: Handicap = {}): Traffic {
  const lanes = buildLanes(world);
  const links = buildLinks(world, lanes, handicap);
  return { lanes, links, conflicts: findConflicts(links) };
}

/**
 * Полосы выводятся ИЗ полос дороги, а не задаются рядом с ними.
 *
 * Поэтому «полоса для езды оказалась не там, где нарисован асфальт» —
 * невыразимо: и то и другое считается из одного и того же списка полос
 * и одной и той же осевой линии.
 */
function buildLanes(world: World): Lane[] {
  const lanes: Lane[] = [];
  world.shapes.forEach((shape, road) => {
    const st = shape.stations;
    if (st.length < 2) return;
    const total = st[st.length - 1].s;

    // Сколько метров съедает перекрёсток с каждого конца. Считается по
    // ПЕРЕСЕЧЕНИЮ с чужим асфальтом, а не по ширинам: тогда прямое
    // продолжение той же улицы ничего не съедает, а перпендикулярная
    // дорога съедает ровно свою полуширину, и на остром угле — больше.
    const cutStart = Math.min(covered(world, shape, shape.from) + NODE_CLEAR, total / 2 - 0.1);
    const cutEnd = Math.min(covered(world, shape, shape.to) + NODE_CLEAR, total / 2 - 0.1);

    let index = 0;
    for (const band of bands(shape.type)) {
      if (band.kind !== 'travel' || band.direction === 0) continue;
      const offset = (band.from + band.to) / 2;
      const forwardLane = band.direction === 1;

      // Обрезка не зависит от того, в какую сторону по полосе едут: она
      // зависит только от того, какой узел с какого конца осевой линии.
      // От направления зависит ТОЛЬКО порядок точек. Пока это было
      // перепутано, встречные полосы въезжали в перекрёсток на восемь
      // метров глубже попутных — на картинке это сразу видно, в цифрах нет.
      const path = tracePath(st, shape.height, offset, cutStart, total - cutEnd, forwardLane);
      if (path.length < 2) continue;
      const length = pathLength(path);
      if (length < MIN_LANE) continue;

      lanes.push({
        id: lanes.length,
        road,
        index: index++,
        from: forwardLane ? shape.from : shape.to,
        to: forwardLane ? shape.to : shape.from,
        offset,
        path,
        length,
      });
    }
  });
  return lanes;
}

/**
 * Докуда от узла осевая линия этого участка накрыта ЧУЖИМ асфальтом.
 *
 * Не «полуширина самой широкой соседки» — это было бы назначенное число,
 * и прямое продолжение улицы съедало бы восемь метров на ровном месте.
 * Здесь ответ вычисляется: идём от узла по своим станциям, пока точка
 * лежит внутри коридора хоть одной соседней дороги.
 *
 * На остром угле это само даёт больше, чем полуширина, — и правильно:
 * там чужой асфальт и правда тянется вдоль нас дольше.
 */
function covered(world: World, shape: World['shapes'][number], node: number): number {
  const others = world.shapes.filter(
    (o) => o !== shape && (o.from === node || o.to === node),
  );
  if (others.length === 0) return 0;

  const st = shape.stations;
  const atStart = shape.from === node;
  const total = st[st.length - 1].s;
  // дальше самой широкой соседки искать нечего
  const limit = others.reduce((m, o) => Math.max(m, o.halfWidth), 0) * 6;

  let deepest = 0;
  for (let k = 0; k < st.length; k++) {
    const i = atStart ? k : st.length - 1 - k;
    const away = atStart ? st[i].s : total - st[i].s;
    if (away > limit) break;
    let inside = false;
    for (const o of others) {
      if (insideCorridor(o, st[i].x, st[i].z)) { inside = true; break; }
    }
    if (inside) deepest = away;
  }
  return deepest;
}

/**
 * Лежит ли точка внутри коридора участка.
 *
 * Коридор — это полоса шириной в две полуширины ВДОЛЬ линии, и он КОНЧАЕТСЯ
 * там, где кончается линия: торец срезан прямо, а не скруглён. Поэтому проекция
 * обязана попасть внутрь отрезка, а не прижаться к его концу. Пока расстояние
 * мерилось до ближайшей точки линии, торец вёл себя как полукруг, и прямое
 * продолжение улицы «накрывало» соседний участок на всю свою полуширину —
 * из-за чего полосы обрезались на десять метров вместо четырёх.
 */
function insideCorridor(shape: World['shapes'][number], x: number, z: number): boolean {
  const st = shape.stations;
  for (let i = 0; i + 1 < st.length; i++) {
    const dx = st[i + 1].x - st[i].x, dz = st[i + 1].z - st[i].z;
    const lenSq = dx * dx + dz * dz;
    if (lenSq < 1e-9) continue;
    const t = ((x - st[i].x) * dx + (z - st[i].z) * dz) / lenSq;
    if (t < 0 || t > 1) continue;
    if (Math.hypot(x - (st[i].x + dx * t), z - (st[i].z + dz * t)) <= shape.halfWidth) return true;
  }
  return false;
}

/**
 * Путь полосы: станции дороги, сдвинутые вбок на `offset`, обрезанные с концов
 * и развёрнутые по направлению движения.
 *
 * Сдвиг вбок делается ровно одной функцией `at` — той же, которой пользуются
 * и знаки, и разметка. Поэтому «полоса и знак на ней разъехались» невыразимо.
 */
function tracePath(
  st: readonly Station[],
  height: readonly number[],
  offset: number,
  fromS: number,
  toS: number,
  forwardLane: boolean,
): Point3[] {
  const out: Point3[] = [];
  // шаг станций — два метра, точнее для полосы не нужно
  for (let i = 0; i < st.length; i++) {
    if (st[i].s < fromS || st[i].s > toS) continue;
    const p = at(st[i], offset);
    out.push({ x: p.x, y: height[i], z: p.z });
  }
  return forwardLane ? out : out.reverse();
}

function pathLength(path: readonly Point3[]): number {
  let sum = 0;
  for (let i = 1; i < path.length; i++) {
    sum += Math.hypot(path[i].x - path[i - 1].x, path[i].z - path[i - 1].z);
  }
  return sum;
}

/** Направление, с которым полоса входит в свой конечный узел. */
function endDirection(lane: Lane): Point2 {
  const p = lane.path;
  const a = p[Math.max(0, p.length - 3)];
  const b = p[p.length - 1];
  const len = Math.hypot(b.x - a.x, b.z - a.z) || 1;
  return { x: (b.x - a.x) / len, z: (b.z - a.z) / len };
}

/** Направление, с которым полоса выходит из своего начального узла. */
function startDirection(lane: Lane): Point2 {
  const p = lane.path;
  const a = p[0];
  const b = p[Math.min(p.length - 1, 2)];
  const len = Math.hypot(b.x - a.x, b.z - a.z) || 1;
  return { x: (b.x - a.x) / len, z: (b.z - a.z) / len };
}

/**
 * Какой это поворот.
 *
 * Разворот определяется НЕ УГЛОМ, а смыслом: развернуться — значит уехать
 * обратно по той дороге, по которой приехал. Это важно. Пока разворот ловился
 * углом «круче 150 градусов», на остром перекрёстке (сцены «острый» и
 * «бритва», угол 25°) законный поворот с одной дороги на другую попадал
 * под это правило и запрещался — и с трёх полос становилось некуда уехать.
 * Проверка это поймала сразу. Чинится не подкруткой порога, а тем, что
 * «разворот» перестал быть вопросом градусов.
 *
 * Ось x вправо, ось z вниз — как на виде сверху. Тогда движение на восток
 * с последующим поворотом на юг (вниз по экрану) — это поворот НАПРАВО,
 * и у него положительное векторное произведение.
 */
function turnOf(into: Point2, out: Point2, sameRoad: boolean): Turn {
  if (sameRoad) return 'разворот';
  const cross = into.x * out.z - into.z * out.x;
  const dot = into.x * out.x + into.z * out.z;
  const deg = (Math.atan2(cross, dot) * 180) / Math.PI;
  if (Math.abs(deg) <= STRAIGHT) return 'прямо';
  return deg > 0 ? 'направо' : 'налево';
}

function buildLinks(world: World, lanes: readonly Lane[], handicap: Handicap): Link[] {
  const incoming = new Map<number, Lane[]>();
  const outgoing = new Map<number, Lane[]>();
  const push = (map: Map<number, Lane[]>, node: number, lane: Lane): void => {
    const list = map.get(node);
    if (list) list.push(lane);
    else map.set(node, [lane]);
  };
  for (const lane of lanes) {
    push(incoming, lane.to, lane);
    push(outgoing, lane.from, lane);
  }

  const links: Link[] = [];
  for (const [node, ins] of incoming) {
    const outs = outgoing.get(node) ?? [];
    for (const a of ins) {
      const into = endDirection(a);
      // Разворот разрешаем только там, где деваться больше некуда: на тупике.
      // Иначе он становится любимым манёвром и запирает перекрёсток —
      // ровно то, на что жалуются в Cities: Skylines 2.
      const elsewhere = outs.some((b) => b.road !== a.road);
      for (const b of outs) {
        const turn = turnOf(into, startDirection(b), b.road === a.road);
        if (turn === 'разворот' && elsewhere) continue;
        if (handicap.noLeft === true && turn === 'налево') continue;
        const path = arc(a.path[a.path.length - 1], into, b.path[0], startDirection(b));
        links.push({
          id: links.length,
          node,
          from: a.id,
          to: b.id,
          turn,
          path,
          length: pathLength(path),
        });
      }
    }
  }
  return links;
}

/**
 * Дуга связи: из конца одной полосы в начало другой, выходя и входя ровно
 * по их направлениям.
 *
 * Концы дуги — это САМИ точки полос, а не их копии. Поэтому разрыва между
 * полосой и связью не бывает: соединять нечего, это одна и та же точка.
 */
function arc(from: Point3, into: Point2, to: Point3, out: Point2): Point3[] {
  const span = Math.hypot(to.x - from.x, to.z - from.z);
  const pull = span * 0.42;
  const c1 = { x: from.x + into.x * pull, z: from.z + into.z * pull };
  const c2 = { x: to.x - out.x * pull, z: to.z - out.z * pull };
  const path: Point3[] = [];
  for (let k = 0; k <= LINK_STEPS; k++) {
    const t = k / LINK_STEPS;
    const u = 1 - t;
    path.push({
      x: u * u * u * from.x + 3 * u * u * t * c1.x + 3 * u * t * t * c2.x + t * t * t * to.x,
      y: from.y + (to.y - from.y) * t,
      z: u * u * u * from.z + 3 * u * u * t * c1.z + 3 * u * t * t * c2.z + t * t * t * to.z,
    });
  }
  return path;
}

/**
 * Где связи мешают друг другу.
 *
 * Помеха — это факт пересечения путей, и он ВЫЧИСЛЯЕТСЯ. Никто не пишет
 * руками «поворачивающий налево уступает встречному»: если их дорожки
 * пересекаются, это видно из самих дорожек.
 *
 * Связи, выходящие с одной полосы, не помеха друг другу — они разойдутся
 * раньше, чем встретятся. Связи, ведущие на ОДНУ полосу, помеха всегда:
 * это слияние, и вдвоём туда не въехать.
 */
function findConflicts(links: readonly Link[]): Conflict[] {
  const byNode = new Map<number, Link[]>();
  for (const link of links) {
    const list = byNode.get(link.node);
    if (list) list.push(link);
    else byNode.set(link.node, [link]);
  }

  const out: Conflict[] = [];
  for (const list of byNode.values()) {
    for (let i = 0; i < list.length; i++) {
      for (let j = i + 1; j < list.length; j++) {
        const a = list[i], b = list[j];
        if (a.from === b.from) continue;
        if (a.to === b.to) {
          const p = a.path[a.path.length - 1];
          out.push({ a: a.id, b: b.id, x: p.x, y: p.y, z: p.z });
          continue;
        }
        const hit = crossPoint(a.path, b.path);
        if (hit) out.push({ a: a.id, b: b.id, x: hit.x, y: hit.y, z: hit.z });
      }
    }
  }
  return out;
}

function crossPoint(a: readonly Point3[], b: readonly Point3[]): Point3 | null {
  for (let i = 0; i + 1 < a.length; i++) {
    for (let j = 0; j + 1 < b.length; j++) {
      const ax = a[i + 1].x - a[i].x, az = a[i + 1].z - a[i].z;
      const bx = b[j + 1].x - b[j].x, bz = b[j + 1].z - b[j].z;
      const den = ax * bz - az * bx;
      if (Math.abs(den) < 1e-9) continue;
      const t = ((b[j].x - a[i].x) * bz - (b[j].z - a[i].z) * bx) / den;
      const u = ((b[j].x - a[i].x) * az - (b[j].z - a[i].z) * ax) / den;
      if (t < 0 || t > 1 || u < 0 || u > 1) continue;
      return { x: a[i].x + ax * t, y: a[i].y + (a[i + 1].y - a[i].y) * t, z: a[i].z + az * t };
    }
  }
  return null;
}

/** Полосы, из которых на перекрёстке некуда уехать. Это поломка. */
export function deadEnds(world: World, traffic: Traffic): Lane[] {
  const hasExit = new Set(traffic.links.map((l) => l.from));
  const degree = new Int32Array(world.nodeCount);
  for (const shape of world.shapes) {
    degree[shape.from]++;
    degree[shape.to]++;
  }
  return traffic.lanes.filter((lane) => degree[lane.to] > 1 && !hasExit.has(lane.id));
}

/** Насколько связь разошлась с полосами, которые соединяет. Должно быть ноль. */
export function worstGap(traffic: Traffic): number {
  const byId = new Map(traffic.lanes.map((l) => [l.id, l]));
  let worst = 0;
  for (const link of traffic.links) {
    const a = byId.get(link.from);
    const b = byId.get(link.to);
    if (!a || !b) return Infinity;
    const head = a.path[a.path.length - 1];
    const tail = b.path[0];
    worst = Math.max(
      worst,
      Math.hypot(link.path[0].x - head.x, link.path[0].z - head.z),
      Math.hypot(link.path[link.path.length - 1].x - tail.x, link.path[link.path.length - 1].z - tail.z),
    );
  }
  return worst;
}

/** Направление вдоль дороги — пригодится тем, кто ставит знаки. */
export { forward };
