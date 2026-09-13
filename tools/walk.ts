/**
 * Пешеход без экрана: проверяется не картинка, а устройство.
 *
 * Вопрос, на который отвечает эта проверка: ведёт ли себя тело как тело.
 * Шея кончается, тело доворачивается медленно, ноги разгоняются и гасят ход,
 * шаг считается путём, а не временем, голова не проваливается под землю.
 *
 * Запуск:  npm run walk
 *          npm run walk сломать   — снять предел шеи, проверка ОБЯЗАНА упасть
 */

import { SCENES } from '../src/scenes.ts';
import { buildWorld } from '../src/world/world.ts';
import { buildSurface } from '../src/surface/index.ts';
import { GroundIndex } from '../src/car/ground.ts';
import { EYE_HEIGHT, createPerson, eyes, gaze, look, step } from '../src/person/person.ts';

const broken = process.argv[2] === 'сломать';
const world = buildWorld(SCENES['решётка'], 'plain');
const ground = new GroundIndex(buildSurface(world));
const DT = 1 / 60;
const OPTIONS = broken ? { neck: false } : {};
const STILL = { forward: 0, side: 0, run: false };
const AHEAD = { forward: 1, side: 0, run: false };
const deg = (rad: number): number => (rad * 180) / Math.PI;

const checks: [string, boolean, string][] = [];
const say = (name: string, ok: boolean, note: string): void => { checks.push([name, ok, note]); };

// ── Стоя не шагаем: шаг считается пройденным путём, а не временем.
{
  const p = createPerson(0, 0, ground);
  for (let i = 0; i < 120; i++) step(p, ground, STILL, DT, OPTIONS);
  say('стоя не шагает', p.walked < 0.001 && Math.abs(eyes(p).y - (p.ground + EYE_HEIGHT)) < 1e-6,
    `прошёл ${p.walked.toFixed(3)} м, качка ${(eyes(p).y - p.ground - EYE_HEIGHT).toFixed(4)} м`);
}

// ── Идёт человеческим шагом и разгоняется не мгновенно.
{
  const p = createPerson(0, 0, ground);
  step(p, ground, AHEAD, DT, OPTIONS);
  const first = Math.hypot(p.vx, p.vz);
  for (let i = 0; i < 60; i++) step(p, ground, AHEAD, DT, OPTIONS);
  const cruise = Math.hypot(p.vx, p.vz);
  say('идёт 1.4 м/с, а не рывком', cruise > 1.3 && cruise < 1.5 && first < 0.4,
    `через кадр ${first.toFixed(2)} м/с, через секунду ${cruise.toFixed(2)} м/с`);

  // отпустили клавиши — гасит ход, но не встаёт как вкопанный
  step(p, ground, STILL, DT, OPTIONS);
  const justAfter = Math.hypot(p.vx, p.vz);
  let stoppedAfter = 0;
  while (Math.hypot(p.vx, p.vz) > 0.01 && stoppedAfter < 2) { step(p, ground, STILL, DT, OPTIONS); stoppedAfter += DT; }
  say('останавливается с весом, а не мгновенно', justAfter > 1.0 && stoppedAfter > 0.05 && stoppedAfter < 0.4,
    `через кадр ещё ${justAfter.toFixed(2)} м/с, встал за ${stoppedAfter.toFixed(2)} с`);
}

// ── Шея: малый поворот берёт голова, тело стоит.
{
  const p = createPerson(0, 0, ground);
  const body0 = p.body;
  look(p, 60, 0, 60 / (Math.PI / 3)); // ровно 60° вбок
  for (let i = 0; i < 60; i++) step(p, ground, STILL, DT, OPTIONS);
  say('60° берёт шея, тело стоит', Math.abs(p.body - body0) < 0.01 && Math.abs(deg(p.neck) - 60) < 3,
    `тело ${deg(p.body - body0).toFixed(1)}°, шея ${deg(p.neck).toFixed(0)}°`);
}

// ── Шея кончается: 140° шеей не взять, тело обязано довернуться.
{
  const p = createPerson(0, 0, ground);
  const body0 = p.body;
  look(p, 140, 0, 140 / ((140 * Math.PI) / 180));
  for (let i = 0; i < 180; i++) step(p, ground, STILL, DT, OPTIONS);
  say('140° шеей не взять — доворачивается тело',
    Math.abs(deg(p.neck)) <= 81 && Math.abs(deg(p.body - body0)) > 50,
    `шея ${deg(p.neck).toFixed(0)}°, тело довернулось на ${deg(p.body - body0).toFixed(0)}°`);
}

// ── На 360° не повернуться, не переставив ног.
{
  const p = createPerson(0, 0, ground);
  const body0 = p.body;
  look(p, 360, 0, 360 / (2 * Math.PI));
  for (let i = 0; i < 240; i++) step(p, ground, STILL, DT, OPTIONS);
  const turned = deg(p.body - body0);
  say('круг мышью разворачивает тело, а не одну голову', turned > 260,
    `тело развернулось на ${turned.toFixed(0)}° из 360`);
}

// ── Глаза ведут, голова догоняет.
{
  const p = createPerson(0, 0, ground);
  look(p, 40, 0, 40 / (Math.PI / 6)); // рывок на 30°
  step(p, ground, STILL, DT, OPTIONS);
  const eyeFirst = Math.abs(deg(p.eyeYaw));
  const gazeFirst = Math.abs(deg(gaze(p).yaw));
  for (let i = 0; i < 45; i++) step(p, ground, STILL, DT, OPTIONS);
  const eyeLater = Math.abs(deg(p.eyeYaw));
  say('глаза прыгают первыми, голова догоняет',
    eyeFirst > 10 && gazeFirst > 20 && eyeLater < 2 && Math.abs(deg(p.neck)) > 25,
    `сразу: глаза ${eyeFirst.toFixed(0)}°, взгляд уже ${gazeFirst.toFixed(0)}°; ` +
    `через 0.75 с: глаза ${eyeLater.toFixed(1)}°, шея ${deg(p.neck).toFixed(0)}°`);
}

// ── Тряска: на ходу есть, но маленькая; на месте её нет.
{
  const p = createPerson(0, 0, ground);
  let lowest = Infinity, highest = -Infinity;
  for (let i = 0; i < 300; i++) {
    step(p, ground, AHEAD, DT, OPTIONS);
    const e = eyes(p);
    const above = e.y - p.ground - EYE_HEIGHT;
    lowest = Math.min(lowest, above);
    highest = Math.max(highest, above);
  }
  const swing = highest - lowest;
  say('голову качает, но чуть-чуть', swing > 0.02 && swing < 0.06,
    `размах ${(swing * 100).toFixed(1)} см`);
}

// ── Моргание: 15–20 раз в минуту, по четверти секунды.
{
  const p = createPerson(0, 0, ground);
  let blinks = 0, closed = 0;
  let was = p.lids;
  for (let i = 0; i < 60 * 60; i++) {
    step(p, ground, STILL, DT, OPTIONS);
    if (p.lids > 0 && was === 0) blinks++;
    if (p.lids > 0) closed += DT;
    was = p.lids;
  }
  const perBlink = (closed / Math.max(1, blinks)) * 1000;
  say('моргает по-человечески', blinks >= 13 && blinks <= 25 && perBlink > 200 && perBlink < 400,
    `${blinks} раз за минуту, по ${perBlink.toFixed(0)} мс`);
}

// ── Глаза всегда на своей высоте над землёй, куда бы ни зашёл.
{
  const p = createPerson(0, 0, ground);
  let worst = 0;
  for (let i = 0; i < 900; i++) {
    step(p, ground, { forward: 1, side: Math.sin(i / 90), run: i % 200 < 100 }, DT, OPTIONS);
    worst = Math.max(worst, Math.abs(eyes(p).y - p.ground - EYE_HEIGHT));
  }
  say('глаза держат высоту над землёй', worst < 0.05,
    `худшее отклонение ${(worst * 100).toFixed(1)} см на 25 м пути`);
}

console.log(`\nПЕШЕХОД${broken ? ' — ЗАВЕДОМО СЛОМАННЫЙ: шеи нет' : ''}\n`);
let failed = 0;
for (const [name, ok, note] of checks) {
  if (!ok) failed++;
  console.log(`  ${ok ? '✓' : '✗'} ${name.padEnd(46, '.')} ${note}`);
}
console.log(`\n${failed === 0 ? 'ПЕШЕХОД В ПОРЯДКЕ' : `ПЕШЕХОД ПРОВАЛЕН: ${failed}`}\n`);
process.exit(failed === 0 ? 0 : 1);
