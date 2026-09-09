/**
 * Машина. Про экран не знает: ей дают опору под колёсами и положение органов
 * управления, она возвращает новое состояние. Считается без браузера —
 * значит её можно проверить из терминала и однажды считать на сервере.
 *
 * Ни одного правила про «занос», «снос» или «пробуксовку». Всё это —
 * следствия четырёх честно посчитанных пятен контакта. Устройство и вывод
 * формул: docs/how-cars-work.md.
 */

import { type Passport, engineTorque, frontArm, rearArm } from './passport.ts';
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
  /** Где колесо стоит в машине: вперёд от центра масс и влево, м. */
  readonly ahead: number;
  readonly left: number;
  readonly radius: number;
  readonly inertia: number;
  readonly driven: boolean;
  /** Вращение, рад/с. */
  spin: number;
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
  /** Сглаженные ускорения от шин — ими двигается вес. */
  accLong: number;
  accLat: number;
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
  const wheel = (ahead: number, left: number, front: boolean): Wheel => ({
    ahead, left,
    radius: front ? p.wheelFront.radius : p.wheelRear.radius,
    inertia: front ? p.wheelFront.inertia : p.wheelRear.inertia,
    driven: !front,
    spin: 0, load: 0, slip: 0, angle: 0, use: 0, steer: 0,
    x: 0, y: 0, z: 0, material: 'asphalt',
  });
  return {
    x, z, yaw, vx: 0, vz: 0, yawRate: 0, steer: 0,
    wheels: [
      wheel(a, p.trackFront / 2, true),
      wheel(a, -p.trackFront / 2, true),
      wheel(-b, p.trackRear / 2, false),
      wheel(-b, -p.trackRear / 2, false),
    ],
    gear: 0, reverse: false, rpm: p.idleRpm, shiftLeft: 0, stopHold: 0,
    accLong: 0, accLat: 0, neutral: 0, helped: 0, bodyY: 0, pitch: 0, roll: 0,
  };
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

  // ── задний ход: если стоим и держим тормоз, «тормоз» становится задней тягой
  if (Math.abs(u) < 0.4 && controls.brake > 0.15) car.stopHold += dt;
  else if (Math.abs(u) > 1.5 || controls.throttle > 0.1) { car.stopHold = 0; car.reverse = false; }
  if (car.stopHold > 0.35) car.reverse = true;
  const throttle = car.reverse ? controls.brake : controls.throttle;
  const braking = car.reverse ? controls.throttle : controls.brake;

  // ── нагрузка на колёса: статика, прижимная сила и перенос веса
  const down = 0.5 * AIR * p.liftArea * u * u;
  const weight = p.mass * G + down;
  const staticFront = (weight * p.frontShare) / 2;
  const staticRear = (weight * (1 - p.frontShare)) / 2;
  const shiftLong = (p.mass * car.accLong * p.cgHeight) / p.wheelbase;
  const trackAvg = (p.trackFront + p.trackRear) / 2;
  const shiftLatAll = (p.mass * car.accLat * p.cgHeight) / trackAvg;
  const shiftLatF = shiftLatAll * p.frontShare;
  const shiftLatR = shiftLatAll * (1 - p.frontShare);

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

  const cut = car.shiftLeft > 0 || car.rpm >= p.cutoffRpm - 1;
  const engine = cut ? 0 : engineTorque(p, car.rpm) * throttle;
  const drag = cut || throttle > 0.05 ? 0 : engineTorque(p, car.rpm) * 0.12; // торможение двигателем
  const axleTorque = (engine - drag) * ratio * p.driveline * (car.reverse ? -1 : 1);

  // вязкостная блокировка: колёса тянут друг друга, разница скоростей давит
  const lock = clamp((car.wheels[2].spin - car.wheels[3].spin) * p.diffLock, -2500, 2500);

  // ── силы в четырёх пятнах
  let forceLong = 0, forceLat = 0, moment = 0;
  let groundY = 0, nx = 0, ny = 0, nz = 0, frontY = 0, rearY = 0, leftY = 0, rightY = 0;

  for (let i = 0; i < 4; i++) {
    const w = car.wheels[i];
    const front = i < 2;
    w.steer = front ? car.steer : 0;
    w.x = car.x + w.ahead * cos - w.left * sin;
    w.z = car.z + w.ahead * sin + w.left * cos;

    const spot = sample(w.x, w.z);
    w.y = spot.height;
    w.material = spot.material;
    groundY += spot.height / 4;
    nx += spot.nx / 4; ny += spot.ny / 4; nz += spot.nz / 4;
    if (front) frontY += spot.height / 2; else rearY += spot.height / 2;
    if (w.left > 0) leftY += spot.height / 2; else rightY += spot.height / 2;

    const load = Math.max(0,
      (front ? staticFront : staticRear)
      + (front ? -shiftLong / 2 : shiftLong / 2)
      + (w.left > 0 ? -(front ? shiftLatF : shiftLatR) : (front ? shiftLatF : shiftLatR)));
    w.load = load;

    // скорость точки на твёрдом теле: вращение добавляет своё
    const pointLong = u - car.yawRate * w.left;
    const pointLat = v + car.yawRate * w.ahead;
    const cs = Math.cos(w.steer), sn = Math.sin(w.steer);
    const alongWheel = pointLong * cs + pointLat * sn;
    const acrossWheel = -pointLong * sn + pointLat * cs;
    const reference = Math.max(Math.abs(alongWheel), CRAWL);

    w.slip = (w.spin * w.radius - alongWheel) / reference;
    w.angle = Math.atan2(acrossWheel, reference);

    const grip = SURFACE_GRIP[spot.material] ?? 1;
    const force = tyreForce(tyre, { slip: w.slip, angle: w.angle, load, grip });
    w.use = force.use;

    // назад в оси машины
    const fLong = force.x * cs - force.y * sn;
    const fLat = force.x * sn + force.y * cs;
    forceLong += fLong;
    forceLat += fLat;
    moment += w.ahead * fLat - w.left * fLong;

    // раскрутка колеса
    const share = w.driven ? axleTorque / 2 + (w.left > 0 ? -lock : lock) : 0;
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
  // перенос веса приходит через пружины, а не мгновенно
  const lag = Math.min(1, dt / 0.12);
  car.accLong += (accLong - car.accLong) * lag;
  car.accLat += (accLat - car.accLat) * lag;

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

  // полная остановка: иначе машина вечно ползёт от численного мусора
  if (Math.hypot(car.vx, car.vz) < 0.22 && throttle < 0.05) {
    car.vx = 0; car.vz = 0; car.yawRate = 0;
    for (const w of car.wheels) w.spin = 0;
  }

  car.x += car.vx * dt;
  car.z += car.vz * dt;
  car.yaw += car.yawRate * dt;

  // ── показ: где кузов и как он наклонён
  car.bodyY = groundY;
  car.pitch = (frontY - rearY) / p.wheelbase + car.accLong * 0.0027;
  car.roll = (rightY - leftY) / trackAvg - car.accLat * 0.0024;
}
