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

import { type Tyre, ЭКОНОМ, P_ZERO } from './tyre.ts';

export interface WheelSpec {
  /** Радиус качения, м. Считается из «оборотов на милю» — см. how-cars-work §3.1 */
  readonly radius: number;
  /** Момент инерции колеса в сборе, кг·м². ОЦЕНКА */
  readonly inertia: number;
  /** Ширина пятна, м — нужна только показу, не счёту. */
  readonly width: number;
}

/**
 * Подвеска. Задана НЕ жёсткостью в ньютонах на метр, а частотой колебаний
 * кузова в герцах — тем, что реально называют в справочниках и что можно
 * сравнить с чужой машиной (легковая 1.0–1.5, спорткар 1.5–2.5, гоночная
 * 2.5–3.5 Гц). Жёсткость из неё считается: k = (2πf)² · масса на колесо.
 * См. docs/how-cars-work.md §5.2.
 */
export interface Suspension {
  readonly label: string;
  /** Частота колебаний, Гц. */
  readonly rideFront: number;
  readonly rideRear: number;
  /** Доля критического демпфирования: 0.2 легковая, 0.5 спорт, 0.7 гонка. */
  readonly dampFront: number;
  readonly dampRear: number;
  /** Стабилизатор: добавка к силе от РАЗНИЦЫ ходов на оси, Н/м. */
  readonly barFront: number;
  readonly barRear: number;
  /** Ход до отбойника, м. */
  readonly travel: number;
  /** Высота крепления подвески над землёй под статической нагрузкой, м. */
  readonly ride: number;
}

/** Настройки подвески. Выбирать — руками, по ощущению (клавиша P). */
export const SETUPS: Record<string, Suspension> = {
  // заводская подвеска бюджетного седана: мягкая, с большим ходом, кузов
  // заметно кренится и клюёт — так и едет Логан. ОЦЕНКА по классу машины
  комфорт: { label: 'комфорт', rideFront: 1.2, rideRear: 1.35, dampFront: 0.3, dampRear: 0.3, barFront: 14000, barRear: 6000, travel: 0.17, ride: 0.66 },
  дорога: { label: 'дорога', rideFront: 1.5, rideRear: 1.7, dampFront: 0.38, dampRear: 0.38, barFront: 20000, barRear: 15000, travel: 0.14, ride: 0.62 },
  спорт: { label: 'спорт', rideFront: 2.0, rideRear: 2.2, dampFront: 0.52, dampRear: 0.52, barFront: 48000, barRear: 38000, travel: 0.11, ride: 0.6 },
  трек: { label: 'трек', rideFront: 2.7, rideRear: 3.0, dampFront: 0.66, dampRear: 0.66, barFront: 80000, barRear: 64000, travel: 0.08, ride: 0.56 },
};

export interface Passport {
  readonly name: string;
  /** Коротко — для кнопки и адреса (`?машина=логан`). */
  readonly ярлык: string;
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

  /** Неподрессоренная масса на колесо, кг: колесо, тормоз, часть рычагов. ОЦЕНКА */
  readonly unsprung: number;
  /** Настройка подвески. Меняется на ходу. */
  suspension: Suspension;

  /** Шина, на которой машина стоит с завода. */
  readonly шина: Tyre;
  /** Какая ось ведущая. */
  readonly привод: 'перед' | 'зад';
  /** Обороты, на которых коробка переключает вверх и вниз. */
  readonly переключение: { readonly вверх: number; readonly вниз: number };
  /**
   * ABS: не даёт тормозу заблокировать колесо — держит его на пике
   * проскальзывания, и машина тормозит и рулится. Ручник идёт мимо ABS.
   */
  readonly abs: boolean;
  /** Передаточное число рулевого: во сколько раз руль поворачивается больше колёс. */
  readonly рулевое: number;
  /** Передний свес: от передней оси до носа, м. Ставит кузов над колёсами. */
  readonly свесПеред: number;
  /**
   * Силуэт сбоку для показа: точки (назад от носа, над землёй), м, обход
   * против часовой, начиная с низа носа. Кузов — этот силуэт на ширину.
   */
  readonly силуэт: readonly (readonly [number, number])[];
  /** Стёкла кабины: назад от носа от/до, над землёй низ/верх, м. */
  readonly стёкла: { readonly от: number; readonly до: number; readonly низ: number; readonly верх: number };
  /** Глаза водителя: назад от носа и над землёй, м (сидит слева). */
  readonly глаз: readonly [number, number];
  readonly цвет: number;
}

/** От центра масс до носа, м: плечо передней оси плюс передний свес. */
export const доНоса = (p: Passport): number => frontArm(p) + p.свесПеред;

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
  ярлык: 'viper',
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

  unsprung: 27,
  suspension: SETUPS.спорт,

  шина: P_ZERO,
  привод: 'зад',
  переключение: { вверх: 6250, вниз: 2400 },
  // ABS у Viper есть, но его сцепление выведено из замеров без ABS
  // в модели — включить его значит выводить сцепление заново
  abs: false,
  рулевое: SPEC.steeringRatio,
  // кузов по центру машины, как рисовался до 28.09: нос в длине/2 от центра масс
  свесПеред: 4.463 / 2 - 2.51 * (1 - 0.496),
  // длинный капот, кабина сдвинута назад, короткий хвост
  силуэт: [
    [0.08, 0.16], [0, 0.34], [0.55, 0.56], [1.35, 0.66], [2.05, 0.80], [2.45, 1.19],
    [3.10, 1.21], [3.55, 0.86], [4.113, 0.76], [4.463, 0.60], [4.483, 0.30], [4.113, 0.14],
  ],
  стёкла: { от: 1.99, до: 3.31, низ: 0.73, верх: 1.15 },
  глаз: [2.75, 1.16],
  цвет: 0xb3121d,
};

/**
 * Renault Logan II (2014–2022), 1.6 8V (K7M), 82 л. с., механика JH3.
 * Источники (сводки поиска: сами сайты из контейнера закрыты): каталог
 * drom.ru — 60 кВт при 5000, 134 Н·м при 2800, передачи 3.727 / 2.048 /
 * 1.393 / 1.029 / 0.756, главная пара 4.5, база 2634, колея 1497 / 1486,
 * шины 185/65 R15, снаряжённая масса 1106–1127 кг, 0–100 за 11.9 с,
 * максимальная 172 км/ч; «За рулём» — тормозной путь со 100 км/ч 42.9 м.
 */
export const LOGAN: Passport = {
  name: 'Renault Logan 1.6 8V',
  ярлык: 'логан',
  // снаряжённая 1106 + водитель 75
  mass: 1181,
  frontShare: 0.61, // ОЦЕНКА: переднеприводный седан, мотор над передней осью
  wheelbase: 2.634,
  trackFront: 1.497,
  trackRear: 1.486,
  cgHeight: 0.56, // ОЦЕНКА: седан выше и мягче спорткара
  yawInertia: 1181 * (2.634 * 0.39) * (2.634 * 0.61),
  length: 4.346,
  width: 1.733,
  height: 1.517,

  // кривая — ОЦЕНКА по двум паспортным точкам: 134 Н·м при 2800 и 60 кВт при 5000 (115 Н·м)
  torqueCurve: [
    [800, 92], [1500, 112], [2000, 124], [2800, 134], [3500, 131],
    [4000, 127], [4500, 121], [5000, 115], [5500, 104], [5800, 96],
  ],
  idleRpm: 750,
  cutoffRpm: 5800, // ОЦЕНКА: отсечка K7M
  gears: [3.727, 2.048, 1.393, 1.029, 0.756],
  finalDrive: 4.5,
  driveline: 0.93, // ВЫВЕДЕНО из максималки 172 км/ч (npm run drive)
  engineInertia: 0.12, // ОЦЕНКА: 8-клапанный 1.6 с маховиком
  diffLock: 0, // открытый дифференциал

  // радиус качения — 0.97 от радиуса по маркировке (шина под весом приседает). ОЦЕНКА
  wheelFront: { radius: 0.97 * radiusFromMarking({ width: 0.185, aspect: 0.65, rim: 15 }), inertia: 0.85, width: 0.185 },
  wheelRear: { radius: 0.97 * radiusFromMarking({ width: 0.185, aspect: 0.65, rim: 15 }), inertia: 0.85, width: 0.185 },

  // спереди диски, сзади барабаны; хватает, чтобы заблокировать колёса — дальше решает ABS
  brakeFront: 1500,
  brakeRear: 650,

  dragArea: 0.74, // ОЦЕНКА: Cx 0.35 × лоб 2.1 м²
  liftArea: 0,
  rollingResistance: 0.012,

  // разворот 10.5 м по бордюрам: sin(угол) = база / радиус
  steerLock: Math.asin(2.634 / 5.25),
  steerRate: 3.4,

  unsprung: 25,
  suspension: SETUPS.комфорт,

  шина: ЭКОНОМ,
  привод: 'перед',
  // вверх — у самой отсечки: в низшей передаче тяга до неё больше, чем в высшей после
  переключение: { вверх: 5750, вниз: 2000 },
  abs: true,
  рулевое: 18, // ОЦЕНКА
  свесПеред: 0.85, // ОЦЕНКА: длина 4346 − база 2634 = 1712 на оба свеса
  // три объёма: короткий капот, высокая кабина, багажник
  силуэт: [
    [0.06, 0.24], [0, 0.52], [0.1, 0.76], [1.0, 0.93], [1.9, 1.48], [2.95, 1.517],
    [3.55, 1.06], [4.28, 1.0], [4.346, 0.62], [4.3, 0.26], [3.9, 0.2],
  ],
  // до стойки перед задним стеклом: дальше крыша уходит вниз, и стекло торчало бы над ней
  стёкла: { от: 1.95, до: 3.05, низ: 1.0, верх: 1.44 },
  // сидит выше и ближе к середине машины, чем в Viper
  глаз: [2.2, 1.27],
  цвет: 0x8f989e,
};

/**
 * ВСЕ МАШИНЫ ИГРЫ. Каждая — независимый паспорт, общая у них только
 * физика. Новая машина — ещё одна строка здесь, со своими замерами
 * в `npm run drive`. Первая — та, в которой игрок садится за руль.
 * 28.09 Алекс: «Viper не убирай; в игре должно быть много независимых авто».
 */
export const МАШИНЫ: readonly Passport[] = [LOGAN, VIPER];

/** Подрессоренная масса — та, что качается на пружинах. */
export const sprungMass = (p: Passport): number => p.mass - 4 * p.unsprung;

/** Жёсткость и демпфирование на колесе, из частоты и массы угла. */
export function cornerSpring(p: Passport, front: boolean): { k: number; c: number; mass: number } {
  const s = p.suspension;
  const share = front ? p.frontShare : 1 - p.frontShare;
  const mass = (sprungMass(p) * share) / 2;
  const f = front ? s.rideFront : s.rideRear;
  const k = (2 * Math.PI * f) ** 2 * mass;
  const c = 2 * (front ? s.dampFront : s.dampRear) * Math.sqrt(k * mass);
  return { k, c, mass };
}

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
