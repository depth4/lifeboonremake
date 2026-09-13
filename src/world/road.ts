/**
 * Дорога = осевая линия + список полос.
 * Асфальт нигде не хранится: он считается из этих двух вещей.
 * Про экран и про Three.js этот файл не знает ничего.
 */

export interface Point2 {
  readonly x: number;
  readonly z: number;
}

export type LaneKind = 'travel' | 'marking' | 'median';

/** Одна полоса вдоль осевой линии. */
export interface Lane {
  readonly kind: LaneKind;
  /** метры */
  readonly width: number;
  /** 1 — по направлению линии, -1 — навстречу, 0 — не для езды */
  readonly direction: -1 | 0 | 1;
  /**
   * На сколько метров полоса поднята над проезжей частью.
   * Бордюр не рисуется отдельно: он возникает сам там, где у соседних
   * полос разная высота. Особый случай «бордюр» в правилах не нужен.
   */
  readonly rise: number;
}

/**
 * Тип дороги — это данные, а не код.
 *
 * ВАЖНО: `lanes` — это только ПРОЕЗЖАЯ ЧАСТЬ. Тротуар сюда не входит:
 * это отдельный объект со своими правилами, который идёт снаружи проезжей
 * части и огибает перекрёстки дугой. Пока тротуар был внутри ширины дороги,
 * на остром угле он упирался в соседнюю дорогу и постройка срывалась.
 */
export interface RoadType {
  readonly name: string;
  readonly lanes: readonly Lane[];
  /** ширина тротуара с каждой стороны, 0 — тротуара нет */
  readonly sidewalk: number;
  /** высота бордюра над проезжей частью */
  readonly curb: number;
  /**
   * Разрешённая скорость, метры в секунду.
   * Не для красоты: из неё считаются и длина жёлтого сигнала, и дистанция
   * между машинами, и то, какое окно на перекрёстке считать достаточным.
   */
  readonly speed: number;
  /**
   * Старшинство дороги. Чем больше, тем главнее. Считается из числа полос,
   * а не назначается: «главная дорога» и «дорога пошире» в городе — почти
   * всегда одно и то же, и второе можно посчитать.
   */
  readonly rank: number;
}

/** Сколько проходов разгибания поворотов. */
const CURVE_PASSES = 400;

const MARK = 0.16;
const CURB = 0.15;

/**
 * Тип дороги по числу полос в каждую сторону.
 * Ширина — не отдельное свойство: она складывается из списка полос.
 * Поэтому «дорога шириной 3.7 полосы» невыразима.
 */
export function roadTypeForLanes(perSide: number): RoadType {
  const n = Math.max(1, Math.min(4, Math.round(perSide)));
  const travel = (direction: -1 | 1): Lane => ({ kind: 'travel', width: 3.5, direction, rise: 0 });
  const mark: Lane = { kind: 'marking', width: MARK, direction: 0, rise: 0 };

  const side = (direction: -1 | 1): Lane[] => {
    const lanes: Lane[] = [];
    for (let i = 0; i < n; i++) {
      if (i > 0) lanes.push(mark);
      lanes.push(travel(direction));
    }
    return lanes;
  };

  const middle: Lane[] = n >= 2
    ? [{ kind: 'median', width: 2.0, direction: 0, rise: CURB }]
    : [mark];

  // Движение правостороннее: при взгляде сверху ось x идёт вправо, ось z вниз,
  // поэтому едущие «по линии» полосы лежат в ПОЛОЖИТЕЛЬНЫХ смещениях —
  // справа по ходу. Отсюда же считается, на каких полосах стоп-линия.
  return {
    name: n === 1 ? 'улица, 2 полосы' : `дорога, ${n * 2} полос`,
    lanes: [...side(-1), ...middle, ...side(1)],
    sidewalk: n >= 3 ? 3.2 : 2.4,
    curb: CURB,
    // 60 км/ч — городская норма; на многополосной шире и быстрее
    speed: n >= 3 ? 70 / 3.6 : 60 / 3.6,
    rank: n,
  };
}

/**
 * Дворовый проезд: по полосе в каждую сторону, узкие, тротуар с одной
 * шириной пешеходной дорожки, скорость 20 км/ч.
 *
 * Это ДАННЫЕ, а не особый случай в правилах: всё остальное устройство
 * про него ничего не знает и знать не должно. Отдельный тип нужен потому,
 * что двор — это не «улица поуже»: у него другая скорость, другое
 * старшинство (выезд со двора уступает всем) и полосы по 2.75 м.
 */
export function courtyardType(): RoadType {
  const lane = (direction: -1 | 1): Lane => ({ kind: 'travel', width: 2.75, direction, rise: 0 });
  return {
    name: 'дворовый проезд',
    lanes: [lane(-1), lane(1)],
    sidewalk: 1.5,
    curb: CURB,
    speed: 20 / 3.6,
    rank: 0,
  };
}

export interface Road {
  /** опорные точки; между ними линия идёт плавной кривой */
  readonly centerline: readonly Point2[];
  readonly type: RoadType;
}

export function roadWidth(type: RoadType): number {
  return type.lanes.reduce((sum, lane) => sum + lane.width, 0);
}

/** Полоса, разложенная в смещения от осевой линии: от -полуширины до +полуширины. */
export interface Band {
  readonly kind: LaneKind;
  readonly from: number;
  readonly to: number;
  readonly rise: number;
  /** 1 — едут по направлению линии, -1 — навстречу, 0 — не для езды */
  readonly direction: -1 | 0 | 1;
}

export function bands(type: RoadType): Band[] {
  let offset = -roadWidth(type) / 2;
  return type.lanes.map((lane) => {
    const band = {
      kind: lane.kind,
      from: offset,
      to: offset + lane.width,
      rise: lane.rise,
      direction: lane.direction,
    };
    offset += lane.width;
    return band;
  });
}

/** Точка на осевой линии: где она, куда смотрит поперёк, сколько метров от начала. */
export interface Station {
  readonly x: number;
  readonly z: number;
  /** единичный вектор поперёк дороги */
  readonly nx: number;
  readonly nz: number;
  /** метров от начала дороги */
  readonly s: number;
}

/**
 * Плавная кривая через опорные точки — ЦЕНТРОСТРЕМИТЕЛЬНАЯ.
 *
 * Обычная кривая Catmull-Rom при неровно расставленных точках вылетает
 * за них петлёй: на зигзаге из четырёх кликов она заворачивается сама на себя.
 * Петлю потом нельзя разогнуть ничем — суммарный поворот у кривой сохраняется,
 * и радиус остаётся крошечным, сколько ни сглаживай. Измерено: 1.3 метра
 * при пределе 32.
 *
 * У центростремительного варианта (шаг узла — корень из расстояния) доказано,
 * что петель и изломов не бывает вовсе. Поэтому «дорога завернулась сама
 * на себя» перестало быть выразимым, а не стало ловиться.
 */
function centripetal(p0: Point2, p1: Point2, p2: Point2, p3: Point2, t: number): Point2 {
  const knot = (prev: number, a: Point2, b: Point2): number =>
    prev + Math.sqrt(Math.hypot(b.x - a.x, b.z - a.z)) || prev + 1e-6;
  const t0 = 0;
  const t1 = knot(t0, p0, p1);
  const t2 = knot(t1, p1, p2);
  const t3 = knot(t2, p2, p3);
  if (t1 - t0 < 1e-9 || t2 - t1 < 1e-9 || t3 - t2 < 1e-9) {
    return { x: p1.x + (p2.x - p1.x) * t, z: p1.z + (p2.z - p1.z) * t };
  }
  const at = t1 + (t2 - t1) * t;
  const mix = (a: Point2, b: Point2, ta: number, tb: number): Point2 => {
    const k = (tb - at) / (tb - ta);
    return { x: a.x * k + b.x * (1 - k), z: a.z * k + b.z * (1 - k) };
  };
  const a1 = mix(p0, p1, t0, t1);
  const a2 = mix(p1, p2, t1, t2);
  const a3 = mix(p2, p3, t2, t3);
  const b1 = mix(a1, a2, t0, t2);
  const b2 = mix(a2, a3, t1, t3);
  return mix(b1, b2, t1, t2);
}

/**
 * Раскладывает ломаную заново — через равные промежутки по длине.
 *
 * Без этого точки ложатся как попало: там, где кривая почти стоит на месте,
 * они сбиваются в кучу по десять сантиметров, а на разгоне разъезжаются на
 * четыре метра. От неровного шага ломается всё, что считает по соседним
 * точкам: радиус поворота из трёх точек в десяти сантиметрах друг от друга
 * не значит ничего, и предел поворота на такой ломаной не работал вовсе.
 */
export function resample(line: readonly Point2[], spacing: number): Point2[] {
  if (line.length < 2 || spacing <= 0) return line.map((p) => ({ x: p.x, z: p.z }));
  let total = 0;
  for (let i = 1; i < line.length; i++) total += Math.hypot(line[i].x - line[i - 1].x, line[i].z - line[i - 1].z);
  if (total < 1e-6) return [{ x: line[0].x, z: line[0].z }];

  const steps = Math.max(1, Math.round(total / spacing));
  const step = total / steps;
  const out: Point2[] = [{ x: line[0].x, z: line[0].z }];
  let at = 0;
  let walked = 0;
  for (let k = 1; k < steps; k++) {
    const want = k * step;
    while (at + 1 < line.length - 1) {
      const d = Math.hypot(line[at + 1].x - line[at].x, line[at + 1].z - line[at].z);
      if (walked + d >= want) break;
      walked += d;
      at++;
    }
    const d = Math.hypot(line[at + 1].x - line[at].x, line[at + 1].z - line[at].z);
    const t = d > 1e-9 ? (want - walked) / d : 0;
    out.push({
      x: line[at].x + (line[at + 1].x - line[at].x) * t,
      z: line[at].z + (line[at + 1].z - line[at].z) * t,
    });
  }
  out.push({ x: line[line.length - 1].x, z: line[line.length - 1].z });
  return out;
}

/**
 * Разгибает повороты круче допустимого.
 *
 * У дороги есть предел не только по подъёму, но и по повороту: она не может
 * завернуть вокруг круга уже, чем сама. Иначе внутренний край полотна
 * заворачивается сам на себя, поверхность встаёт пандусом, и на ней появляется
 * ступенька — измерено, до 166% при пределе 8%.
 *
 * Круче предела точка подтягивается к середине между соседями — ровно
 * настолько, насколько не хватает. Концы не двигаются: они держат узлы сети.
 *
 * Это не сглаживание «на всякий случай»: пока поворот в пределах, линия
 * остаётся точно такой, какой её нарисовали.
 */
export function limitCurvature(line: readonly Point2[], minRadius: number): Point2[] {
  let p = line.map((q) => ({ x: q.x, z: q.z }));
  if (p.length < 3 || minRadius <= 0) return p;

  // шаг, с которым точки стояли изначально: разгибая угол, мы их сбиваем
  // в кучу на внутренней стороне, и радиус из трёх соседних точек снова
  // перестаёт что-либо значить. Поэтому по ходу дела раскладываем заново.
  let total = 0;
  for (let i = 1; i < p.length; i++) total += Math.hypot(p[i].x - p[i - 1].x, p[i].z - p[i - 1].z);
  const step = total / (p.length - 1);

  // Правится на месте, а не через копию: так поправка добегает по цепочке
  // за один проход, а не по одной точке за проход. Виток спирали из полусотни
  // точек копией разгибался бы тысячу проходов.
  for (let pass = 0; pass < CURVE_PASSES; pass++) {
    let worst = 0;
    for (let dir = 0; dir < 2; dir++) {
      for (let k = 1; k + 1 < p.length; k++) {
        const i = dir === 0 ? k : p.length - 1 - k;
        const ax = p[i].x - p[i - 1].x, az = p[i].z - p[i - 1].z;
        const bx = p[i + 1].x - p[i].x, bz = p[i + 1].z - p[i].z;
        const la = Math.hypot(ax, az), lb = Math.hypot(bx, bz);
        if (la < 1e-6 || lb < 1e-6) continue;
        const turn = Math.abs(Math.atan2(ax * bz - az * bx, ax * bx + az * bz));
        if (turn < 1e-9) continue;
        const radius = (la + lb) / 2 / turn;
        if (radius >= minRadius) continue;
        // насколько не хватает — настолько и тянем
        const pull = Math.min(0.55, 0.55 * (1 - radius / minRadius));
        p[i].x += ((p[i - 1].x + p[i + 1].x) / 2 - p[i].x) * pull;
        p[i].z += ((p[i - 1].z + p[i + 1].z) / 2 - p[i].z) * pull;
        worst = Math.max(worst, 1 - radius / minRadius);
      }
    }
    if (worst < 0.02) break;
    if (pass % 8 === 7 && step > 1e-6) p = resample(p, step);
  }
  return p;
}

/** Превращает готовую ломаную в станции: с поперечным направлением и метражом. */
export function stationsFromLine(raw: readonly Point2[]): Station[] {
  const stations: Station[] = [];
  let travelled = 0;
  for (let i = 0; i < raw.length; i++) {
    const prev = raw[Math.max(0, i - 1)];
    const next = raw[Math.min(raw.length - 1, i + 1)];
    let tx = next.x - prev.x;
    let tz = next.z - prev.z;
    const len = Math.hypot(tx, tz) || 1;
    tx /= len;
    tz /= len;
    if (i > 0) travelled += Math.hypot(raw[i].x - raw[i - 1].x, raw[i].z - raw[i - 1].z);
    stations.push({ x: raw[i].x, z: raw[i].z, nx: -tz, nz: tx, s: travelled });
  }
  return stations;
}

/**
 * ЕДИНСТВЕННОЕ место, где «вдоль дороги и вбок» превращается в место на карте.
 *
 * У дороги своя система координат: `s` — сколько метров проехали вдоль осевой
 * линии, `t` — сколько метров вбок от неё. Так устроено везде, где дороги
 * делают всерьёз: полосы, знаки, светофоры, машины — всё задаётся в (s, t),
 * а не в (x, z).
 *
 * Смысл именно в том, что таких мест ДОЛЖНО быть одно. Пока этот пересчёт
 * переписывался на каждом углу, «предмет разъехался с дорогой» было делом
 * времени; теперь у всех, кто стоит на дороге, один и тот же ответ.
 */
export function at(st: Station, t: number): Point2 {
  return { x: st.x + st.nx * t, z: st.z + st.nz * t };
}

/** Единичный вектор ВДОЛЬ дороги в этой станции, по направлению роста `s`. */
export function forward(st: Station): Point2 {
  return { x: st.nz, z: -st.nx };
}

/** Разбивает осевую линию на точки примерно через каждые `spacing` метров. */
export function sampleCenterline(road: Road, spacing: number): Station[] {
  const cp = road.centerline;
  if (cp.length < 2) return [];

  const ext: Point2[] = [cp[0], ...cp, cp[cp.length - 1]];
  const raw: Point2[] = [];

  for (let i = 1; i + 2 < ext.length; i++) {
    const p0 = ext[i - 1], p1 = ext[i], p2 = ext[i + 1], p3 = ext[i + 2];
    const chord = Math.hypot(p2.x - p1.x, p2.z - p1.z);
    const steps = Math.max(2, Math.ceil(chord / spacing));
    for (let k = 0; k < steps; k++) raw.push(centripetal(p0, p1, p2, p3, k / steps));
  }
  raw.push(cp[cp.length - 1]);
  // кривая опрашивается часто и неровно, а наружу отдаётся ровный шаг
  return stationsFromLine(resample(raw, spacing));
}
