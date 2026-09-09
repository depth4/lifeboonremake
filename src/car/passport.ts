/**
 * Паспорт машины в СИ. ЕДИНСТВЕННОЕ место, где живут её числа.
 *
 * Почему отдельный файл: этими числами пользуются двое — сама машина
 * (`car.ts`) и проверка на бумаге (`tools/car.ts`). Две копии одних и тех же
 * чисел однажды разойдутся, и разошедшуюся половину будут искать долго.
 *
 * Всё, чего в настоящем паспорте нет, помечено словом ОЦЕНКА или ВЫВЕДЕНО.
 * ВЫВЕДЕНО — значит получено из замера машины журналом, а не придумано.
 */

export interface WheelSpec {
  /** Радиус качения, м. Считается из «оборотов на милю» — см. how-cars-work §3.1 */
  readonly radius: number;
  /** Момент инерции колеса в сборе, кг·м². ОЦЕНКА */
  readonly inertia: number;
  /** Ширина пятна, м — нужна только показу, не счёту. */
  readonly width: number;
}

export interface Passport {
  readonly name: string;
  readonly mass: number;
  /** Доля веса на передней оси. */
  readonly frontShare: number;
  readonly wheelbase: number;
  readonly trackFront: number;
  readonly trackRear: number;
  /** Высота центра масс, м. ОЦЕНКА */
  readonly cgHeight: number;
  /** Момент инерции по рысканью, кг·м². ОЦЕНКА m·a·b */
  readonly yawInertia: number;
  /** Габариты кузова, м — для показа и для лобовой площади. */
  readonly length: number;
  readonly width: number;
  readonly height: number;

  /** Кривая момента: обороты → Н·м. Между точками — прямая. */
  readonly torqueCurve: readonly (readonly [number, number])[];
  readonly idleRpm: number;
  readonly cutoffRpm: number;
  readonly gears: readonly number[];
  readonly finalDrive: number;
  /** КПД трансмиссии. ВЫВЕДЕНО из замера максималки. */
  readonly driveline: number;
  /** Момент инерции крутящихся частей двигателя, кг·м². ОЦЕНКА */
  readonly engineInertia: number;
  /** Вязкостная блокировка дифференциала, Н·м на рад/с разницы. ОЦЕНКА */
  readonly diffLock: number;

  readonly wheelFront: WheelSpec;
  readonly wheelRear: WheelSpec;

  /** Тормозной момент на колесе при полностью нажатой педали, Н·м. */
  readonly brakeFront: number;
  readonly brakeRear: number;

  /** Cd·A, м². Лобовая площадь — ОЦЕНКА 0.85 × ширина × высота. */
  readonly dragArea: number;
  /** Cl·A, м². У обычного Viper прижимной силы нет. */
  readonly liftArea: number;
  readonly rollingResistance: number;

  /** Предельный угол поворота колёс, рад: ±432° руля / 16.7. */
  readonly steerLock: number;
  /** Насколько быстро человек крутит руль, рад колёс в секунду. ОЦЕНКА */
  readonly steerRate: number;
}

/**
 * СЫРЫЕ строки паспорта — как они напечатаны, до всякого пересчёта.
 * Нужны сверке `npm run car`: она проверяет паспорт им же самим (радиус
 * из маркировки против радиуса из «оборотов на милю», общее число верхней
 * передачи против произведения, мощность против момента на оборотах).
 */
export const SPEC = {
  topGearOverall: 2.24,
  peakPowerRpm: 6200,
  peakPower: 477_000,
  peakTorqueRpm: 5000,
  peakTorque: 814,
  steeringRatio: 16.7,
  steeringTurns: 2.4,
  turningDiameter: 12.34,
  brakeDisc: 0.3556,
  tyreFront: { width: 0.295, aspect: 0.3, rim: 18, revsPerMile: 835 },
  tyreRear: { width: 0.355, aspect: 0.3, rim: 19, revsPerMile: 764 },
} as const;

const MILE = 1609.344;
/** Радиус колеса по маркировке шины: обод плюс две боковины. */
export const radiusFromMarking = (t: { width: number; aspect: number; rim: number }): number =>
  (t.rim * 0.0254 + 2 * t.width * t.aspect) / 2;
/** Радиус качения по «оборотам на милю» — то, чем колесо меряет дорогу. */
export const radiusFromRevs = (t: { revsPerMile: number }): number =>
  MILE / t.revsPerMile / (2 * Math.PI);

/** 2013 SRT Viper GTS. Источник — официальный спец-лист Chrysler/SRT. */
export const VIPER: Passport = {
  name: 'Dodge Viper SRT 2013',
  mass: 1556.3,
  frontShare: 0.496,
  wheelbase: 2.51,
  trackFront: 1.598,
  trackRear: 1.55,
  cgHeight: 0.46,
  yawInertia: 1556.3 * 1.265 * 1.245,
  length: 4.463,
  width: 1.941,
  height: 1.246,

  torqueCurve: [
    [1000, 610], [2000, 700], [3000, 760], [4000, 795],
    [5000, 814], [6000, 760], [6200, 735], [6400, 700],
  ],
  idleRpm: 800,
  cutoffRpm: 6400,
  gears: [2.26, 1.58, 1.19, 1.0, 0.77, 0.63],
  finalDrive: 3.55,
  driveline: 0.807,
  engineInertia: 0.25,
  diffLock: 90,

  wheelFront: { radius: radiusFromRevs(SPEC.tyreFront), inertia: 1.36, width: SPEC.tyreFront.width },
  wheelRear: { radius: radiusFromRevs(SPEC.tyreRear), inertia: 2.02, width: SPEC.tyreRear.width },

  // хватает, чтобы заблокировать колёса: предел даёт резина, а не тормоз
  brakeFront: 2400,
  brakeRear: 1300,

  dragArea: 0.369 * 2.06,
  liftArea: 0,
  rollingResistance: 0.012,

  steerLock: (SPEC.steeringTurns / 2) * 2 * Math.PI / SPEC.steeringRatio,
  steerRate: 3.4,
};

/** Расстояние от центра масс до передней оси, м. */
export const frontArm = (p: Passport): number => p.wheelbase * (1 - p.frontShare);
/** Расстояние от центра масс до задней оси, м. */
export const rearArm = (p: Passport): number => p.wheelbase * p.frontShare;

/** Момент двигателя на этих оборотах, Н·м. */
export function engineTorque(p: Passport, rpm: number): number {
  const c = p.torqueCurve;
  const n = Math.max(c[0][0], Math.min(c[c.length - 1][0], rpm));
  for (let i = 0; i + 1 < c.length; i++) {
    const [n0, t0] = c[i], [n1, t1] = c[i + 1];
    if (n <= n1) return t0 + ((t1 - t0) * (n - n0)) / (n1 - n0);
  }
  return c[c.length - 1][1];
}
