/**
 * Машина. Про экран не знает: ей дают опору под колёсами и положение органов
 * управления, она возвращает новое состояние. Считается без браузера —
 * значит её можно проверить из терминала и однажды считать на сервере.
 *
 * Ни одного правила про «занос», «снос» или «пробуксовку». Всё это —
 * следствия четырёх честно посчитанных пятен контакта. Устройство и вывод
 * формул: docs/how-cars-work.md.
 */

import { type Passport, cornerSpring, engineTorque, frontArm, rearArm, sprungMass } from './passport.ts';
import { type Tyre, SURFACE_GRIP, tyreForce } from './tyre.ts';
import type { Spot } from './ground.ts';

const G = 9.80665;
const AIR = 1.225;
/** Ниже этой скорости проскальзывание считать нельзя: деление на ноль. */
const CRAWL = 1.4;

export interface Controls {
  /** Положение руля: −1 вправо, +1 влево. */
  readonly steer: number;
  readonly throttle: number;
  readonly brake: number;
  readonly handbrake: boolean;
  /** Помощь рулю: предел по сцеплению и контрруль. См. `steerHelp`. */
  readonly assist: boolean;
}

export interface Wheel {
  /**
   * Где колесо стоит в машине: вперёд от центра масс и ВПРАВО, м.
   *
   * Право, а не влево: в осях мира право по ходу — это cross(вперёд, вверх)
   * = (−sin ψ, cos ψ). Раньше эта ось называлась «влево», и от одного
   * неверного названия наизнанку оказались руль и сторона движения трафика.
   */
  readonly ahead: number;
  readonly right: number;
  readonly radius: number;
  readonly inertia: number;
  readonly driven: boolean;
  /** Вращение, рад/с. */
  spin: number;
  /** Сжатие подвески от свободного положения, м. Ноль — колесо висит. */
  travel: number;
  /** Свободная длина подвески, м. */
  rest: number;
  /** Высота земли под колесом на прошлом шаге — демпферу нужна скорость дороги. */
  groundPrev: number;
  /** Касается ли колесо земли. */
  down: boolean;
  /** Что под ним прямо сейчас. */
  load: number;
  slip: number;
  angle: number;
  /** Насколько выбрано сцепление: 1 — ровно на пределе. */
  use: number;
  steer: number;
  /** Где колесо оказалось в мире — нужно показу. */
  x: number;
  y: number;
  z: number;
  material: string;
}

export interface Car {
  x: number;
  z: number;
  yaw: number;
  vx: number;
  vz: number;
  yawRate: number;
  steer: number;
  wheels: Wheel[];
  gear: number;
  reverse: boolean;
  rpm: number;
  shiftLeft: number;
  stopHold: number;
  /** Высота крепления подвески (плоскости кузова) над нулём мира, м. */
  heave: number;
  heaveRate: number;
  pitchRate: number;
  rollRate: number;
  /** Поставлена ли машина на землю. */
  placed: boolean;
  /** Угол колёс, при котором они смотрят туда, куда машина едет на самом деле. */
  neutral: number;
  /** Насколько помощь изменила запрошенный угол, рад. Для приборки. */
  helped: number;
  /** Для показа: где кузов и как наклонён. */
  bodyY: number;
  pitch: number;
  roll: number;
}

const clamp = (v: number, lo: number, hi: number): number => (v < lo ? lo : v > hi ? hi : v);

export function createCar(p: Passport, x: number, z: number, yaw: number): Car {
  const a = frontArm(p), b = rearArm(p);
  const wheel = (ahead: number, right: number, front: boolean): Wheel => ({
    ahead, right,
    radius: front ? p.wheelFront.radius : p.wheelRear.radius,
    inertia: front ? p.wheelFront.inertia : p.wheelRear.inertia,
    driven: !front,
    spin: 0, travel: 0, rest: 0, groundPrev: 0, down: true,
    load: 0, slip: 0, angle: 0, use: 0, steer: 0,
    x: 0, y: 0, z: 0, material: 'asphalt',
  });
  return {
    x, z, yaw, vx: 0, vz: 0, yawRate: 0, steer: 0,
    // порядок: переднее левое, переднее правое, заднее левое, заднее правое
    wheels: [
      wheel(a, -p.trackFront / 2, true),
      wheel(a, p.trackFront / 2, true),
      wheel(-b, -p.trackRear / 2, false),
      wheel(-b, p.trackRear / 2, false),
    ],
    gear: 0, reverse: false, rpm: p.idleRpm, shiftLeft: 0, stopHold: 0,
    heave: 0, heaveRate: 0, pitchRate: 0, rollRate: 0, placed: false,
    neutral: 0, helped: 0, bodyY: 0, pitch: 0, roll: 0,
  };
}

/**
 * Свободная длина подвески подбирается так, чтобы под своим весом машина
 * села ровно на заданную высоту — и передом, и задом одинаково. Иначе кузов
 * стоял бы наклонённым просто потому, что пружины разные.
 */
export function restLength(p: Passport, front: boolean): number {
  const { k, mass } = cornerSpring(p, front);
  const radius = front ? p.wheelFront.radius : p.wheelRear.radius;
  return p.suspension.ride - radius + (mass * G) / k;
}

/** Скорость машины вдоль её носа, м/с. Отрицательная — едет задом. */
export const forwardSpeed = (car: Car): number =>
  car.vx * Math.cos(car.yaw) + car.vz * Math.sin(car.yaw);

export type Sampler = (x: number, z: number) => Spot;

/**
 * Помощь рулю — ровно то, что делают BeamNG и Assetto Corsa, и по той же
 * причине: у человека с мышью нет обратной связи, и он не чувствует, что
 * передние колёса уже сорвались или что машину развернуло.
 *
 * 1. **Предел по сцеплению.** Угол ограничен полосой шириной в пик увода
 *    вокруг «нейтрали» — того угла, при котором колёса смотрят туда, куда
 *    машина реально едет. Просить у шины больше её пика бессмысленно: за
 *    пиком она держит хуже. На малой скорости предел выключен, иначе не
 *    припарковаться.
 * 2. **Контрруль (кастор).** Настоящий руль тянет не к нулю, а к направлению
 *    движения. На прямой это возврат в ноль, в заносе — доворот в занос.
 *    Тянет слабо: держать поворот это не мешает, а поймать занос помогает.
 */
function steerHelp(
  car: Car, p: Passport, tyre: Tyre, wanted: number, u: number,
): { angle: number; helped: number } {
  const speed = Math.abs(u);
  const asked = wanted;

  // 1. предел: полностью с 60 км/ч, выключен ниже 25
  const bite = Math.min(1, Math.max(0, (speed - 7) / 10));
  if (bite > 0) {
    const band = tyre.peakAngle * 1.15;
    const capped = clamp(wanted, car.neutral - band, car.neutral + band);
    wanted = wanted * (1 - bite) + capped * bite;
  }

  // 2. кастор: чем быстрее, тем сильнее тянет к направлению движения
  const caster = Math.min(1, speed / 12) * 0.3;
  wanted += (car.neutral - wanted) * caster;

  return { angle: wanted, helped: wanted - asked };
}

export function step(
  car: Car,
  p: Passport,
  tyre: Tyre,
  sample: Sampler,
  controls: Controls,
  dt: number,
): void {
  const cos = Math.cos(car.yaw), sin = Math.sin(car.yaw);
  const u = car.vx * cos + car.vz * sin;          // вперёд
  const v = -car.vx * sin + car.vz * cos;         // влево

  // ── руль
  let wanted = clamp(controls.steer, -1, 1) * p.steerLock;
  car.neutral = Math.atan2(v + car.yawRate * frontArm(p), Math.max(Math.abs(u), 1)) * Math.sign(u || 1);
  if (controls.assist) {
    const help = steerHelp(car, p, tyre, wanted, u);
    wanted = help.angle;
    car.helped = help.helped;
  } else {
    car.helped = 0;
  }
  // колёса доходят до заданного угла не мгновенно, а со скоростью рук
  const swing = p.steerRate * dt;
  car.steer += clamp(wanted - car.steer, -swing, swing);

  /**
   * Задний ход. Подержал тормоз на стоянке — включился, и тогда тормоз стал
   * задней тягой, а газ — тормозом. Выводит из него ГАЗ, а не скорость:
   * раньше выходом была скорость, и назад нельзя было разогнаться быстрее
   * пяти километров в час — реверс мигал туда-сюда.
   */
  if (!car.reverse && Math.abs(u) < 0.5 && controls.brake > 0.15) car.stopHold += dt;
  else car.stopHold = 0;
  if (car.stopHold > 0.35) { car.reverse = true; car.stopHold = 0; }
  if (car.reverse && (controls.throttle > 0.1 || u > 0.5)) car.reverse = false;
  const throttle = car.reverse ? controls.brake : controls.throttle;
  const braking = car.reverse ? controls.throttle : controls.brake;

  // ── прижимная сила: давит на кузов сверху, дальше её разложит подвеска
  const downforce = 0.5 * AIR * p.liftArea * u * u;
  const weight = p.mass * G + downforce;

  // ── ПОДВЕСКА. Нагрузку на колёса больше не считает формула переноса веса:
  // она получается сама, потому что кузов честно качается на четырёх пружинах.
  const springs = [cornerSpring(p, true), cornerSpring(p, true), cornerSpring(p, false), cornerSpring(p, false)];
  const sprung = sprungMass(p);
  if (!car.placed) {
    for (let i = 0; i < 4; i++) car.wheels[i].rest = restLength(p, i < 2);
    const under = sample(car.x, car.z).height;
    car.heave = under + p.suspension.ride;
    for (const w of car.wheels) w.groundPrev = under;
    car.placed = true;
  }

  // ── трансмиссия: обороты берутся от ведущих колёс
  const ratio = (car.reverse ? 2.9 : p.gears[car.gear]) * p.finalDrive;
  const spinAvg = (car.wheels[2].spin + car.wheels[3].spin) / 2;
  const fromWheels = (Math.abs(spinAvg) * ratio * 60) / (2 * Math.PI);
  // сцепление буксует на старте — иначе мотор глохнет на нулевой скорости
  car.rpm = clamp(Math.max(fromWheels, throttle > 0.05 ? 3400 : p.idleRpm), p.idleRpm, p.cutoffRpm);

  if (car.shiftLeft > 0) car.shiftLeft -= dt;
  else if (!car.reverse) {
    if (fromWheels > 6250 && car.gear + 1 < p.gears.length) { car.gear++; car.shiftLeft = 0.25; }
    else if (fromWheels < 2400 && car.gear > 0) { car.gear--; car.shiftLeft = 0.2; }
  }

  // на заднем ходу мотор придушен: иначе передача 2.9 разгоняет назад до 80 км/ч
  const ceiling = car.reverse ? 3500 : p.cutoffRpm - 1;
  const cut = car.shiftLeft > 0 || car.rpm >= ceiling;
  const engine = cut ? 0 : engineTorque(p, car.rpm) * throttle;
  const push = engine * ratio * p.driveline * (car.reverse ? -1 : 1);
  /**
   * Торможение двигателем ГАСИТ вращение, а не крутит колёса.
   * Раньше оно было просто отрицательным моментом — и на стоянке медленно
   * увозило машину назад само по себе. Теперь оно всегда против вращения
   * и исчезает вместе с ним.
   */
  const rolling = Math.sign(spinAvg) * Math.min(1, Math.abs(spinAvg) / 3);
  const engineBrake = cut || throttle > 0.05
    ? 0 : engineTorque(p, car.rpm) * 0.12 * ratio * p.driveline * rolling;
  const axleTorque = push - engineBrake;

  // вязкостная блокировка: колёса тянут друг друга, разница скоростей давит
  const lock = clamp((car.wheels[2].spin - car.wheels[3].spin) * p.diffLock, -2500, 2500);

  // ── ПРОХОД ПЕРВЫЙ: где колёса, что под ними и с какой силой давит подвеска
  const suspension = [0, 0, 0, 0];
  let groundY = 0, nx = 0, ny = 0, nz = 0;

  for (let i = 0; i < 4; i++) {
    const w = car.wheels[i];
    const front = i < 2;
    w.steer = front ? car.steer : 0;
    w.x = car.x + w.ahead * cos - w.right * sin;
    w.z = car.z + w.ahead * sin + w.right * cos;

    const spot = sample(w.x, w.z);
    w.material = spot.material;
    groundY += spot.height / 4;
    nx += spot.nx / 4; ny += spot.ny / 4; nz += spot.nz / 4;

    // где крепление подвески: кузов наклонён, значит углы на разной высоте
    const attach = car.heave + w.ahead * car.pitch - w.right * car.roll;
    // колесо стоит на земле, но не выше, чем позволяет вытянутая подвеска
    const centre = Math.max(spot.height + w.radius, attach - w.rest);
    w.travel = w.rest - (attach - centre);
    w.down = w.travel > 1e-4;
    w.y = centre - w.radius;

    // скорость сжатия: движется и кузов, и дорога под колесом
    const attachRate = car.heaveRate + w.ahead * car.pitchRate - w.right * car.rollRate;
    const roadRate = clamp((spot.height - w.groundPrev) / dt, -12, 12);
    w.groundPrev = spot.height;
    const squeezeRate = w.down ? roadRate - attachRate : 0;

    const spring = springs[i];
    let force = w.down ? spring.k * w.travel + spring.c * squeezeRate : 0;
    // отбойник: за пределом хода подвеска резко твердеет
    const over = w.travel - p.suspension.travel;
    if (over > 0) force += over * spring.k * 8;
    suspension[i] = Math.max(0, force);
  }

  /**
   * Стабилизатор связывает колёса одной оси: он не мешает обоим сжиматься
   * вместе и мешает сжиматься по-разному. Поэтому он влияет ТОЛЬКО на крен —
   * и именно им настраивается характер машины (docs/how-cars-work.md §5.5).
   */
  for (const [a, b, bar] of [[0, 1, p.suspension.barFront], [2, 3, p.suspension.barRear]] as const) {
    const twist = (car.wheels[a].travel - car.wheels[b].travel) / 2;
    if (car.wheels[a].down) suspension[a] = Math.max(0, suspension[a] + bar * twist);
    if (car.wheels[b].down) suspension[b] = Math.max(0, suspension[b] - bar * twist);
  }

  // прижимная сила давит на кузов и через подвеску доходит до колёс
  for (let i = 0; i < 4; i++) {
    const w = car.wheels[i];
    w.load = w.down ? suspension[i] + p.unsprung * G + downforce / 4 : 0;
  }

  // ── ПРОХОД ВТОРОЙ: силы в четырёх пятнах
  let forceLong = 0, forceLat = 0, moment = 0;

  for (let i = 0; i < 4; i++) {
    const w = car.wheels[i];
    const front = i < 2;

    // скорость точки на твёрдом теле: вращение добавляет своё
    const pointLong = u - car.yawRate * w.right;
    const pointLat = v + car.yawRate * w.ahead;
    const cs = Math.cos(w.steer), sn = Math.sin(w.steer);
    const alongWheel = pointLong * cs + pointLat * sn;
    const acrossWheel = -pointLong * sn + pointLat * cs;
    const reference = Math.max(Math.abs(alongWheel), CRAWL);

    w.slip = (w.spin * w.radius - alongWheel) / reference;
    w.angle = Math.atan2(acrossWheel, reference);

    const grip = SURFACE_GRIP[w.material] ?? 1;
    const force = tyreForce(tyre, { slip: w.slip, angle: w.angle, load: w.load, grip });
    w.use = force.use;

    // назад в оси машины
    const fLong = force.x * cs - force.y * sn;
    const fLat = force.x * sn + force.y * cs;
    forceLong += fLong;
    forceLat += fLat;
    moment += w.ahead * fLat - w.right * fLong;

    // раскрутка колеса
    const share = w.driven ? axleTorque / 2 + (i === 2 ? -lock : lock) : 0;
    const brakeMax = (front ? p.brakeFront : p.brakeRear) * braking
      + (!front && controls.handbrake ? p.brakeRear * 1.4 : 0);
    const inertia = w.inertia + (w.driven ? (p.engineInertia * ratio * ratio) / 2 : 0);
    let spin = w.spin + ((share - force.x * w.radius) / inertia) * dt;
    // тормоз не может раскрутить колесо назад — он только гасит вращение
    const stop = (brakeMax / inertia) * dt;
    spin = Math.abs(spin) <= stop ? 0 : spin - Math.sign(spin) * stop;
    w.spin = spin;
  }

  // ── кузов
  const air = 0.5 * AIR * p.dragArea * u * Math.abs(u);
  const roll = p.rollingResistance * weight * Math.sign(u) * Math.min(1, Math.abs(u) / 0.5);
  forceLong -= air + roll;

  const accLong = forceLong / p.mass;
  const accLat = forceLat / p.mass;

  // уклон: сила тяжести вдоль поверхности, из нормали под машиной
  const slopeX = G * ny * nx;
  const slopeZ = G * ny * nz;

  const worldX = accLong * cos - accLat * sin + slopeX;
  const worldZ = accLong * sin + accLat * cos + slopeZ;
  car.vx += worldX * dt;
  car.vz += worldZ * dt;
  car.yawRate += (moment / p.yawInertia) * dt;
  // сопротивление рысканью: без него машина крутится вечно
  car.yawRate -= car.yawRate * Math.min(1, dt * 0.8);

  /**
   * ── КУЗОВ ПО ВЕРТИКАЛИ: три степени свободы на четырёх пружинах.
   *
   * Здесь и рождается перенос веса. Продольная сила шин приложена внизу,
   * у земли, а масса — наверху, в центре масс: между ними плечо высотой
   * с центр масс, и оно кренит кузов. Кузов давит на пружины, пружины
   * меняют нагрузку на колёсах. Никакой формулы переноса веса нет —
   * есть рычаг, пружина и вторая производная.
   */
  let lift = -sprung * G + downforce;
  let pitchMoment = forceLong * p.cgHeight;
  let rollMoment = -forceLat * p.cgHeight;
  for (let i = 0; i < 4; i++) {
    const w = car.wheels[i];
    lift += suspension[i];
    pitchMoment += w.ahead * suspension[i];
    rollMoment -= w.right * suspension[i];
  }
  const pitchInertia = p.mass * (0.3 * p.length) ** 2;
  const rollInertia = p.mass * (0.28 * p.width) ** 2;

  car.heaveRate += (lift / sprung) * dt;
  car.heave += car.heaveRate * dt;
  car.pitchRate += (pitchMoment / pitchInertia) * dt;
  car.pitch += car.pitchRate * dt;
  car.rollRate += (rollMoment / rollInertia) * dt;
  car.roll += car.rollRate * dt;

  // полная остановка: иначе машина вечно ползёт от численного мусора
  if (Math.hypot(car.vx, car.vz) < 0.22 && throttle < 0.05) {
    car.vx = 0; car.vz = 0; car.yawRate = 0;
    for (const w of car.wheels) w.spin = 0;
  }

  car.x += car.vx * dt;
  car.z += car.vz * dt;
  car.yaw += car.yawRate * dt;

  // показу нужна высота, с которой рисовать кузов
  car.bodyY = car.heave - p.suspension.ride;
}
