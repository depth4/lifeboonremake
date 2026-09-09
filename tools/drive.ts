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

import { SCENES } from '../src/scenes.ts';
import { buildWorld } from '../src/world/world.ts';
import { buildSurface } from '../src/surface/index.ts';
import { GroundIndex, type Spot } from '../src/car/ground.ts';
import { VIPER } from '../src/car/passport.ts';
import { P_ZERO } from '../src/car/tyre.ts';
import { type Car, type Controls, createCar, forwardSpeed, step } from '../src/car/car.ts';

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
function launch(traction = true): { sixty: number; hundred: number; quarter: number; trap: number } {
  const car = createCar(P, 0, 0, 0);
  let t = 0, x = 0, sixty = NaN, hundred = NaN, quarter = NaN, trap = NaN;
  while (t < 40) {
    const slip = (car.wheels[2].slip + car.wheels[3].slip) / 2;
    const gas = traction ? Math.max(0, Math.min(1, 1 - (slip / P_ZERO.peakSlip - 1) * 2.5)) : 1;
    step(car, P, P_ZERO, FLAT, drive(gas), DT);
    const v = forwardSpeed(car);
    x += v * DT; t += DT;
    if (Number.isNaN(sixty) && v >= 60 * MPH) sixty = t;
    if (Number.isNaN(hundred) && v >= 100 / 3.6) hundred = t;
    if (x >= 402.336) { quarter = t; trap = v; break; }
  }
  return { sixty, hundred, quarter, trap };
}

/** Торможение в пол с заданной скорости: сколько метров до полной остановки. */
function brakeFrom(v0: number): number {
  const car = createCar(P, 0, 0, 0);
  car.vx = v0;
  for (const w of car.wheels) w.spin = v0 / w.radius;
  let x = 0, t = 0;
  while (forwardSpeed(car) > 0.3 && t < 20) {
    step(car, P, P_ZERO, FLAT, drive(0, 1), DT);
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
  const world = buildWorld(SCENES['крест'], 'plain');
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
      if (w.y < lowest) lowest = w.y;
    }
    steps++;
    if (!Number.isFinite(car.x) || !Number.isFinite(car.z)) break;
  }
  return { spots, lowest, steps };
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

console.log('\nПОЕЗДКА ПО НАШЕМУ КВАРТАЛУ (сцена «крест», вдоль дороги):');
line('шагов физики', `${around.steps}`);
line('самая низкая точка под колесом', `${around.lowest.toFixed(2)} м`);
const total = Object.values(around.spots).reduce((s, n) => s + n, 0);
for (const [what, n] of Object.entries(around.spots).sort((a, b) => b[1] - a[1]))
  line(`  по чему ехали: ${what}`, `${((n / total) * 100).toFixed(0)}%`);
const fell = around.lowest < -50;
console.log(`  ${fell ? '✗' : '✓'} колесо ${fell ? 'ПРОВАЛИЛОСЬ мимо поверхности' : 'ни разу не потеряло опору'}`);
if (fell) failed++;

console.log(`\n${failed === 0 ? 'СВЕРКА ПРОЙДЕНА' : `СВЕРКА ПРОВАЛЕНА: ${failed}`}\n`);
process.exit(failed === 0 ? 0 : 1);
