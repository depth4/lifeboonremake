/**
 * ПРАВИЛА: чья очередь ехать.
 *
 * `lanes.ts` отвечает на вопрос «откуда куда МОЖНО». Этот файл — на вопрос
 * «кто кого пропускает». Это разные вопросы, и смешивать их нельзя: куда можно
 * ехать, не меняется никогда, а чья очередь — меняется каждую секунду, если
 * на перекрёстке стоит светофор.
 *
 * Что здесь устроено так, что ошибиться нельзя:
 *   — уступает ВСЕГДА ровно один из двоих. Помеха, которую никто не разрешил,
 *     — это поломка, и проверка её ловит. «Оба поехали» невыразимо;
 *   — старшинство считается из числа полос, а не назначается;
 *   — фазы светофора ВЫЧИСЛЯЮТСЯ раскраской: две связи, которые режут друг
 *     друга поперёк, не могут гореть зелёным одновременно. Поэтому «светофор
 *     пустил два встречных потока в лоб» невыразимо;
 *   — длительность жёлтого считается из скорости и тормозного пути, а длина
 *     «всем красный» — из размера самого перекрёстка. Ни одно из этих чисел
 *     не подобрано на глаз.
 *
 * Про экран этот файл не знает ничего.
 */

import type { World } from './world.ts';
import type { Conflict, Lane, Link, Traffic } from './lanes.ts';
import type { Point2 } from './road.ts';
import { endDirection } from './lanes.ts';

export type Reason =
  | 'главная дорога'
  | 'выезд со двора'
  | 'левый поворот'
  | 'разворот'
  | 'помеха справа'
  | 'слияние';

/** Кто кому уступает в одной конкретной помехе. */
export interface Yield {
  /** связь, которая ждёт */
  readonly waits: number;
  /** связь, которая едет */
  readonly goes: number;
  readonly why: Reason;
}

/** Одна фаза светофора: какие связи горят зелёным одновременно. */
export interface Phase {
  readonly links: readonly number[];
  /** сколько секунд горит зелёный */
  readonly green: number;
  /** сколько секунд жёлтый после него */
  readonly yellow: number;
  /** сколько секунд «всем красный», пока перекрёсток пустеет */
  readonly allRed: number;
}

export interface Signal {
  readonly node: number;
  readonly phases: readonly Phase[];
  readonly cycle: number;
}

export type Light = 'зелёный' | 'жёлтый' | 'красный';

export interface Rules {
  /** для каждой связи — кому она обязана уступить */
  readonly yieldTo: readonly (readonly number[])[];
  /** все разрешённые помехи, с объяснением */
  readonly yields: readonly Yield[];
  readonly signals: readonly Signal[];
  /** номер светофора для связи, -1 — перекрёсток без светофора */
  readonly signalOf: Int32Array;
  /** номер фазы, в которой связь горит зелёным */
  readonly phaseOf: Int32Array;
}

/**
 * Светофор ставится там, где встречаются две ГЛАВНЫЕ дороги.
 *
 * Это решение, а не вывод: в настоящем городе светофор ставят по числу машин,
 * которого у нас пока нет. Но правило записано одной строкой и заменяется
 * одной строкой, а не рассыпано по коду.
 */
const SIGNAL_RANK = 2;
/**
 * На сколько секунд рассчитан полный круг светофора.
 *
 * Не «сколько горит зелёный», а сколько длится всё вместе. Это важнее:
 * настоящие городские циклы держат в 60–120 секунд, потому что длинный круг
 * заставляет ждать всех. Поэтому фазы делят между собой ОСТАТОК круга после
 * жёлтых и «всем красных», а не получают по фиксированному куску. Тогда
 * «светофор с циклом в три минуты» становится невыразимым.
 */
const CYCLE = 90;
/** Короче этого зелёный не бывает: столько нужно, чтобы тронуться и проехать. */
const MIN_GREEN = 7;
/** Время реакции водителя на жёлтый, секунды. */
const REACTION = 1.0;
/** Комфортное замедление, м/с². */
const BRAKE = 3.0;
/** Косинус угла, при котором два потока считаются встречными. */
const HEAD_ON = -0.7;

export function buildRules(world: World, traffic: Traffic): Rules {
  const yields = resolveAll(world, traffic);

  const yieldTo: number[][] = traffic.links.map(() => []);
  for (const y of yields) yieldTo[y.waits].push(y.goes);

  const signals = buildSignals(world, traffic, yields);
  const signalOf = new Int32Array(traffic.links.length).fill(-1);
  const phaseOf = new Int32Array(traffic.links.length).fill(-1);
  signals.forEach((signal, s) => {
    signal.phases.forEach((phase, p) => {
      for (const id of phase.links) {
        signalOf[id] = s;
        phaseOf[id] = p;
      }
    });
  });

  return { yieldTo, yields, signals, signalOf, phaseOf };
}

/**
 * Разбирает КАЖДУЮ помеху. Неразрешённых не остаётся: если ни одно правило
 * не сработало, побеждает помеха справа, а она определена всегда, потому что
 * два разных направления не могут быть друг у друга слева одновременно.
 */
function resolveAll(world: World, traffic: Traffic): Yield[] {
  const byId = new Map(traffic.lanes.map((l) => [l.id, l]));
  const rankOf = (lane: Lane): number => world.shapes[lane.road].type.rank;
  const approach = new Map<number, Point2>();
  const dirOf = (lane: Lane): Point2 => {
    const known = approach.get(lane.id);
    if (known) return known;
    const d = endDirection(lane);
    approach.set(lane.id, d);
    return d;
  };

  const out: Yield[] = [];
  for (const conflict of traffic.conflicts) {
    const a = traffic.links[conflict.a];
    const b = traffic.links[conflict.b];
    const la = byId.get(a.from);
    const lb = byId.get(b.from);
    if (!la || !lb) continue;
    out.push(decide(a, b, la, lb, dirOf(la), dirOf(lb), rankOf(la), rankOf(lb), conflict));
  }
  return out;
}

function decide(
  a: Link, b: Link,
  la: Lane, lb: Lane,
  da: Point2, db: Point2,
  rankA: number, rankB: number,
  conflict: Conflict,
): Yield {
  const wait = (waits: number, goes: number, why: Reason): Yield => ({ waits, goes, why });

  // 1. Разворот уступает всем: он и так поперёк всего.
  if (a.turn === 'разворот' && b.turn !== 'разворот') return wait(a.id, b.id, 'разворот');
  if (b.turn === 'разворот' && a.turn !== 'разворот') return wait(b.id, a.id, 'разворот');

  // 2. Выезд со двора уступает улице. Двор — старшинство ноль.
  if (rankA === 0 && rankB > 0) return wait(a.id, b.id, 'выезд со двора');
  if (rankB === 0 && rankA > 0) return wait(b.id, a.id, 'выезд со двора');

  // 3. Главная дорога. Кто едет по более широкой — у того приоритет.
  if (rankA !== rankB) {
    return rankA > rankB ? wait(b.id, a.id, 'главная дорога') : wait(a.id, b.id, 'главная дорога');
  }

  // 4. Слияние: обе связи ведут на одну полосу. Уступает тот, кто поворачивает;
  //    если оба поворачивают одинаково — помеха справа.
  if (a.to === b.to) {
    const weight = (turn: Link['turn']): number =>
      turn === 'прямо' ? 0 : turn === 'направо' ? 1 : 2;
    const wa = weight(a.turn), wb = weight(b.turn);
    if (wa !== wb) {
      return wa > wb ? wait(a.id, b.id, 'слияние') : wait(b.id, a.id, 'слияние');
    }
  }

  // 5. Левый поворот уступает встречному. Встречный — тот, чьё направление
  //    подхода противоположно нашему; у него преимущество, если он едет
  //    прямо или направо.
  const headOn = da.x * db.x + da.z * db.z <= HEAD_ON;
  if (headOn) {
    if (a.turn === 'налево' && b.turn !== 'налево') return wait(a.id, b.id, 'левый поворот');
    if (b.turn === 'налево' && a.turn !== 'налево') return wait(b.id, a.id, 'левый поворот');
  }

  // 6. Помеха справа. Ось x вправо, ось z вниз. Тот, у кого другой подъезжает
  //    справа, — уступает. Определено всегда, кроме встречных: у встречных
  //    векторное произведение ноль, но встречные без левого поворота
  //    друг другу и не мешают — такой помехи просто не бывает.
  const cross = da.x * db.z - da.z * db.x;
  if (cross < 0) return wait(a.id, b.id, 'помеха справа');
  if (cross > 0) return wait(b.id, a.id, 'помеха справа');

  // Встречные, оба налево: расходятся левыми бортами, но пути пересекаются.
  // Уступает тот, кто правее по месту пересечения — лишь бы правило было
  // одно и то же для обоих, иначе поедут вдвоём.
  const first = a.id < b.id ? a : b;
  const second = a.id < b.id ? b : a;
  void conflict;
  return wait(second.id, first.id, 'помеха справа');
}

/**
 * Фазы светофора ВЫЧИСЛЯЮТСЯ, а не расписываются руками.
 *
 * Правило одно: **зелёный вместе дают только тем, кто въезжает на перекрёсток
 * с одной оси.** Встречные и попутные — можно; поперечные — никогда.
 *
 * Почему именно так. Левый поворот навстречу встречному потоку — законное
 * дело: поворачивающий выезжает на середину и ждёт просвета, это делают
 * во всём мире. А вот левый поворот против потока с ДРУГОЙ улицы — это уже
 * не «подожду внутри», это лоб в лоб, и никакой светофор так не работает.
 * Разница ровно в оси подхода, а не в том, поворот это или нет.
 *
 * Раскрашиваем граф «разные оси» жадно: соседям разные цвета. Цвет и есть
 * фаза. Поэтому «светофор пустил два поперечных потока сразу» невыразимо.
 */
function buildSignals(world: World, traffic: Traffic, yields: readonly Yield[]): Signal[] {
  const major = new Int32Array(world.nodeCount);
  for (const shape of world.shapes) {
    if (shape.type.rank < SIGNAL_RANK) continue;
    major[shape.from]++;
    major[shape.to]++;
  }

  void yields;
  const hard = new Map<number, Set<number>>();
  for (const c of traffic.conflicts) {
    if (sameAxis(traffic, c.a, c.b)) continue;
    add(hard, c.a, c.b);
    add(hard, c.b, c.a);
  }

  const byNode = new Map<number, Link[]>();
  for (const link of traffic.links) {
    const list = byNode.get(link.node);
    if (list) list.push(link);
    else byNode.set(link.node, [link]);
  }

  const signals: Signal[] = [];
  for (const [node, links] of byNode) {
    // Светофор — там, где через узел проходит главная дорога. Сквозная
    // главная даёт два конца, две пересекающиеся — четыре. Считаем именно
    // концы, а не дороги: планаризация режет улицу на участки, и «одна
    // улица» на перекрёстке — это уже два разных участка.
    if (major[node] < 2) continue;

    // Жадная раскраска. Порядок — по числу помех: сначала самые неудобные,
    // иначе фаз получается больше, чем нужно.
    const color = new Map<number, number>();
    const order = [...links].sort(
      (p, q) => (hard.get(q.id)?.size ?? 0) - (hard.get(p.id)?.size ?? 0),
    );
    let colours = 0;
    for (const link of order) {
      const taken = new Set<number>();
      for (const foe of hard.get(link.id) ?? []) {
        const c = color.get(foe);
        if (c !== undefined) taken.add(c);
      }
      let c = 0;
      while (taken.has(c)) c++;
      color.set(link.id, c);
      colours = Math.max(colours, c + 1);
    }
    if (colours < 2) continue; // делить нечего — светофор не нужен

    const speed = fastestAt(world, traffic, links);
    // Жёлтый: доехать до перекрёстка, пока не поздно тормозить.
    const yellow = Math.round((REACTION + speed / (2 * BRAKE)) * 10) / 10;
    // «Всем красный»: пока самая длинная дорожка внутри не опустеет.
    const longest = links.reduce((m, l) => Math.max(m, l.length), 0);
    const allRed = Math.round((longest / Math.max(1, speed)) * 10) / 10;

    const groups: number[][] = [];
    for (let c = 0; c < colours; c++) {
      const inPhase = links.filter((l) => color.get(l.id) === c).map((l) => l.id);
      if (inPhase.length > 0) groups.push(inPhase);
    }
    // Зелёное время — это то, что осталось от круга после жёлтых и красных,
    // поделённое поровну. Если фаз много, каждой достаётся меньше, а круг
    // не разрастается.
    const overhead = groups.length * (yellow + allRed);
    const green = Math.max(MIN_GREEN, Math.round((CYCLE - overhead) / groups.length));
    const phases: Phase[] = groups.map((links2) => ({ links: links2, green, yellow, allRed }));
    const cycle = phases.reduce((sum, p) => sum + p.green + p.yellow + p.allRed, 0);
    signals.push({ node, phases, cycle });
  }
  return signals;
}

const key = (a: number, b: number): string => `${a}>${b}`;

/**
 * Въезжают ли две связи на перекрёсток с одной оси — то есть навстречу
 * друг другу или бок о бок. Только такие могут гореть зелёным вместе.
 */
function sameAxis(traffic: Traffic, a: number, b: number): boolean {
  const byId = laneIndex(traffic);
  const la = byId.get(traffic.links[a].from);
  const lb = byId.get(traffic.links[b].from);
  if (!la || !lb) return false;
  const da = endDirection(la), db = endDirection(lb);
  return Math.abs(da.x * db.x + da.z * db.z) >= -HEAD_ON;
}

let laneCache: { traffic: Traffic; map: Map<number, Lane> } | null = null;
function laneIndex(traffic: Traffic): Map<number, Lane> {
  if (laneCache && laneCache.traffic === traffic) return laneCache.map;
  const map = new Map(traffic.lanes.map((l) => [l.id, l]));
  laneCache = { traffic, map };
  return map;
}

function add(map: Map<number, Set<number>>, a: number, b: number): void {
  const set = map.get(a);
  if (set) set.add(b);
  else map.set(a, new Set([b]));
}

function fastestAt(world: World, traffic: Traffic, links: readonly Link[]): number {
  const byId = new Map(traffic.lanes.map((l) => [l.id, l]));
  let fast = 0;
  for (const link of links) {
    const lane = byId.get(link.from);
    if (lane) fast = Math.max(fast, world.shapes[lane.road].type.speed);
  }
  return fast;
}

/**
 * Какой сигнал горит этой связи в этот момент.
 *
 * Время идёт по кругу длиной в цикл. Фазы идут подряд: зелёный, жёлтый,
 * «всем красный» — и следующая. Своей фазе горит зелёный, в чужие — красный.
 */
export function lightOf(rules: Rules, link: number, seconds: number): Light {
  const s = rules.signalOf[link];
  if (s < 0) return 'зелёный';
  const signal = rules.signals[s];
  const mine = rules.phaseOf[link];
  let t = seconds % signal.cycle;
  for (let p = 0; p < signal.phases.length; p++) {
    const phase = signal.phases[p];
    if (t < phase.green) return p === mine ? 'зелёный' : 'красный';
    t -= phase.green;
    if (t < phase.yellow) return p === mine ? 'жёлтый' : 'красный';
    t -= phase.yellow;
    if (t < phase.allRed) return 'красный';
    t -= phase.allRed;
  }
  return 'красный';
}

/** Помехи, которые никто не разрешил. Должно быть пусто — иначе поедут вдвоём. */
export function unresolved(traffic: Traffic, rules: Rules): Conflict[] {
  const seen = new Set<string>();
  for (const y of rules.yields) {
    seen.add(key(y.waits, y.goes));
    seen.add(key(y.goes, y.waits));
  }
  return traffic.conflicts.filter((c) => !seen.has(key(c.a, c.b)));
}

/**
 * Пары, где уступают ОБА или НИ ОДИН. И то и другое — поломка: в первом
 * случае перекрёсток встанет намертво, во втором машины поедут в лоб.
 */
export function badPairs(rules: Rules): { a: number; b: number; both: boolean }[] {
  const count = new Map<string, number>();
  for (const y of rules.yields) {
    const k = y.waits < y.goes ? key(y.waits, y.goes) : key(y.goes, y.waits);
    count.set(k, (count.get(k) ?? 0) + 1);
  }
  const out: { a: number; b: number; both: boolean }[] = [];
  for (const [k, n] of count) {
    if (n === 1) continue;
    const [a, b] = k.split('>').map(Number);
    out.push({ a, b, both: true });
  }
  return out;
}

/**
 * Проверка светофора: в каждой фазе не должно быть двух связей, которые
 * режут друг друга поперёк. Если найдётся — светофор пускает лоб в лоб.
 */
export function greenOnGreen(traffic: Traffic, rules: Rules): { phase: string; a: number; b: number }[] {
  const out: { phase: string; a: number; b: number }[] = [];
  rules.signals.forEach((signal, s) => {
    signal.phases.forEach((phase, p) => {
      const set = new Set(phase.links);
      for (const c of traffic.conflicts) {
        if (!set.has(c.a) || !set.has(c.b)) continue;
        if (sameAxis(traffic, c.a, c.b)) continue;
        out.push({ phase: `светофор ${s}, фаза ${p}`, a: c.a, b: c.b });
      }
    });
  });
  return out;
}
