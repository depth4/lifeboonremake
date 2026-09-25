/**
 * Пешеходы: ходят по тротуарам и переходят дорогу на перекрёстках.
 *
 * Третий уровень подробности: точка, которая идёт вдоль дороги по своей
 * стороне и на узле либо сворачивает, либо переходит на другую сторону.
 * Ни сил, ни толкотни, ни обхода друг друга — это следующий слой, если
 * понадобится. Сейчас нужно, чтобы город не был пустым и чтобы машина
 * кого-то пропускала.
 *
 * Скорость взята из норм проектирования переходов: расчётный пешеход идёт
 * 1.0–1.4 м/с, и время зелёного для него считают именно по этой цифре.
 */

import type { World } from '../world/world.ts';
import { type Network, along } from './traffic.ts';
import { type Маршрут, дальше } from './путь.ts';
import { walkLight } from './signals.ts';

/** Быстрее этого никто не идёт, м/с. */
const PACE = 1.35;
/** Ширина перехода: в неё пешеход должен уложиться. */
const CROSS_SPEED = 1.2;
/**
 * Длина шага, м. Средний взрослый — 0.75 м; за полный цикл (левой и правой)
 * проходится два шага.
 */
export const ШАГ = 0.75;

export interface Walker {
  /** По какой дороге идёт вдоль. */
  shape: number;
  /** Метров от начала дороги. */
  s: number;
  /** В какую сторону идёт по s. */
  dir: number;
  /** По какой стороне: +1 право по возрастанию s, −1 лево. */
  side: number;
  speed: number;
  /** Если переходит дорогу: сколько уже прошёл поперёк, доля. */
  crossing: number;
  /** Рубашка, штаны и кожа: человек не одноцветный. */
  colour: number;
  штаны: number;
  кожа: number;
  /**
   * Сколько метров прошёл всего. Из этого ВЫЧИСЛЯЕТСЯ фаза шага — и ноги
   * не могут разъехаться с положением: путь один, и он же двигает человека.
   * Хранить отдельно «фазу» значило бы завести вторую правду о том же самом.
   */
  путь: number;
  seed: number;
  /**
   * Чей это человек: номер жителя, или −1 — ничей.
   *
   * Ничей ходит по тротуару наугад: ему некуда идти, и это честно —
   * на сцене без домов дел не бывает. У жителя есть дело, и он идёт к нему
   * по маршруту. «Пешеход, идущий ниоткуда в никуда» у жителя невыразим.
   */
  житель: number;
  /** Рост в долях взрослого: ребёнок в сад ниже школьника, школьник — взрослого. */
  рост: number;
  /** Куда идёт и по каким улицам. null — некуда, значит наугад. */
  маршрут: Маршрут | null;
  /** Чем занят: для проверок. */
  state: 'идёт' | 'ждёт' | 'переходит' | 'пришёл';
}

/**
 * Фаза шага, радианы. Полный цикл — два шага, поэтому делится на 2 × ШАГ.
 * Стоящий человек фазу не двигает: путь не растёт.
 */
export const фазаШага = (w: Walker): number => (w.путь / (2 * ШАГ)) * 2 * Math.PI;

/**
 * Одежда. Верх берётся из СВЕТЛОГО набора, низ — из ТЁМНОГО, и это не вкус,
 * а устройство: пока наборы не пересекаются, «человек одного тона от шеи до
 * пят» невыразим. Первая редакция брала оба цвета из одного списка, и
 * половина прохожих вышла тёмными монолитами, у которых не видно, где
 * кончается куртка.
 */
export const ОДЕЖДА = [0x8a99a8, 0xb5714f, 0xc9bda4, 0x5d8f6d, 0xa8414c, 0x6f7c93, 0xd6c98f, 0x4f6f96];
export const ШТАНЫ = [0x24282e, 0x3b3f4a, 0x4a4036, 0x2e3a33, 0x413a44, 0x1e2126];
export const КОЖА = [0xe0b48f, 0xc68e63, 0x8d5a3b, 0xf0cfae, 0x6b4227];
const CLOTHES = ОДЕЖДА;

function roll(w: Walker): number {
  w.seed = (w.seed * 16807) % 2147483647;
  return w.seed / 2147483647;
}

export function placeWalkers(world: World, net: Network, count: number, seed = 3): Walker[] {
  let rnd = (seed * 7919) % 2147483647;
  const next = (): number => { rnd = (rnd * 16807) % 2147483647; return rnd / 2147483647; };

  const walkers: Walker[] = [];
  for (let attempt = 0; attempt < count * 30 && walkers.length < count; attempt++) {
    const shape = Math.floor(next() * world.shapes.length) % world.shapes.length;
    const total = net.length[shape];
    if (total < 25) continue;
    walkers.push({
      shape,
      s: 6 + next() * (total - 12),
      dir: next() < 0.5 ? 1 : -1,
      side: next() < 0.5 ? 1 : -1,
      speed: PACE * (0.65 + next() * 0.5),
      crossing: 0,
      colour: CLOTHES[Math.floor(next() * CLOTHES.length) % CLOTHES.length],
      штаны: ШТАНЫ[Math.floor(next() * ШТАНЫ.length) % ШТАНЫ.length],
      кожа: КОЖА[Math.floor(next() * КОЖА.length) % КОЖА.length],
      путь: next() * 4,
      seed: Math.floor(next() * 2147483647),
      житель: -1,
      рост: 1,
      маршрут: null,
      state: 'идёт',
    });
  }
  return walkers;
}

/**
 * По какой линии идёт пешеход: ПО СЕРЕДИНЕ ТРОТУАРА.
 *
 * Одно определение на весь файл. Раньше их было два: положение считалось от
 * этой линии, а ШИРИНА ПЕРЕХОДА — от края полотна. Переход выходил длиннее,
 * чем расстояние, которое человек проходит, и ноги отставали от него на
 * полсантиметра за кадр. Пока мера одна, разойтись нечему.
 *
 * Середина, а не «внешний край минус 1.1». Полтора метра были подобраны
 * под тротуар в два с половиной метра и на узком врали: у метрового
 * тротуара внутриквартального проезда человек оказывался на десять
 * сантиметров ВНУТРИ проезжей части. Середина тротуара такого состояния
 * не допускает ни при какой его ширине.
 */
const тротуар = (world: World, shape: number): number => {
  const sh = world.shapes[shape];
  return (sh.halfWidth + sh.outerHalf) / 2;
};

/** Где на земле оказывается точка тротуара — по дороге, метке вдоль и стороне. */
function наТротуаре(
  world: World, shape: number, s: number, side: number, crossing: number,
): { x: number; z: number } {
  const spot = along(world, shape, s);
  // при переходе едем от своей стороны к противоположной
  const offset = тротуар(world, shape) * (side * (1 - 2 * crossing));
  // право по ходу возрастания s — это (−fz, fx)
  return { x: spot.x - spot.fz * offset, z: spot.z + spot.fx * offset };
}

/**
 * Насколько тротуар ДЛИННЕЕ осевой в этом месте.
 *
 * На повороте внешний тротуар длиннее осевой, внутренний короче — и заметно:
 * на «каше» расхождение доходило до полуметра за кадр, то есть человек то
 * летел, то полз. Раньше скорость отмерялась по осевой, а шёл он по тротуару:
 * две разные меры одного движения.
 *
 * Считается ТОЙ ЖЕ функцией, которая ставит человека на землю, поэтому
 * разойтись с ней не может: это не формула кривизны рядом, а сама геометрия.
 */
function растяжение(world: World, shape: number, s: number, side: number, crossing: number): number {
  const ПРОБА = 0.5;
  const a = наТротуаре(world, shape, s, side, crossing);
  const b = наТротуаре(world, shape, s + ПРОБА, side, crossing);
  const длина = Math.hypot(b.x - a.x, b.z - a.z) / ПРОБА;
  // у самого центра крутого поворота тротуар вырождается: дальше 4× не пускаем
  return Math.min(4, Math.max(0.25, длина));
}

/** Где пешеход стоит и куда смотрит. */
export function walkerPose(world: World, w: Walker): { x: number; z: number; yaw: number } {
  const spot = along(world, w.shape, w.s);
  const точка = наТротуаре(world, w.shape, w.s, w.side, w.crossing);
  const heading = w.crossing > 0
    ? Math.atan2(spot.fx * -w.side, spot.fz * w.side) + Math.PI / 2
    : Math.atan2(spot.fz * w.dir, spot.fx * w.dir);
  return { x: точка.x, z: точка.z, yaw: heading };
}

/**
 * Шаг всех пешеходов. Переходят они только на перекрёстке и только когда
 * их пускает светофор — тот же, что держит машины, только смотрится с
 * другой стороны: пешеходу зелёный тогда, когда красный тем, кого он
 * пересекает.
 */
export function moveWalkers(
  world: World, net: Network, walkers: Walker[], dt: number, time: number,
  /**
   * `походка: 'по часам'` — считать путь временем, а не расстоянием. Заведомо
   * сломанный вариант: тогда стоящий на светофоре продолжает перебирать ногами,
   * а бегущий и плетущийся шагают одинаково.
   */
  options: { походка?: 'по часам' } = {},
): void {
  const поЧасам = options.походка === 'по часам';
  for (const w of walkers) {
    /**
     * Дошедший не двигается вовсе. Без этого он ставил себе «пришёл»,
     * а на следующем кадре первым же делом писал «идёт» и шёл дальше
     * сквозь свою цель. Выход должен стоять ДО всего остального.
     */
    if (w.state === 'пришёл') continue;
    if (поЧасам) w.путь += PACE * dt;
    const total = net.length[w.shape];

    if (w.crossing > 0) {
      w.state = 'переходит';
      // переход — это путь от тротуара до тротуара, то есть ровно 2 × линия
      w.crossing += (CROSS_SPEED * dt) / Math.max(2, тротуар(world, w.shape) * 2);
      if (!поЧасам) w.путь += CROSS_SPEED * dt;
      if (w.crossing >= 1) { w.crossing = 0; w.side = -w.side; w.state = 'идёт'; }
      continue;
    }

    w.state = 'идёт';
    // скорость — это метры по земле; по осевой их надо отмерить с поправкой
    const вдоль = (w.speed * dt) / растяжение(world, w.shape, w.s, w.side, w.crossing);
    w.s += вдоль * w.dir;
    if (!поЧасам) w.путь += w.speed * dt;

    /**
     * ПРИШЁЛ. У кого есть маршрут — тот идёт К ТОЧКЕ, а не до конца улицы.
     * «Дошёл» — это поравнялся со своим подъездом на своей улице, а не
     * «упёрся в перекрёсток». Без этого человек доходил до цели, проходил
     * её насквозь и уходил гулять дальше: замерено, на десятой минуте он
     * был в тринадцати метрах от дела, а на пятнадцатой — в двухстах.
     */
    const своя = w.маршрут !== null && дальше(w.маршрут, w.shape) === null;
    const нужнаяСторона = w.маршрут === null ? 0 : Math.sign(w.маршрут.цель.across ?? 0);
    const наСвоейСтороне = нужнаяСторона === 0 || нужнаяСторона === w.side;
    if (своя && наСвоейСтороне && Math.abs(w.s - w.маршрут!.цель.s) < 2.5) {
      w.state = 'пришёл';
      continue;
    }

    /**
     * СВОЯ УЛИЦА, НО ЧУЖАЯ СТОРОНА — переходим, пока не ушли от перехода.
     *
     * Сторона улицы и есть разница между «пришёл домой» и «стою напротив
     * дома». Первая редакция засчитывала приход по одному только метру вдоль
     * улицы — и половина города приходила к дому напротив своего.
     *
     * Переходим у перекрёстка: там переход, и только там. И только на зелёный,
     * по тем же правилам, что у всех.
     */
    if (своя && !наСвоейСтороне) {
      const уПерехода = net.nodes[w.shape]
        .find((n) => Math.abs(n.s - w.s) < тротуар(world, w.shape) + 4);
      if (уПерехода !== undefined) {
        const signal = net.signals.find((sg) => sg.junction === уПерехода.junction);
        const approach = signal?.approaches.find((a) => a.shape === w.shape);
        const зелёный = signal === undefined || approach === undefined
          ? true
          : walkLight(signal, approach.group, time).light === 'зелёный';
        if (зелёный) { w.crossing = 1e-4; continue; }
        w.state = 'ждёт';
        w.s -= вдоль * w.dir;
        if (!поЧасам) w.путь -= w.speed * dt;
        continue;
      }
    }

    /**
     * Решение принимается на УГЛУ ТРОТУАРА, а не у центра перекрёстка.
     * Иначе пешеход доходит до середины поперечной проезжей части и там
     * разворачивается — то есть гуляет по дороге.
     */
    const corner = world.shapes[w.shape].outerHalf + 1;
    const atEnd = w.dir > 0 ? w.s > total - corner : w.s < corner;
    if (!atEnd) continue;

    const endS = w.dir > 0 ? total : 0;
    const node = net.nodes[w.shape].find((n) => Math.abs(n.s - endS) < 8);
    if (node === undefined) { w.dir = -w.dir; continue; }

    /**
     * КУДА СВОРАЧИВАТЬ — из маршрута, если он есть.
     *
     * Наугад сворачивает только тот, кому некуда идти. Пока сворачивали все
     * наугад, «город работает» было неправдой: машины уже ехали по делам,
     * а люди бродили кругами по тому же тротуару.
     */
    const поМаршруту = w.маршрут === null ? null : дальше(w.маршрут, w.shape);
    if (поМаршруту !== null) {
      const ветка = net.atJunction[node.junction].find((l) => l.shape === поМаршруту);
      if (ветка !== undefined) {
        const хвост = net.length[ветка.shape];
        w.shape = ветка.shape;
        w.s = ветка.s;
        /**
         * На ПОСЛЕДНЕЙ улице идём к своей точке, а не «вглубь улицы».
         * Иначе человек сворачивает правильно, а потом уходит в другую
         * сторону от собственного подъезда.
         */
        const последняя = w.маршрут !== null && дальше(w.маршрут, ветка.shape) === null;
        w.dir = последняя && w.маршрут !== null
          ? (w.маршрут.цель.s > ветка.s ? 1 : -1)
          : (ветка.s < хвост / 2 ? 1 : -1);
        // встаём у самого перехода: если сторона не та, отсюда и перейдём
        w.s += w.dir * (тротуар(world, ветка.shape) + 1);
        continue;
      }
    }

    // своя улица, свой берег, а улица кончилась — значит цель позади
    if (w.маршрут !== null && поМаршруту === null) {
      w.dir = -w.dir;
      w.s += w.dir * 1.5;
      continue;
    }

    const decision = roll(w);
    if (decision < 0.45) {
      // перейти дорогу поперёк — если пускает светофор
      const signal = net.signals.find((sg) => sg.junction === node.junction);
      const approach = signal?.approaches.find((a) => a.shape === w.shape);
      const green = signal === undefined || approach === undefined
        ? true
        : walkLight(signal, approach.group, time).light === 'зелёный';
      if (green) { w.crossing = 1e-4; }
      else {
        w.state = 'ждёт';
        w.s -= вдоль * w.dir;
        if (!поЧасам) w.путь -= w.speed * dt;
      }
      continue;
    }

    // свернуть на другую улицу или пойти обратно
    const exits = net.atJunction[node.junction].filter((l) => l.shape !== w.shape);
    if (exits.length > 0 && decision < 0.9) {
      const pick = exits[Math.floor(roll(w) * exits.length) % exits.length];
      const tail = net.length[pick.shape];
      w.shape = pick.shape;
      w.s = pick.s;
      w.dir = pick.s < tail / 2 ? 1 : -1;
      w.s += w.dir * (world.shapes[pick.shape].outerHalf + 1);
      if (roll(w) < 0.5) w.side = -w.side;
    } else {
      w.dir = -w.dir;
      w.s += w.dir * 1.5;
    }
  }
}
