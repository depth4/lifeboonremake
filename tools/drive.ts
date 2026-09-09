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

const broken = process.argv[2] === 'сломать';
const MPH = 0.44704;
const DT = 1 / 600;

/** Ровный асфальт до горизонта — чтобы мерить машину, а не дорогу. */
const FLAT = (): Spot => ({ height: 0, nx: 0, ny: 1, nz: 0, material: 'asphalt' });

const P = broken ? { ...VIPER, cgHeight: 0 } : VIPER; // высота ЦМ = 0 убивает перенос веса

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

// ─────────────────────────── печать ───────────────────────────

const line = (name: string, value: string): void => console.log(`  ${name.padEnd(40, '.')} ${value}`);
console.log(`\nМашина «${VIPER.name}» без экрана${broken ? '   [СЛОМАНО: перенос веса выключен]' : ''}\n`);

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
