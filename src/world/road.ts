/**
 * Дорога = осевая линия + список полос.
 * Асфальт нигде не хранится: он считается из этих двух вещей.
 * Про экран и про Three.js этот файл не знает ничего.
 */

export interface Point2 {
  readonly x: number;
  readonly z: number;
}

export type LaneKind = 'travel' | 'sidewalk' | 'marking' | 'median';

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

/** Тип дороги — это данные, а не код. Новый тип = новая запись здесь. */
export interface RoadType {
  readonly name: string;
  readonly lanes: readonly Lane[];
}

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
  const walk: Lane = { kind: 'sidewalk', width: n >= 3 ? 3.2 : 2.4, direction: 0, rise: CURB };

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

  return {
    name: n === 1 ? 'улица, 2 полосы' : `дорога, ${n * 2} полос`,
    lanes: [walk, ...side(1), ...middle, ...side(-1), walk],
  };
}

export const ROAD_TYPES: Record<string, RoadType> = {
  street2: {
    name: 'улица, 2 полосы',
    lanes: [
      { kind: 'sidewalk', width: 2.4, direction: 0, rise: CURB },
      { kind: 'travel', width: 3.5, direction: 1, rise: 0 },
      { kind: 'marking', width: MARK, direction: 0, rise: 0 },
      { kind: 'travel', width: 3.5, direction: -1, rise: 0 },
      { kind: 'sidewalk', width: 2.4, direction: 0, rise: CURB },
    ],
  },
  avenue4: {
    name: 'проспект, 4 полосы',
    lanes: [
      { kind: 'sidewalk', width: 3.2, direction: 0, rise: CURB },
      { kind: 'travel', width: 3.5, direction: 1, rise: 0 },
      { kind: 'marking', width: MARK, direction: 0, rise: 0 },
      { kind: 'travel', width: 3.5, direction: 1, rise: 0 },
      { kind: 'median', width: 2.0, direction: 0, rise: CURB },
      { kind: 'travel', width: 3.5, direction: -1, rise: 0 },
      { kind: 'marking', width: MARK, direction: 0, rise: 0 },
      { kind: 'travel', width: 3.5, direction: -1, rise: 0 },
      { kind: 'sidewalk', width: 3.2, direction: 0, rise: CURB },
    ],
  },
};

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
}

export function bands(type: RoadType): Band[] {
  let offset = -roadWidth(type) / 2;
  return type.lanes.map((lane) => {
    const band = { kind: lane.kind, from: offset, to: offset + lane.width, rise: lane.rise };
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

function catmullRom(p0: number, p1: number, p2: number, p3: number, t: number): number {
  const t2 = t * t;
  const t3 = t2 * t;
  return 0.5 * ((2 * p1) + (-p0 + p2) * t + (2 * p0 - 5 * p1 + 4 * p2 - p3) * t2 + (-p0 + 3 * p1 - 3 * p2 + p3) * t3);
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
    for (let k = 0; k < steps; k++) {
      const t = k / steps;
      raw.push({ x: catmullRom(p0.x, p1.x, p2.x, p3.x, t), z: catmullRom(p0.z, p1.z, p2.z, p3.z, t) });
    }
  }
  raw.push(cp[cp.length - 1]);

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
