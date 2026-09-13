/**
 * ДВИЖЕНИЕ: машины едут по сети.
 *
 * Главное устройственное решение здесь одно, и оно убивает целый класс
 * особых случаев:
 *
 *   **Впереди идущая машина, красный сигнал, «уступи дорогу» и пешеход
 *   на переходе — это ОДНО И ТО ЖЕ.** Всё это помеха: «на таком-то
 *   расстоянии впереди нечто движется с такой-то скоростью».
 *
 * Машина не знает, что её тормозит. Она берёт все помехи, выбирает самую
 * тесную и держит от неё безопасную дистанцию. Поэтому «на красный поехал,
 * потому что впереди никого» невыразимо — сигнал и есть «впереди кто-то».
 *
 * Второе решение: **машина не знает своих координат на карте.** Она знает
 * «еду по такому-то пути, столько-то метров от его начала». Именно в этой
 * координате считают все настоящие модели движения, и именно поэтому они
 * считаются быстро. Где это на карте — вопрос показа.
 *
 * Третье: **куда поворачивать, машина решает при ВЪЕЗДЕ на полосу**, а не
 * на перекрёстке. Отсюда она успевает перестроиться. Ровно на этом сломан
 * трафик в Cities: Skylines 2, где машины перестраиваются уже въехав
 * в перекрёсток и перегораживают его целиком.
 *
 * Про экран этот файл не знает ничего.
 */

import type { World } from './world.ts';
import type { Lane, Point3, Traffic, Turn } from './lanes.ts';
import type { Rules } from './rules.ts';
import { lightOf } from './rules.ts';

/** Шаг времени. Фиксированный: иначе поведение зависит от скорости экрана. */
export const STEP = 1 / 30;
/** Насколько водитель тянет с реакцией, секунды. Из модели Краусса. */
const TAU = 1.0;
/** Разгон и комфортное торможение, м/с². */
const ACCEL = 2.2;
const BRAKE = 4.5;
/** Разброс желаемой скорости между водителями, доля. */
const SPREAD = 0.18;
/** Насколько водитель «зевает»: доля от разгона, вычитаемая случайно. */
const DAWDLE = 0.25;
/** Длина машины и запас между бамперами, метры. */
const CAR_LENGTH = 4.4;
const BUMPER = 1.6;
/** Дальше этого вперёд помехи не ищем: всё равно не догоним, метры. */
const LOOK = 140;
/** Какое окно во встречном потоке считается достаточным, секунды. */
const GAP_WANTED = 5.0;
/** До какого окна доходит нетерпеливость через минуту стояния, секунды. */
const GAP_IMPATIENT = 2.4;
/** За сколько секунд нетерпеливость набирается полностью. */
const PATIENCE = 45;
/** Переход стоит на этом расстоянии от конца полосы, метры. */
const CROSSING_BACK = 5.5;
/** Скорость пешехода, м/с. */
const WALK = 1.25;
/** Как часто на переход выходит пешеход, секунды в среднем. */
const PEDESTRIAN_EVERY = 22;
/** Пешеход занимает полосу, пока он от её середины ближе этого, метры. */
const PEDESTRIAN_BODY = 2.2;
/** Сколько секунд занимает перестроение. */
const CHANGE_TIME = 2.2;
/** Обгонять начинаем, если впереди едут медленнее вот на столько, м/с. */
const SLOWER_BY = 2.2;
/** Сколько метров свободного места нужно позади в соседней полосе. */
const BEHIND_NEEDED = 12;

export interface Car {
  readonly id: number;
  /** по чему едет: полоса (`lane`) или дорожка внутри перекрёстка (`link`) */
  lane: number;
  link: number;
  /** метров от начала текущего пути */
  s: number;
  speed: number;
  /** желаемая скорость на этом участке */
  desired: number;
  /** куда собирается свернуть в конце полосы */
  wants: Turn;
  /** какую связь для этого возьмёт; -1 — ещё не выбрана */
  takes: number;
  /** сколько секунд стоит: от этого зависит, какое окно согласится принять */
  waited: number;
  /** перестроение: откуда и сколько осталось, секунды */
  shiftFrom: number;
  shiftLeft: number;
  /** въехал на перекрёсток на красный — это нарушение, и его считают */
  ranRed: boolean;
  readonly hue: number;
}

/**
 * Пешеходный переход.
 *
 * Пешеход не «занимает переход» целиком — он ИДЁТ. В любой момент он
 * перекрывает только ту полосу, по которой сейчас шагает. Иначе один человек
 * на шестиполосном проспекте останавливал бы движение на двадцать секунд,
 * и город вставал бы намертво — это не выдумка, это измерено на первой же
 * попытке.
 */
export interface Crossing {
  readonly id: number;
  /** полосы, которые он пересекает: где по ним стоять и на каком они смещении */
  readonly stops: readonly { lane: number; at: number; offset: number }[];
  /** где сейчас пешеход поперёк дороги, метры от оси; NaN — никого нет */
  walk: number;
  /** в какую сторону идёт */
  dir: number;
  /** середина, для показа */
  readonly x: number;
  readonly y: number;
  readonly z: number;
  readonly nx: number;
  readonly nz: number;
  readonly half: number;
}

export interface Sim {
  readonly cars: Car[];
  readonly crossings: Crossing[];
  time: number;
  /** сколько машин уехало за край мира и сколько родилось */
  left: number;
  born: number;
  /** самое долгое ожидание за всё время, секунды */
  worstWait: number;
  /** столкновения: машины, оказавшиеся в одном месте. Должно быть ноль */
  crashes: number;
}

/** Помеха впереди: расстояние до неё и с какой скоростью она уходит. */
interface Barrier {
  readonly gap: number;
  readonly speed: number;
}

/** Всё, что нужно для одного шага. Считается один раз на мир. */
export interface Roads {
  readonly world: World;
  readonly traffic: Traffic;
  readonly rules: Rules;
  /** для каждой полосы — связи, которые из неё выходят */
  readonly exits: readonly (readonly number[])[];
  /** для каждой полосы — соседние полосы того же направления */
  readonly siblings: readonly (readonly number[])[];
  /** для каждой связи — связи, которым она уступает */
  readonly foes: readonly (readonly number[])[];
  /** для каждой связи — другие связи, вливающиеся в ТУ ЖЕ полосу */
  readonly merging: readonly (readonly number[])[];
  /** въезды: полосы, начинающиеся на краю мира */
  readonly entries: readonly number[];
  /** выезды: полосы, кончающиеся тупиком на краю мира */
  readonly isExit: Uint8Array;
  /**
   * Заведомая поломка для проверки инструмента: машина видит только свой
   * отрезок пути и слепа ко всему, что за его концом — к тем, кто стоит
   * в следующей полосе, и к тем, кто вливается в неё же по соседней дорожке.
   * Тогда столкновения ОБЯЗАНЫ появиться. Если проверка их не увидит —
   * сломана проверка, а не движение (правило 11).
   */
  readonly reckless?: boolean;
}

export function prepare(world: World, traffic: Traffic, rules: Rules): Roads {
  const exits: number[][] = traffic.lanes.map(() => []);
  for (const link of traffic.links) exits[link.from].push(link.id);

  const degree = new Int32Array(world.nodeCount);
  for (const shape of world.shapes) {
    degree[shape.from]++;
    degree[shape.to]++;
  }

  // Соседняя полоса — та же дорога, то же направление, соседний номер.
  // Перестроиться можно только туда: через встречку и через бордюр нельзя,
  // и это не проверка, а свойство списка соседей.
  const byRoad = new Map<string, Lane[]>();
  for (const lane of traffic.lanes) {
    const k = `${lane.road}|${lane.from}`;
    const list = byRoad.get(k);
    if (list) list.push(lane);
    else byRoad.set(k, [lane]);
  }
  const siblings: number[][] = traffic.lanes.map(() => []);
  for (const list of byRoad.values()) {
    const sorted = [...list].sort((a, b) => a.offset - b.offset);
    sorted.forEach((lane, i) => {
      if (i > 0) siblings[lane.id].push(sorted[i - 1].id);
      if (i + 1 < sorted.length) siblings[lane.id].push(sorted[i + 1].id);
    });
  }

  const entries: number[] = [];
  const isExit = new Uint8Array(traffic.lanes.length);
  for (const lane of traffic.lanes) {
    if (degree[lane.from] <= 1) entries.push(lane.id);
    if (degree[lane.to] <= 1) isExit[lane.id] = 1;
  }

  // Кто вливается в ту же полосу. Без этого две машины, подъезжающие
  // к слиянию по разным дорожкам перекрёстка, друг друга не видят вовсе —
  // и встречаются ровно в точке слияния. Измерено: тысяча столкновений
  // за три минуты города.
  const intoLane = new Map<number, number[]>();
  for (const link of traffic.links) {
    const list = intoLane.get(link.to);
    if (list) list.push(link.id);
    else intoLane.set(link.to, [link.id]);
  }
  const merging: number[][] = traffic.links.map((link) =>
    (intoLane.get(link.to) ?? []).filter((id) => id !== link.id));

  return { world, traffic, rules, exits, siblings, foes: rules.yieldTo, merging, entries, isExit };
}

/**
 * Переходы: по одному на каждый въезд дороги в перекрёсток.
 *
 * Место не назначено числом: переход стоит там, где полоса упирается
 * в перекрёсток, отступив на ширину самого перехода. Все полосы одной дороги
 * получают ОДИН переход — иначе пешеход переходил бы каждую полосу отдельно.
 */
export function buildCrossings(world: World, traffic: Traffic): Crossing[] {
  const groups = new Map<string, Lane[]>();
  const degree = new Int32Array(world.nodeCount);
  for (const shape of world.shapes) {
    degree[shape.from]++;
    degree[shape.to]++;
  }
  for (const lane of traffic.lanes) {
    if (degree[lane.to] <= 1) continue;
    if (world.shapes[lane.road].type.rank === 0) continue; // во дворе переходов нет
    const k = `${lane.road}|${lane.to}`;
    const list = groups.get(k);
    if (list) list.push(lane);
    else groups.set(k, [lane]);
  }

  const out: Crossing[] = [];
  for (const list of groups.values()) {
    const stops = list.map((lane) => ({
      lane: lane.id,
      at: Math.max(0, lane.length - CROSSING_BACK),
      offset: lane.offset,
    }));
    const first = list[0];
    const where = Math.max(0, first.length - CROSSING_BACK);
    const p = pointOn(first.path, where);
    const d = directionOn(first.path, where);
    const half = world.shapes[first.road].halfWidth;
    // ось дороги: отходим от полосы на её же смещение
    out.push({
      id: out.length,
      stops,
      walk: NaN,
      dir: 1,
      x: p.x - (-d.z) * first.offset,
      y: p.y,
      z: p.z - d.x * first.offset,
      nx: -d.z,
      nz: d.x,
      half,
    });
  }
  return out;
}

export function newSim(world: World, traffic: Traffic): Sim {
  return {
    cars: [],
    crossings: buildCrossings(world, traffic),
    time: 0,
    left: 0,
    born: 0,
    worstWait: 0,
    crashes: 0,
  };
}

/** Простой повторяемый генератор: одно зерно — один и тот же город. */
function rng(seed: number): () => number {
  let s = seed >>> 0 || 1;
  return () => {
    s ^= s << 13; s >>>= 0;
    s ^= s >> 17;
    s ^= s << 5; s >>>= 0;
    return s / 4294967296;
  };
}

let roll = rng(20260913);

export function reseed(seed: number): void {
  roll = rng(seed);
}

/** Где машина на карте. Считается только для показа. */
export function place(roads: Roads, car: Car): { x: number; y: number; z: number; ax: number; az: number } {
  const path = car.link >= 0
    ? roads.traffic.links[car.link].path
    : roads.traffic.lanes[car.lane].path;
  const p = pointOn(path, car.s);
  const d = directionOn(path, car.s);
  // перестроение видно: машина едет вбок, пока переходит в соседнюю полосу
  let side = 0;
  if (car.shiftLeft > 0 && car.link < 0) {
    const k = car.shiftLeft / CHANGE_TIME;
    side = (car.shiftFrom - roads.traffic.lanes[car.lane].offset) * k;
  }
  return { x: p.x + -d.z * side, y: p.y, z: p.z + d.x * side, ax: d.x, az: d.z };
}

function pointOn(path: readonly Point3[], s: number): Point3 {
  let left = s;
  for (let i = 1; i < path.length; i++) {
    const d = Math.hypot(path[i].x - path[i - 1].x, path[i].z - path[i - 1].z);
    if (left <= d || i === path.length - 1) {
      const t = d > 1e-9 ? Math.min(1, Math.max(0, left / d)) : 0;
      return {
        x: path[i - 1].x + (path[i].x - path[i - 1].x) * t,
        y: path[i - 1].y + (path[i].y - path[i - 1].y) * t,
        z: path[i - 1].z + (path[i].z - path[i - 1].z) * t,
      };
    }
    left -= d;
  }
  return path[path.length - 1];
}

function directionOn(path: readonly Point3[], s: number): { x: number; z: number } {
  let left = s;
  for (let i = 1; i < path.length; i++) {
    const dx = path[i].x - path[i - 1].x, dz = path[i].z - path[i - 1].z;
    const d = Math.hypot(dx, dz);
    if (left <= d || i === path.length - 1) {
      const len = d || 1;
      return { x: dx / len, z: dz / len };
    }
    left -= d;
  }
  return { x: 1, z: 0 };
}

const pathLengthOf = (roads: Roads, car: Car): number =>
  car.link >= 0 ? roads.traffic.links[car.link].length : roads.traffic.lanes[car.lane].length;

/**
 * Безопасная скорость по Крауссу: еду так быстро, как могу, но чтобы успеть
 * остановиться, даже если передний затормозит в пол.
 */
function safeSpeed(gap: number, leadSpeed: number): number {
  const free = gap - BUMPER;
  // Формула Краусса выведена в предположении, что впереди ЕСТЬ место.
  // При нулевом или отрицательном зазоре она честно считает, что передний
  // уедет, и разрешает ехать — на слиянии это давало 3 м/с при нулевом
  // зазоре, то есть въезд друг в друга. Места нет — значит скорость ноль,
  // и это не поправка к формуле, а граница её применимости.
  if (free <= 0) return 0;
  return (-TAU * BRAKE + Math.sqrt(TAU * TAU * BRAKE * BRAKE + leadSpeed * leadSpeed + 2 * BRAKE * free));
}

/** Все машины, разложенные по путям и отсортированные по метражу. */
interface Layout {
  readonly onLane: Map<number, Car[]>;
  readonly onLink: Map<number, Car[]>;
}

function layout(cars: readonly Car[]): Layout {
  const onLane = new Map<number, Car[]>();
  const onLink = new Map<number, Car[]>();
  for (const car of cars) {
    const map = car.link >= 0 ? onLink : onLane;
    const k = car.link >= 0 ? car.link : car.lane;
    const list = map.get(k);
    if (list) list.push(car);
    else map.set(k, [car]);
  }
  for (const list of onLane.values()) list.sort((a, b) => a.s - b.s);
  for (const list of onLink.values()) list.sort((a, b) => a.s - b.s);
  return { onLane, onLink };
}

/**
 * Ближайшая машина впереди, если идти по цепочке путь → связь → путь.
 *
 * Отдельно — СЛИЯНИЕ. Пока машина на дорожке перекрёстка, впереди неё может
 * оказаться не та, что на её же дорожке, а та, что подъезжает к той же полосе
 * по соседней. Они не видят друг друга ни как соседей, ни как помеху: помеха
 * разрешается у стоп-линии, а слияние происходит уже за ней. Кто ближе
 * к точке слияния, тот и впереди — это и есть ответ.
 */
function leader(roads: Roads, lay: Layout, car: Car): Barrier | null {
  let gap = 0;
  // сначала — та же дорожка
  const here = (car.link >= 0 ? lay.onLink.get(car.link) : lay.onLane.get(car.lane)) ?? [];
  let best: Barrier | null = null;
  for (const other of here) {
    if (other.s > car.s + 1e-6) { best = { gap: other.s - car.s - CAR_LENGTH, speed: other.speed }; break; }
  }
  gap += pathLengthOf(roads, car) - car.s;

  // слияние: кто ближе к точке слияния, тот впереди
  if (car.link >= 0 && roads.reckless !== true) {
    const mine = gap;
    for (const other of roads.merging[car.link]) {
      const list = lay.onLink.get(other);
      if (!list) continue;
      for (const rival of list) {
        const theirs = roads.traffic.links[other].length - rival.s;
        if (theirs >= mine) continue;
        const d = mine - theirs - CAR_LENGTH;
        if (best === null || d < best.gap) best = { gap: d, speed: rival.speed };
      }
    }
  }
  if (best !== null) return best;
  // Заведомая поломка: машина видит только свой отрезок и слепа ко всему,
  // что дальше по пути. Тогда на каждом въезде в полосу и в перекрёсток
  // она обязана въехать в того, кто там стоит.
  if (roads.reckless === true) return null;

  // потом — то, что дальше по пути
  let link = car.link >= 0 ? car.link : car.takes;
  let lane = car.link >= 0 ? roads.traffic.links[car.link].to : -1;
  for (let hop = 0; hop < 4 && gap < LOOK; hop++) {
    if (link >= 0 && car.link < 0) {
      const list = lay.onLink.get(link) ?? [];
      if (list.length > 0) return { gap: gap + list[0].s - CAR_LENGTH, speed: list[0].speed };
      gap += roads.traffic.links[link].length;
      lane = roads.traffic.links[link].to;
      link = -1;
    }
    if (lane < 0) break;
    const list = lay.onLane.get(lane) ?? [];
    if (list.length > 0) return { gap: gap + list[0].s - CAR_LENGTH, speed: list[0].speed };
    gap += roads.traffic.lanes[lane].length;
    const outs = roads.exits[lane];
    if (outs.length === 0) break;
    link = outs[0];
    const list2 = lay.onLink.get(link) ?? [];
    if (list2.length > 0) return { gap: gap + list2[0].s - CAR_LENGTH, speed: list2[0].speed };
    gap += roads.traffic.links[link].length;
    lane = roads.traffic.links[link].to;
    link = -1;
  }
  return null;
}

/**
 * Свободен ли перекрёсток для этой связи: нет ли на тех, кому мы уступаем,
 * машины, которая успеет доехать до нас раньше, чем мы проедем.
 *
 * Окно сужается, пока стоим: иначе на оживлённом перекрёстке со второстепенной
 * не выехать никогда. Так же устроено у симуляторов движения.
 */
function clearToGo(roads: Roads, lay: Layout, link: number, waited: number, time: number): boolean {
  const foes = roads.foes[link];
  if (foes.length === 0) return true;
  const impatience = Math.min(1, waited / PATIENCE);
  const wanted = GAP_WANTED + (GAP_IMPATIENT - GAP_WANTED) * impatience;

  for (const foe of foes) {
    // машина уже внутри перекрёстка на мешающей дорожке — ждём всегда
    if ((lay.onLink.get(foe)?.length ?? 0) > 0) return false;
    // если мешающему горит красный, он никуда не поедет
    if (lightOf(roads.rules, foe, time) === 'красный') continue;

    const feeding = roads.traffic.links[foe].from;
    const lane = roads.traffic.lanes[feeding];
    const list = lay.onLane.get(feeding);
    if (!list || list.length === 0) continue;
    const last = list[list.length - 1];
    // СТОЯЩАЯ машина — не помеха. Иначе выходит взаимная блокировка:
    // я жду, потому что он стоит; он стоит, потому что ждёт меня. Измерено
    // на первой же попытке: вся сеть встала за восемнадцать секунд.
    if (last.speed < 1.0) continue;
    const when = (lane.length - last.s) / last.speed;
    if (when < wanted) return false;
  }
  return true;
}

/** Один шаг всего движения. */
export function step(roads: Roads, sim: Sim, dt: number = STEP): void {
  sim.time += dt;
  const lay = layout(sim.cars);

  // --- пешеходы идут через переходы ---
  const blocked = new Map<number, number>();
  for (const crossing of sim.crossings) {
    const edge = crossing.half + 1;
    if (Number.isNaN(crossing.walk)) {
      if (roll() < dt / PEDESTRIAN_EVERY) {
        crossing.dir = roll() < 0.5 ? 1 : -1;
        crossing.walk = -edge * crossing.dir;
      }
      continue;
    }
    crossing.walk += WALK * crossing.dir * dt;
    if (Math.abs(crossing.walk) > edge) {
      crossing.walk = NaN;
      continue;
    }
    // перекрыта только та полоса, по которой пешеход шагает прямо сейчас
    for (const stop of crossing.stops) {
      if (Math.abs(crossing.walk - stop.offset) < PEDESTRIAN_BODY) blocked.set(stop.lane, stop.at);
    }
  }

  const done: Car[] = [];
  for (const car of sim.cars) {
    const barriers: Barrier[] = [];

    const ahead = leader(roads, lay, car);
    if (ahead) barriers.push(ahead);

    if (car.link < 0) {
      const lane = roads.traffic.lanes[car.lane];
      const toEnd = lane.length - car.s;

      // пешеход на переходе — такая же помеха, как машина
      const at = blocked.get(car.lane);
      if (at !== undefined && at > car.s) barriers.push({ gap: at - car.s, speed: 0 });

      if (car.takes >= 0) {
        const light = lightOf(roads.rules, car.takes, sim.time);
        // Жёлтый: останавливаемся, только если успеваем сделать это спокойно.
        // Иначе проезжаем — как в жизни, и как требует безопасность.
        const canStop = toEnd > (car.speed * car.speed) / (2 * BRAKE);
        if (light === 'красный' || (light === 'жёлтый' && canStop)) {
          barriers.push({ gap: toEnd, speed: 0 });
        } else if (light === 'зелёный' && !clearToGo(roads, lay, car.takes, car.waited, sim.time)) {
          barriers.push({ gap: toEnd, speed: 0 });
        } else if (!roads.reckless && occupied(lay.onLane.get(roads.traffic.links[car.takes].to))) {
          // ПДД 13.2: не выезжай на перекрёсток, если за ним нет места.
          //
          // Без этого правила весь город запирается от одной пробки: машина
          // выезжает на перекрёсток, встаёт в нём, и поперечный поток встаёт
          // тоже — хотя у него зелёный. Дальше это расходится по сетке кругами
          // и уже не рассасывается никогда. Измерено: при 120 машинах
          // 88% стояли, средняя скорость 2.5 км/ч.
          //
          // Правило устроено так, что нарушить его нельзя: место за
          // перекрёстком — это условие ВЫЕЗДА, а не проверка после.
          barriers.push({ gap: toEnd, speed: 0 });
        }
      }
      // если ехать некуда, это край мира: машина просто уезжает, а не
      // тормозит в чистом поле
    }

    // --- сама скорость: самая тесная помеха решает ---
    let want = Math.min(car.desired, car.speed + ACCEL * dt);
    for (const b of barriers) want = Math.min(want, safeSpeed(b.gap, b.speed));
    // водитель не идеален: чуть-чуть недожимает
    want -= roll() * DAWDLE * ACCEL * dt;
    car.speed = Math.max(0, Math.min(want, car.speed + ACCEL * dt));
    car.waited = car.speed < 0.4 ? car.waited + dt : 0;
    sim.worstWait = Math.max(sim.worstWait, car.waited);

    if (car.shiftLeft > 0) car.shiftLeft = Math.max(0, car.shiftLeft - dt);
    car.s += car.speed * dt;

    // --- переход на следующий путь ---
    const length = pathLengthOf(roads, car);
    if (car.s >= length) {
      const over = car.s - length;
      if (car.link >= 0) {
        const link = roads.traffic.links[car.link];
        if (!roads.reckless && occupied(lay.onLane.get(link.to))) {
          car.s = length;
          car.speed = 0;
        } else {
          enterLane(roads, car, link.to, over);
          // кладём в новую полосу СРАЗУ: иначе второй, подъезжающий к тому же
          // слиянию по соседней дорожке, в этот же шаг въедет туда же
          insert(lay.onLane, link.to, car);
        }
      } else if (car.takes >= 0) {
        if (!roads.reckless && occupied(lay.onLink.get(car.takes))) {
          car.s = length;
          car.speed = 0;
        } else {
          car.ranRed = lightOf(roads.rules, car.takes, sim.time) === 'красный';
          car.link = car.takes;
          car.takes = -1;
          car.s = over;
          insert(lay.onLink, car.link, car);
        }
      } else {
        done.push(car);
        continue;
      }
    }
  }

  for (const car of done) {
    const i = sim.cars.indexOf(car);
    if (i >= 0) sim.cars.splice(i, 1);
    sim.left++;
  }

  changeLanes(roads, sim, lay);
  sim.crashes += countCrashes(sim.cars);
}

/**
 * Занято ли начало пути. Въехать туда, где уже стоят, нельзя — не потому,
 * что это запрещено проверкой, а потому, что въезда просто не происходит.
 */
/** Кладёт машину в разложенный список так, чтобы порядок по метражу не сбился. */
function insert(map: Map<number, Car[]>, path: number, car: Car): void {
  const list = map.get(path);
  if (!list) {
    map.set(path, [car]);
    return;
  }
  const at = list.findIndex((c) => c.s > car.s);
  list.splice(at < 0 ? list.length : at, 0, car);
}

function occupied(list: readonly Car[] | undefined): boolean {
  return list !== undefined && list.length > 0 && list[0].s < CAR_LENGTH + BUMPER;
}

/** Машина въезжает на полосу: сразу решает, куда свернёт в её конце. */
function enterLane(roads: Roads, car: Car, lane: number, at: number): void {
  car.lane = lane;
  car.link = -1;
  car.s = at;
  car.desired = desiredSpeed(roads, lane);
  chooseTurn(roads, car);
}

function desiredSpeed(roads: Roads, lane: number): number {
  const limit = roads.world.shapes[roads.traffic.lanes[lane].road].type.speed;
  return limit * (1 - SPREAD / 2 + roll() * SPREAD);
}

/**
 * Куда свернуть. Решается ПРИ ВЪЕЗДЕ, а не у перекрёстка — иначе перестроиться
 * уже не успеть. Прямо хочется чаще, разворота почти никогда: так ездят люди.
 */
function chooseTurn(roads: Roads, car: Car): void {
  // Полоса, кончающаяся на краю мира, — выезд. Разворачиваться на ней машина
  // не будет: она уезжает из города. Иначе на границе копится очередь
  // разворачивающихся, которой в жизни нет.
  if (roads.isExit[car.lane] === 1) {
    car.takes = -1;
    return;
  }
  const outs = roads.exits[car.lane];
  if (outs.length === 0) {
    car.takes = -1;
    return;
  }
  const weight = (t: Turn): number =>
    t === 'прямо' ? 6 : t === 'направо' ? 2 : t === 'налево' ? 2 : 0.15;
  // сначала выбираем НАМЕРЕНИЕ по всем полосам своей дороги, потом смотрим,
  // может ли его выполнить наша полоса. Если нет — придётся перестроиться.
  const family = [car.lane, ...roads.siblings[car.lane]];
  const wish: Turn[] = [];
  for (const lane of family) for (const id of roads.exits[lane]) wish.push(roads.traffic.links[id].turn);
  const kinds = [...new Set(wish)];
  let total = kinds.reduce((sum, t) => sum + weight(t), 0);
  let pick = roll() * total;
  let want: Turn = kinds[0] ?? 'прямо';
  for (const t of kinds) {
    pick -= weight(t);
    if (pick <= 0) { want = t; break; }
  }
  car.wants = want;

  const mine = outs.filter((id) => roads.traffic.links[id].turn === want);
  car.takes = mine.length > 0 ? mine[Math.floor(roll() * mine.length)] : outs[Math.floor(roll() * outs.length)];
  if (mine.length === 0) car.wants = roads.traffic.links[car.takes].turn;
}

/**
 * Перестроение: две причины, и обе настоящие.
 *
 * 1. НАДО: моя полоса не ведёт туда, куда я собрался. Решение принято при
 *    въезде, поэтому времени на перестроение хватает.
 * 2. ХОЧУ: впереди едут заметно медленнее, а в соседней полосе свободно.
 *    Это и есть обгон.
 *
 * Перестроиться можно только туда, где сзади и спереди есть место. «Подрезал»
 * невыразимо: если места нет, перестроения просто не происходит.
 */
function changeLanes(roads: Roads, sim: Sim, lay: Layout): void {
  for (const car of sim.cars) {
    if (car.link >= 0 || car.shiftLeft > 0) continue;
    const lane = roads.traffic.lanes[car.lane];
    const toEnd = lane.length - car.s;
    if (toEnd < 12) continue; // у самого перекрёстка уже поздно

    const mustMove = car.takes >= 0 && roads.traffic.links[car.takes].turn !== car.wants;
    const ahead = leader(roads, lay, car);
    const slow = ahead !== null && ahead.gap < 45 && ahead.speed < car.desired - SLOWER_BY;
    if (!mustMove && !slow) continue;

    for (const other of roads.siblings[car.lane]) {
      // если надо — идём только туда, откуда можно выполнить намерение
      if (mustMove && !roads.exits[other].some((id) => roads.traffic.links[id].turn === car.wants)) continue;
      if (!roomIn(roads, lay, other, car)) continue;
      if (!mustMove) {
        // ради обгона перестраиваемся, только если там правда свободнее
        const there = nextOn(lay, other, car.s);
        if (there !== null && there.s - car.s < 45 && there.speed < car.desired - SLOWER_BY) continue;
      }
      car.shiftFrom = lane.offset;
      car.shiftLeft = CHANGE_TIME;
      const wasOn = lay.onLane.get(car.lane);
      if (wasOn) {
        const i = wasOn.indexOf(car);
        if (i >= 0) wasOn.splice(i, 1);
      }
      car.lane = other;
      car.s = Math.min(car.s, roads.traffic.lanes[other].length - 0.5);
      chooseTurn(roads, car);
      // кладём в новую полосу СРАЗУ: иначе следующий в этом же шаге
      // перестроится в то же самое место
      const nowOn = lay.onLane.get(other);
      if (nowOn) {
        const at = nowOn.findIndex((c) => c.s > car.s);
        nowOn.splice(at < 0 ? nowOn.length : at, 0, car);
      } else {
        lay.onLane.set(other, [car]);
      }
      break;
    }
  }
}

function nextOn(lay: Layout, lane: number, s: number): Car | null {
  const list = lay.onLane.get(lane);
  if (!list) return null;
  for (const car of list) if (car.s > s) return car;
  return null;
}

function roomIn(roads: Roads, lay: Layout, lane: number, car: Car): boolean {
  const list = lay.onLane.get(lane) ?? [];
  const need = Math.max(BEHIND_NEEDED, car.speed * 1.2);
  for (const other of list) {
    const d = other.s - car.s;
    if (d >= 0 && d < CAR_LENGTH + BUMPER + car.speed * TAU) return false;
    if (d < 0 && -d < need) return false;
  }
  void roads;
  return true;
}

/** Две машины в одном месте на одном пути. Должно быть ноль всегда. */
function countCrashes(cars: readonly Car[]): number {
  const lay = layout(cars);
  let count = 0;
  for (const list of [...lay.onLane.values(), ...lay.onLink.values()]) {
    for (let i = 1; i < list.length; i++) {
      if (list[i].s - list[i - 1].s < CAR_LENGTH * 0.6) count++;
    }
  }
  return count;
}

/**
 * Подсыпает машины на въездах, пока их меньше нужного.
 * Машина не рождается там, где уже кто-то стоит: «две машины в одной точке»
 * невыразимо, а не ловится потом.
 */
export function feed(roads: Roads, sim: Sim, wanted: number): void {
  if (sim.cars.length >= wanted || roads.entries.length === 0) return;
  const lay = layout(sim.cars);
  const tries = Math.min(4, wanted - sim.cars.length);
  for (let t = 0; t < tries; t++) {
    const lane = roads.entries[Math.floor(roll() * roads.entries.length)];
    const list = lay.onLane.get(lane) ?? [];
    if (list.length > 0 && list[0].s < CAR_LENGTH * 3) continue;
    const car: Car = {
      id: sim.born,
      lane,
      link: -1,
      s: 0,
      speed: desiredSpeed(roads, lane) * 0.8,
      desired: desiredSpeed(roads, lane),
      wants: 'прямо',
      takes: -1,
      waited: 0,
      shiftFrom: 0,
      shiftLeft: 0,
      ranRed: false,
      hue: roll(),
    };
    chooseTurn(roads, car);
    sim.cars.push(car);
    sim.born++;
    const here = lay.onLane.get(lane);
    if (here) here.unshift(car);
    else lay.onLane.set(lane, [car]);
  }
}

export { CAR_LENGTH };
