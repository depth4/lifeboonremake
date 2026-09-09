/**
 * Шина: единственное место, где рождается сила.
 *
 * Кривая задана НЕ коэффициентами Пацейки, а тремя измеримыми вещами:
 * на каком проскальзывании пик, какой у пика уровень, сколько остаётся
 * на полном скольжении. Коэффициенты B, C, E подобраны так, чтобы пик
 * приходился ровно на единицу нормированного скольжения — тогда «пик»
 * в настройке означает пик, а не число, к которому надо привыкнуть.
 *
 * Подробности и вывод — docs/how-cars-work.md §3.
 */

/** Форма кривой. Пик ровно при s = 1, дальше спад до ~0.82 от пика. */
const SHAPE_B = 3.33;
const SHAPE_C = 1.6;
const SHAPE_E = 0.9;

function magic(s: number): number {
  const bs = SHAPE_B * s;
  return Math.sin(SHAPE_C * Math.atan(bs - SHAPE_E * (bs - Math.atan(bs))));
}

export interface Tyre {
  /** Пик сцепления вдоль при опорной нагрузке. */
  readonly gripX: number;
  /** Пик сцепления поперёк при опорной нагрузке. */
  readonly gripY: number;
  /** Опорная нагрузка, Н: та, при которой сцепление равно пику. */
  readonly loadRef: number;
  /**
   * Нагрузочная чувствительность: сила растёт как Fz^power, а не как Fz.
   * 1.0 — школьное трение, у настоящей шины 0.8–0.9.
   */
  readonly loadPower: number;
  /** Проскальзывание, на котором пик продольной силы (доля). */
  readonly peakSlip: number;
  /** Увод, на котором пик боковой силы, рад. */
  readonly peakAngle: number;
  /** Длина релаксации, м: за сколько метров сила догоняет скольжение. */
  readonly relaxation: number;
}

/** Дорожная спортивная шина (Pirelli P Zero на Viper). */
export const P_ZERO: Tyre = {
  gripX: 1.36,
  gripY: 1.12,
  loadRef: 3900,
  loadPower: 0.86,
  peakSlip: 0.12,
  peakAngle: (7.5 * Math.PI) / 180,
  relaxation: 0.5,
};

/** Сцепление на этом покрытии, доля от асфальта. */
export const SURFACE_GRIP: Record<string, number> = {
  asphalt: 1,
  marking: 0.97,
  sidewalk: 0.9,
  curb: 0.75,
  grass: 0.42,
};

/**
 * Пик силы при данной нагрузке. Не μ·Fz: у настоящей шины коэффициент
 * ПАДАЕТ с нагрузкой, и именно поэтому перегруженная ось срывается первой.
 */
export function peakForce(t: Tyre, grip: number, load: number): { x: number; y: number } {
  if (load <= 0) return { x: 0, y: 0 };
  const scale = t.loadRef * Math.pow(load / t.loadRef, t.loadPower) * grip;
  return { x: t.gripX * scale, y: t.gripY * scale };
}

export interface SlipInput {
  /** Продольное проскальзывание κ. */
  readonly slip: number;
  /** Боковой увод α, рад. */
  readonly angle: number;
  /** Вертикальная нагрузка, Н. */
  readonly load: number;
  /** Сцепление покрытия, доля. */
  readonly grip: number;
}

export interface TyreForce {
  /** Вдоль колеса, Н. Плюс — толкает вперёд. */
  readonly x: number;
  /** Поперёк колеса, Н. Плюс — толкает влево. */
  readonly y: number;
  /** Насколько шина близка к пределу: 1 — ровно на пике. */
  readonly use: number;
}

/**
 * Сила в пятне контакта при одновременном проскальзывании и уводе.
 *
 * Оба скольжения нормируются на свой пик и складываются как стороны
 * треугольника. Так получается ЭЛЛИПС трения — одна формула без особых
 * случаев. Любой другой способ («взять минимум», «умножить на коэффициент»)
 * даёт разрыв на границе, а разрыв в силе — это дёрганый руль.
 */
export function tyreForce(t: Tyre, input: SlipInput): TyreForce {
  const peak = peakForce(t, input.grip, input.load);
  if (peak.x <= 0) return { x: 0, y: 0, use: 0 };

  const sx = input.slip / t.peakSlip;
  const sy = Math.tan(input.angle) / t.peakAngle;
  const s = Math.hypot(sx, sy);
  if (s < 1e-6) return { x: 0, y: 0, use: 0 };

  const f = magic(s);
  // направление силы — против скольжения; величина по своей полуоси эллипса
  const fx = (f * sx) / s;
  const fy = (f * sy) / s;
  return { x: peak.x * fx, y: -peak.y * fy, use: s };
}
