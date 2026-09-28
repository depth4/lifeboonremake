/**
 * Машина без экрана: гоняем её по прямой, по кругу и по нашему кварталу
 * и сверяем с замерами настоящего Viper.
 *
 * Смысл проверки: `npm run car` считает машину «на бумаге» одной формулой,
 * а `src/car/` — по четырём пятнам контакта, шестьсот раз в секунду. Это две
 * разные реализации одной физики. Если они сходятся между собой И с замерами
 * журнала — значит совпадение не случайно.
 *
 *   npm run drive           — счёт и сверка
 *   npm run drive сломать   — убрать перенос веса: сверка обязана упасть
 */

import { дорогиСцены } from '../src/scenes.ts';
import { buildWorld } from '../src/world/world.ts';
import { buildSurface } from '../src/surface/index.ts';
import { GroundIndex, type Spot, крайМира } from '../src/car/ground.ts';
import { LOGAN, type Passport, VIPER } from '../src/car/passport.ts';
import { P_ZERO } from '../src/car/tyre.ts';
import * as THREE from 'three';
import { type Car, type Controls, createCar, forwardSpeed, step, подкрутить, точкаКузова, углыКузова, центрКолеса } from '../src/car/car.ts';

const mode = process.argv[2] ?? '';
const broken = mode === 'сломать';
const soft = mode === 'мягко';
const MPH = 0.44704;
const DT = 1 / 600;

/** Ровный асфальт до горизонта — чтобы мерить машину, а не дорогу. */
const FLAT = (): Spot => ({ height: 0, nx: 0, ny: 1, nz: 0, material: 'asphalt' });

// «сломать» — высота центра масс в ноль: перенос веса исчезает.
// «мягко» — подвеска от дивана: кузов должен завалиться в повороте.
const P = broken
  ? { ...VIPER, cgHeight: 0 }
  : soft
    ? { ...VIPER, suspension: { ...VIPER.suspension, rideFront: 0.7, rideRear: 0.8, barFront: 0, barRear: 0 } }
    : VIPER;

// Помощь рулю здесь ВЫКЛЮЧЕНА: проверка меряет машину, а не помощь водителю.
const drive = (throttle: number, brake = 0, steer = 0): Controls =>
  ({ throttle, brake, steer, handbrake: false, assist: false });

/**
 * Разгон с места. Газ не «в пол», а через противобуксовочную: она держит
 * проскальзывание ведущих колёс около пика кривой. Это не поблажка модели —
 * у настоящей машины launch control записан в паспорте отдельной строкой,
 * и замеренные 3.7 секунды сделаны именно с ним. Без него 640 сил просто
 * жгут резину, и это модель показывает честно (см. ниже «в пол»).
 */
function launch(traction = true, p: Passport = P): { sixty: number; hundred: number; quarter: number; trap: number } {
  const car = createCar(p, 0, 0, 0);
  const ведущие = car.wheels.filter((w) => w.driven);
  let t = 0, x = 0, sixty = NaN, hundred = NaN, quarter = NaN, trap = NaN;
  while (t < 40) {
    const slip = ведущие.reduce((s, w) => s + w.slip, 0) / ведущие.length;
    const gas = traction ? Math.max(0, Math.min(1, 1 - (slip / p.шина.peakSlip - 1) * 2.5)) : 1;
    step(car, p, p === P ? P_ZERO : p.шина, FLAT, drive(gas), DT);
    const v = forwardSpeed(car);
    x += v * DT; t += DT;
    if (Number.isNaN(sixty) && v >= 60 * MPH) sixty = t;
    if (Number.isNaN(hundred) && v >= 100 / 3.6) hundred = t;
    if (x >= 402.336) { quarter = t; trap = v; break; }
  }
  return { sixty, hundred, quarter, trap };
}

/** Торможение в пол с заданной скорости: сколько метров до полной остановки. */
function brakeFrom(v0: number, p: Passport = P): number {
  const car = createCar(p, 0, 0, 0);
  car.vx = v0;
  for (const w of car.wheels) w.spin = v0 / w.radius;
  let x = 0, t = 0;
  while (forwardSpeed(car) > 0.3 && t < 20) {
    step(car, p, p === P ? P_ZERO : p.шина, FLAT, drive(0, 1), DT);
    x += forwardSpeed(car) * DT; t += DT;
  }
  return x;
}

/** Круг: какую боковую перегрузку машина держит на пределе. */
function skidpad(): { g: number; radius: number } {
  let best = { g: 0, radius: 0 };
  for (let steer = 0.04; steer <= 0.5; steer += 0.01) {
    const car = createCar(P, 0, 0, 0);
    const target = 24; // м/с — примерно скорость площадки 200 футов
    car.vx = target;
    for (const w of car.wheels) w.spin = target / w.radius;
    let g = 0, radius = 0;
    for (let t = 0; t < 8; t += DT) {
      const v = forwardSpeed(car);
      // держим скорость: газ ровно столько, сколько нужно
      const keep = v < target ? 0.35 : 0;
      step(car, P, P_ZERO, FLAT, drive(keep, 0, steer), DT);
      if (t > 6) {
        const speed = forwardSpeed(car);
        const r = Math.abs(speed / (car.yawRate || 1e-9));
        g = (speed * speed) / r / 9.80665;
        radius = r;
      }
    }
    if (Number.isFinite(g) && g > best.g) best = { g, radius };
  }
  return best;
}

/** Круг по нашему кварталу: не проваливается ли колесо и по чему едет. */
function lap(): { spots: Record<string, number>; lowest: number; steps: number } {
  const world = buildWorld(дорогиСцены('крест'), 'plain');
  const index = new GroundIndex(buildSurface(world, 'A'));
  const sample = (x: number, z: number): Spot => index.sample(x, z);
  const car = createCar(P, -60, 0, 0);
  const spots: Record<string, number> = {};
  let lowest = Infinity, steps = 0;
  // держим спокойные 50 км/ч и едем вдоль дороги, не выезжая за край сцены
  for (let t = 0; t < 10; t += DT) {
    const gas = forwardSpeed(car) < 14 ? 0.3 : 0;
    step(car, P, P_ZERO, sample, drive(gas), DT);
    for (const w of car.wheels) {
      spots[w.material] = (spots[w.material] ?? 0) + 1;
      const низ = центрКолеса(car, w, w.travel).y - w.radius;
      if (низ < lowest) lowest = низ;
    }
    steps++;
    if (!Number.isFinite(car.x) || !Number.isFinite(car.z)) break;
  }
  return { spots, lowest, steps };
}

/**
 * Куда машина едет от положительного руля. Это НЕ мелочь: ось «вбок» легко
 * назвать наоборот, и тогда наизнанку оказывается и руль, и сторона движения
 * трафика. Право по ходу — это cross(вперёд, вверх) = (−sin ψ, cos ψ);
 * при курсе ноль это +z. Значит поворот направо увеличивает и курс, и z.
 */
function turnsRight(): { yaw: number; sideways: number } {
  const car = createCar(P, 0, 0, 0);
  const v = 14;
  car.vx = v;
  for (const w of car.wheels) w.spin = v / w.radius;
  for (let t = 0; t < 3; t += DT) step(car, P, P_ZERO, FLAT, drive(0.2, 0, 1), DT);
  return { yaw: car.yaw, sideways: car.z };
}

/** Как машина стоит под своим весом: осадка подвески и наклон кузова. */
function stance(): { front: number; rear: number; pitch: number; roll: number } {
  const car = createCar(P, 0, 0, 0);
  for (let t = 0; t < 5; t += DT) step(car, P, P_ZERO, FLAT, drive(0), DT);
  return {
    front: ((car.wheels[0].travel + car.wheels[1].travel) / 2) * 1000,
    rear: ((car.wheels[2].travel + car.wheels[3].travel) / 2) * 1000,
    pitch: (car.pitch * 180) / Math.PI,
    roll: (car.roll * 180) / Math.PI,
  };
}

/** Клевок: на сколько градусов кузов ныряет носом при торможении в пол. */
function dive(): { angle: number; front: number; rear: number } {
  const car = createCar(P, 0, 0, 0);
  car.vx = 30;
  for (const w of car.wheels) w.spin = 30 / w.radius;
  for (let t = 0; t < 1.2; t += DT) step(car, P, P_ZERO, FLAT, drive(0), DT); // устояться
  let worst = 0, front = 0, rear = 0;
  for (let t = 0; t < 1.5 && forwardSpeed(car) > 2; t += DT) {
    step(car, P, P_ZERO, FLAT, drive(0, 1), DT);
    if (-car.pitch > worst) {
      worst = -car.pitch;
      front = ((car.wheels[0].travel + car.wheels[1].travel) / 2) * 1000;
      rear = ((car.wheels[2].travel + car.wheels[3].travel) / 2) * 1000;
    }
  }
  return { angle: (worst * 180) / Math.PI, front, rear };
}

/** Крен: сколько градусов на единицу боковой перегрузки. */
function lean(): number {
  const car = createCar(P, 0, 0, 0);
  const target = 24;
  car.vx = target;
  for (const w of car.wheels) w.spin = target / w.radius;
  let best = 0;
  for (let t = 0; t < 7; t += DT) {
    const v = forwardSpeed(car);
    step(car, P, P_ZERO, FLAT, drive(v < target ? 0.35 : 0, 0, 0.16), DT);
    if (t > 5) {
      const speed = forwardSpeed(car);
      const g = (speed * Math.abs(car.yawRate)) / 9.80665;
      if (g > 0.2) best = Math.abs((car.roll * 180) / Math.PI) / g;
    }
  }
  return best;
}

/**
 * Свободные (неведущие) колёса на старте в пол катятся, а не
 * проскальзывают: самое большое |проскальзывание| за первую секунду.
 * Без релаксации шины оно прыгало через шаг на ±30%.
 */
function freeRoll(): number {
  const car = createCar(P, 0, 0, 0);
  let worst = 0;
  for (let t = 0; t < 1; t += DT) {
    step(car, P, P_ZERO, FLAT, drive(1), DT);
    for (const w of car.wheels) if (!w.driven) worst = Math.max(worst, Math.abs(w.slip));
  }
  return worst;
}

/** Стоим и ничего не жмём. Машина обязана стоять. */
function standStill(): number {
  const car = createCar(P, 0, 0, 0);
  for (let t = 0; t < 8; t += DT) step(car, P, P_ZERO, FLAT, drive(0), DT);
  return Math.abs(forwardSpeed(car));
}

/** Задний ход: подержать тормоз на стоянке и поехать назад. */
function backwards(): number {
  const car = createCar(P, 0, 0, 0);
  for (let t = 0; t < 6; t += DT) step(car, P, P_ZERO, FLAT, drive(0, 1), DT);
  return -forwardSpeed(car);
}

/**
 * За краем мира. Там нарисована ровная земля (горизонт) — и колесо обязано
 * на ней стоять и по ней ехать, а не проваливаться сквозь картинку.
 * Машина ставится в 30 м за краем сцены «крест» и 4 секунды едет прочь.
 * Возвращает самый низкий низ колеса от высоты земли за краем, м
 * (0 — стоит ровно на ней), и сколько проехала.
 */
function beyondEdge(): { low: number; went: number } {
  const surface = buildSurface(buildWorld(дорогиСцены('крест'), 'plain'), 'A');
  const index = new GroundIndex(surface);
  const край = крайМира(surface.positions);
  const car = createCar(P, край.x1 + 30, 0, 0);
  let low = Infinity;
  for (let t = 0; t < 4; t += DT) {
    step(car, P, P_ZERO, (x, z) => index.sample(x, z), drive(forwardSpeed(car) < 10 ? 0.3 : 0), DT);
    for (const w of car.wheels) low = Math.min(low, центрКолеса(car, w, w.travel).y - w.radius - край.высота);
  }
  return { low, went: car.x - (край.x1 + 30) };
}

/**
 * Кузов и земля: насколько глубоко самый низкий угол кузова ушёл под
 * землю (м, 0 — не ушёл) — углы те же, которыми физика упирает кузов.
 */
const вЗемле = (car: Car, sample: (x: number, z: number) => Spot): number => {
  let deepest = 0;
  for (const [a, h, r] of углыКузова(P)) {
    const угол = точкаКузова(car, a, h, r);
    deepest = Math.max(deepest, sample(угол.x, угол.z).height - угол.y);
  }
  return deepest;
};

/**
 * Колесо висит на подвеске: от крепления на кузове — не дальше длины
 * подвески. Крепление считается поворотом three.js — ТЕМ ЖЕ, которым
 * кузов рисуется на экране, а не функцией физики: проверка ловит и отрыв
 * колеса в счёте, и расхождение счёта с показом. Возвращает, на сколько
 * самое дальнее колесо дальше подвески, м.
 */
const отрыв = (car: Car): number => {
  let worst = -Infinity;
  const q = new THREE.Quaternion(car.q.x, car.q.y, car.q.z, car.q.w);
  for (const w of car.wheels) {
    const a = new THREE.Vector3(w.ahead, w.крепление, w.right).applyQuaternion(q);
    const c = центрКолеса(car, w, w.travel);
    worst = Math.max(worst, Math.hypot(c.x - car.x - a.x, c.y - car.y - a.y, c.z - car.z - a.z) - w.rest);
  }
  return worst;
};

interface Бросок { worst: number; turned: number; deepest: number; rise: number }

/**
 * Полёт с обрыва. 28.09 Алекс: «если выпасть с карты, колёса отдаляются
 * от авто». Машина едет 25 м/с к обрыву в 40 м; на кромке её подбрасывает
 * кочкой — кузов кувыркается и носом, и боком. Меряется весь полёт,
 * удар и то, что после.
 */
function cliff(): Бросок {
  const car = createCar(P, 0, 0, 0);
  const EDGE = 30;
  const ground = (x: number): Spot => ({ ...FLAT(), height: x < EDGE ? 0 : -40 });
  car.vx = 25;
  for (const w of car.wheels) w.spin = 25 / w.radius;
  for (let t = 0; t < 0.3; t += DT) step(car, P, P_ZERO, (x) => ground(x), drive(0), DT);
  const r: Бросок = { worst: 0, turned: 0, deepest: 0, rise: 0 };
  const start = car.y;
  let kicked = false;
  for (let t = 0; t < 8; t += DT) {
    if (!kicked && car.x > EDGE) { подкрутить(car, -1.6, 1.2); kicked = true; }
    step(car, P, P_ZERO, (x) => ground(x), drive(0), DT);
    r.worst = Math.max(r.worst, отрыв(car));
    r.turned = Math.max(r.turned, Math.abs(car.pitch), Math.abs(car.roll));
    r.deepest = Math.max(r.deepest, вЗемле(car, (x) => ground(x)));
    r.rise = Math.max(r.rise, car.y - start);
  }
  return r;
}

/**
 * Подброшена над ровной землёй на 7 м и кувыркается (тангаж 2.4, крен
 * 1.7 рад/с) — так 28.09 снимали полёт на живой странице (`__подбросить`),
 * и приземлившуюся боком машину выстрелило в небо, а другую раскрутило
 * до −14705° крена.
 */
function tossed(): Бросок {
  const car = createCar(P, 0, 0, 0);
  for (let t = 0; t < 0.5; t += DT) step(car, P, P_ZERO, FLAT, drive(0, 1), DT);
  const start = car.y;
  car.y += 7; car.vy = 0;
  подкрутить(car, 2.4, 1.7);
  const r: Бросок = { worst: 0, turned: 0, deepest: 0, rise: 0 };
  let landed = false;
  for (let t = 0; t < 8; t += DT) {
    step(car, P, P_ZERO, FLAT, drive(0), DT);
    r.worst = Math.max(r.worst, отрыв(car));
    r.turned = Math.max(r.turned, Math.abs(car.pitch), Math.abs(car.roll));
    r.deepest = Math.max(r.deepest, вЗемле(car, FLAT));
    // взлёт — после первого касания: выше, чем машину подбросили, она не взлетит
    if (car.y < start + 1) landed = true;
    if (landed) r.rise = Math.max(r.rise, car.y - start);
  }
  // и в конце лежит, а не крутится: угловая скорость — от силы полоборота в секунду
  r.turned = Math.max(r.turned, Math.hypot(car.вращение.x, car.вращение.y, car.вращение.z) > 3 ? 99 : 0);
  return r;
}

/**
 * Съезд с края мира там, где это нашлось 28.09: край «креста», под ним
 * земля на 4.4 м ниже дороги, 54 км/ч. Машина приземлялась носом,
 * вставала на задние колёса и кузовом проваливалась сквозь землю.
 */
function offEdge(): Бросок {
  const surface = buildSurface(buildWorld(дорогиСцены('крест'), 'plain'), 'A');
  const index = new GroundIndex(surface);
  const sample = (x: number, z: number): Spot => index.sample(x, z);
  const край = крайМира(surface.positions);
  const car = createCar(P, край.x1 - 40, 0, 0);
  const r: Бросок = { worst: 0, turned: 0, deepest: 0, rise: 0 };
  let start = NaN;
  for (let t = 0; t < 10; t += DT) {
    step(car, P, P_ZERO, sample, drive(forwardSpeed(car) < 15 ? 0.4 : 0), DT);
    if (Number.isNaN(start)) start = car.y;
    r.worst = Math.max(r.worst, отрыв(car));
    r.turned = Math.max(r.turned, Math.abs(car.pitch), Math.abs(car.roll));
    r.deepest = Math.max(r.deepest, вЗемле(car, sample));
    r.rise = Math.max(r.rise, car.y - start);
  }
  return r;
}

/** Максимальная скорость: газ в пол по ровному, пока скорость не перестанет расти. */
function topSpeed(p: Passport): number {
  const car = createCar(p, 0, 0, 0);
  let best = 0;
  for (let t = 0; t < 150; t += DT) {
    step(car, p, p.шина, FLAT, drive(1), DT);
    best = Math.max(best, forwardSpeed(car));
  }
  return best;
}

// ─────────────────────────── печать ───────────────────────────

const line = (name: string, value: string): void => console.log(`  ${name.padEnd(40, '.')} ${value}`);
const label = broken ? '   [СЛОМАНО: перенос веса выключен]' : soft ? '   [СЛОМАНО: подвеска от дивана]' : '';
console.log(`\nМашина «${VIPER.name}» без экрана${label}\n`);

const run = launch();
const brake60 = brakeFrom(60 * MPH);
const circle = skidpad();
const around = lap();

interface Check { name: string; got: number; want: number; unit: string; tol: number }
const checks: Check[] = [
  { name: '0–60 миль/ч', got: run.sixty, want: 3.7, unit: 'с', tol: 0.08 },
  { name: 'четверть мили, время', got: run.quarter, want: 11.5, unit: 'с', tol: 0.08 },
  { name: 'четверть мили, скорость', got: run.trap, want: 127.3 * MPH, unit: 'м/с', tol: 0.08 },
  { name: 'торможение 60–0 миль/ч', got: brake60, want: 101 * 0.3048, unit: 'м', tol: 0.10 },
  { name: 'круг, боковая перегрузка', got: circle.g, want: 1.03, unit: 'g', tol: 0.08 },
];

console.log('ПОСЧИТАНО ЧЕТЫРЬМЯ ПЯТНАМИ / ЗАМЕРЕНО ЖУРНАЛОМ:');
let failed = 0;
for (const c of checks) {
  const off = (c.got - c.want) / c.want;
  const ok = Number.isFinite(off) && Math.abs(off) <= c.tol;
  if (!ok) failed++;
  const show = (x: number): string =>
    c.unit === 'м/с' ? `${(x * 3.6).toFixed(1)} км/ч` : `${x.toFixed(2)} ${c.unit}`;
  console.log(`  ${ok ? '✓' : '✗'} ${c.name.padEnd(28, '.')} ${show(c.got).padStart(11)}  против ${show(c.want).padStart(11)}   ${off >= 0 ? '+' : ''}${(off * 100).toFixed(1)}%`);
}

const floored = launch(false);
const still = standStill();
const back = backwards();
if (still > 0.05) { console.log(`  ✗ машина ТРОГАЕТСЯ САМА: ${(still * 3.6).toFixed(2)} км/ч без единой педали`); failed++; }
else console.log(`  ✓ стоит на месте, когда ничего не нажато`);
if (back < 3 || back * 3.6 > 55) { console.log(`  ✗ задний ход: ${(back * 3.6).toFixed(1)} км/ч — не едет или едет как вперёд`); failed++; }
else console.log(`  ✓ задний ход едет назад ......... ${(back * 3.6).toFixed(1)} км/ч`);

const rolling = freeRoll();
if (rolling > 0.02) { console.log(`  ✗ свободные колёса на старте ПРОСКАЛЬЗЫВАЮТ: до ${(rolling * 100).toFixed(0)}%`); failed++; }
else console.log(`  ✓ свободные колёса на старте катятся ... проскальзывание до ${(rolling * 100).toFixed(1)}%`);
const turn = turnsRight();
if (turn.yaw > 0.05 && turn.sideways > 1) console.log('  ✓ руль вправо поворачивает вправо');
else { console.log(`  ✗ руль вправо поворачивает ВЛЕВО: курс ${(turn.yaw * 180 / Math.PI).toFixed(0)}°, вбок ${turn.sideways.toFixed(1)} м`); failed++; }

const rest = stance();
const nose = dive();
const gradient = lean();
console.log('\nПОДВЕСКА (ходы и наклоны — следствие пружин, а не формулы):');
line('осадка под своим весом, перед / зад', `${rest.front.toFixed(0)} / ${rest.rear.toFixed(0)} мм`);
line('кузов стоит ровно', `тангаж ${rest.pitch.toFixed(2)}°, крен ${rest.roll.toFixed(2)}°`);
line('клевок при торможении в пол', `${nose.angle.toFixed(2)}° (перед ${nose.front.toFixed(0)} мм, зад ${nose.rear.toFixed(0)} мм)`);
line('крен в повороте', `${gradient.toFixed(2)}° на g`);
if (Math.abs(rest.pitch) > 0.15 || Math.abs(rest.roll) > 0.05) {
  console.log('  ✗ кузов стоит криво под собственным весом'); failed++;
} else console.log('  ✓ кузов стоит ровно и осел на свои миллиметры');
if (nose.angle < 0.3 || nose.angle > 4) { console.log(`  ✗ клевок неправдоподобный: ${nose.angle.toFixed(2)}°`); failed++; }
else console.log('  ✓ клюёт носом при торможении, как положено');
if (gradient < 0.6 || gradient > 3) { console.log(`  ✗ крен неправдоподобный: ${gradient.toFixed(2)}° на g`); failed++; }
else console.log('  ✓ кренится в повороте по-спорткаровски (1–2° на g)');

console.log('\nЗАОДНО:');
line('0–100 км/ч', `${run.hundred.toFixed(2)} с`);
line('0–60 миль/ч, если топить в пол без помощи', `${floored.sixty.toFixed(2)} с — колёса горят`);
line('радиус круга на пределе', `${circle.radius.toFixed(1)} м`);
line('тормозной путь со 100 км/ч', `${brakeFrom(100 / 3.6).toFixed(1)} м`);

console.log('\nКУВЫРОК (колесо на подвеске, кузов не в земле и не в небе):');
for (const [what, r] of [['обрыв 40 м с кувырком', cliff()], ['край «креста», 4.4 м на 54 км/ч', offEdge()], ['подброшена на 7 м, кувырок', tossed()]] as const) {
  line(`${what}`, `повернулся до ${((Math.min(r.turned, 3.2) * 180) / Math.PI).toFixed(0)}°`);
  line('  колесо дальше подвески / кузов в земле / взлёт', `${(Math.max(0, r.worst) * 100).toFixed(1)} см / ${(r.deepest * 100).toFixed(0)} см / ${r.rise.toFixed(2)} м`);
  if (r.worst > 0.01) { console.log(`  ✗ колесо ОТОШЛО от кузова дальше подвески на ${(r.worst * 100).toFixed(1)} см`); failed++; }
  if (r.deepest > 0.3) { console.log(`  ✗ кузов ПРОВАЛИЛСЯ в землю на ${(r.deepest * 100).toFixed(0)} см`); failed++; }
  // кувыркающаяся машина, падая на угол, переваливается и подскакивает;
  // катапульта 28.09 — 15 м и выше
  if (r.rise > 3) { console.log(`  ✗ машину ВЫСТРЕЛИЛО вверх на ${r.rise.toFixed(1)} м`); failed++; }
  if (r.turned >= 99) { console.log('  ✗ машина КРУТИТСЯ и через 8 секунд после удара'); failed++; }
  if (r.worst <= 0.01 && r.deepest <= 0.3 && r.rise <= 3 && r.turned < 99) console.log('  ✓ колесо на месте, кузов не в земле и не в небе');
}

const beyond = beyondEdge();
line('за краем мира: низ колеса от земли там', `${beyond.low.toFixed(2)} м, проехал ${beyond.went.toFixed(0)} м`);
if (!(beyond.low > -0.3) || !(beyond.went > 10)) { console.log('  ✗ за краем мира колесо ПРОВАЛИЛОСЬ сквозь нарисованную землю'); failed++; }
else console.log('  ✓ за краем мира стоит на земле и едет');

console.log('\nПОЕЗДКА ПО НАШЕМУ КВАРТАЛУ (сцена «крест», вдоль дороги):');
line('шагов физики', `${around.steps}`);
line('самая низкая точка под колесом', `${around.lowest.toFixed(2)} м`);
const total = Object.values(around.spots).reduce((s, n) => s + n, 0);
for (const [what, n] of Object.entries(around.spots).sort((a, b) => b[1] - a[1]))
  line(`  по чему ехали: ${what}`, `${((n / total) * 100).toFixed(0)}%`);
const fell = around.lowest < -50;
console.log(`  ${fell ? '✗' : '✓'} колесо ${fell ? 'ПРОВАЛИЛОСЬ мимо поверхности' : 'ни разу не потеряло опору'}`);
if (fell) failed++;

/**
 * ЛОГАН — независимая машина со своими замерами (паспорт `LOGAN`):
 * максимальная 172 км/ч (каталог drom.ru); тормозной путь со 100 км/ч
 * 42.9 м («За рулём», с ABS — он у Логана есть). Из них выведены КПД
 * трансмиссии и сцепление шины — поэтому допуск узкий. Разгон 0–100 —
 * честное предсказание, и заявлен он по-разному: drom.ru — 11.9 с,
 * auto.ru и autospot — 13.9 с (владельцы на DRIVE2 мерят 15.9). Сверка —
 * попадание в заявленный разброс, а не подгонка кривой момента под одну цифру.
 */
if (!broken && !soft) {
  const run = launch(true, LOGAN);
  const top = topSpeed(LOGAN);
  const stop = brakeFrom(100 / 3.6, LOGAN);
  console.log(`\nМашина «${LOGAN.name}» — те же четыре пятна, свой паспорт:`);
  const logan: Check[] = [
    { name: '0–100 км/ч (заявлено 11.9–13.9)', got: run.hundred, want: 12.9, unit: 'с', tol: 0.078 },
    { name: 'максимальная скорость', got: top * 3.6, want: 172, unit: 'км/ч', tol: 0.02 },
    { name: 'тормозной путь 100–0', got: stop, want: 42.9, unit: 'м', tol: 0.03 },
  ];
  // тянет передними: на старте в пол буксуют передние колёса, задние катятся
  const старт = createCar(LOGAN, 0, 0, 0);
  for (let t = 0; t < 0.5; t += DT) step(старт, LOGAN, LOGAN.шина, FLAT, drive(1), DT);
  const перед = (старт.wheels[0].slip + старт.wheels[1].slip) / 2, зад = (старт.wheels[2].slip + старт.wheels[3].slip) / 2;
  if (перед > 0.02 && Math.abs(зад) < 0.01) console.log(`  ✓ тянет передними колёсами: буксуют ${(перед * 100).toFixed(0)}% спереди, ${(зад * 100).toFixed(1)}% сзади`);
  else { console.log(`  ✗ ведут НЕ передние колёса: буксуют ${(перед * 100).toFixed(0)}% спереди, ${(зад * 100).toFixed(1)}% сзади`); failed++; }
  for (const c of logan) {
    const off = c.got / c.want - 1;
    const ok = Math.abs(off) <= c.tol;
    if (!ok) failed++;
    console.log(`  ${ok ? '✓' : '✗'} ${c.name.padEnd(28, '.')} ${`${c.got.toFixed(1)} ${c.unit}`.padStart(11)}  против ${`${c.want} ${c.unit}`.padStart(11)}   ${off >= 0 ? '+' : ''}${(off * 100).toFixed(1)}%`);
  }
}

console.log(`\n${failed === 0 ? 'СВЕРКА ПРОЙДЕНА' : `СВЕРКА ПРОВАЛЕНА: ${failed}`}\n`);
process.exit(failed === 0 ? 0 : 1);
