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
import { построитьПосёлок, вырезать, интересноеМесто } from '../src/city/plan.ts';
import { построитьДома } from '../src/city/house.ts';
import { преграды, пройти } from '../src/city/walls.ts';

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

// ── Идти вбок: тело не разворачивается, взгляд стоит на месте.
{
  const p = createPerson(0, 0, ground);
  const body0 = p.body, gaze0 = gaze(p).yaw;
  const SIDE = { forward: 0, side: 1, run: false };
  for (let i = 0; i < 240; i++) step(p, ground, SIDE, DT, OPTIONS);
  say('идёт вбок, не разворачиваясь',
    Math.abs(deg(p.body - body0)) < 10 && Math.abs(deg(gaze(p).yaw - gaze0)) < 10,
    `тело ушло на ${deg(p.body - body0).toFixed(0)}°, взгляд на ${deg(gaze(p).yaw - gaze0).toFixed(0)}°`);
}

// ── Ступенька под ногами: ноги её гасят, голова не прыгает.
{
  // бордюр 15 см ровно на пути: земля ниже нуля до x=1, выше после
  const curb: typeof ground = {
    sample: (x: number) => ({ height: x < 1 ? 0 : 0.15, nx: 0, ny: 1, nz: 0 }),
  } as typeof ground;
  const p = createPerson(0, 0, curb);
  let jump = 0, was = eyes(p).y;
  for (let i = 0; i < 180; i++) {
    step(p, curb, AHEAD, DT, OPTIONS);
    const now = eyes(p).y;
    jump = Math.max(jump, Math.abs(now - was));
    was = now;
  }
  say('бордюр гасится ногами, а не бьёт по голове', jump < 0.03,
    `самый резкий скачок головы ${(jump * 1000).toFixed(0)} мм за кадр`);
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

// ── Три звена по очереди: сначала глаза, потом шея, тело стоит.
{
  const p = createPerson(0, 0, ground);
  look(p, 40, 0, 40 / (Math.PI / 6)); // рывок мышью на 30°
  for (let i = 0; i < 9; i++) step(p, ground, STILL, DT, OPTIONS); // 0.15 с
  const eyeEarly = Math.abs(deg(p.eyeYaw));
  const neckEarly = Math.abs(deg(p.neck));
  for (let i = 0; i < 51; i++) step(p, ground, STILL, DT, OPTIONS); // ещё 0.85 с
  const eyeLate = Math.abs(deg(p.eyeYaw));
  const neckLate = Math.abs(deg(p.neck));
  say('сначала глаза, потом шея, тело на месте',
    eyeEarly > neckEarly && eyeLate < 2 && neckLate > 25 && Math.abs(deg(p.body)) < 1,
    `через 0.15 с: глаза ${eyeEarly.toFixed(0)}°, шея ${neckEarly.toFixed(0)}°; ` +
    `через секунду: глаза ${eyeLate.toFixed(1)}°, шея ${neckLate.toFixed(0)}°`);
}

// ── Мышь сглажена: один рывок не швыряет взгляд за кадр.
{
  const p = createPerson(0, 0, ground);
  look(p, 600, 0, 1200); // резкий бросок мыши на полрадиана
  step(p, ground, STILL, DT, OPTIONS);
  const first = Math.abs(deg(gaze(p).yaw));
  let worst = 0, was = gaze(p).yaw;
  for (let i = 0; i < 120; i++) {
    step(p, ground, STILL, DT, OPTIONS);
    worst = Math.max(worst, Math.abs(deg(gaze(p).yaw - was)) / DT);
    was = gaze(p).yaw;
  }
  say('мышь сглажена: взгляд не швыряет', first < 6 && worst < 400 && Math.abs(deg(gaze(p).yaw)) > 25,
    `за первый кадр ${first.toFixed(1)}°, быстрее всего ${worst.toFixed(0)}°/с, дошёл до ${deg(gaze(p).yaw).toFixed(0)}°`);
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

// ── Моргание символическое: реже и короче человеческого — вкус Алекса.
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
  say('моргает символически, а не мигает', blinks >= 4 && blinks <= 10 && perBlink > 80 && perBlink < 220,
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

/**
 * ── СТЕНЫ. Дом — не картинка: сквозь него не пройти, а войти можно только
 *    в дверь. Проверяется на НАСТОЯЩЕМ доме из посёлка, а не на выдуманном
 *    прямоугольнике: если завтра дом изменится, проверка изменится с ним.
 *
 * Рядом стоит парная проверка «без преграды проходит насквозь». Без неё
 * первая ничего не значит: она проходила бы и тогда, когда человек просто
 * не дошёл до стены.
 */
{
  const посёлок = построитьПосёлок(20260913, 400, 'город');
  const окно = вырезать(посёлок, интересноеМесто(посёлок), 110);
  const { дома } = построитьДома(окно.объекты, 'город', () => 0, посёлок.сид);
  const стены = преграды(дома);
  const ПЛЕЧО = 0.28;

  /** Идти двадцать метров из точки в сторону и вернуть, где оказался. */
  const идти = (x: number, z: number, дx: number, дz: number, сквозь: boolean) => {
    let цx = x, цz = z;
    for (let i = 0; i < 400; i++) {
      const нx = цx + дx * 0.05, нz = цz + дz * 0.05;
      const шаг = сквозь ? { x: нx, z: нz } : пройти(стены, цx, цz, нx, нz, ПЛЕЧО);
      цx = шаг.x; цz = шаг.z;
    }
    return { x: цx, z: цz };
  };

  // берём жилой дом и идём в его ГЛУХОЙ торец — там двери нет по построению
  const дом = дома.find((д) => д.что === 'жильё' && д.дверей > 0);
  if (!дом) {
    say('стены: нашёлся дом для проверки', false, 'в окне нет жилого дома с дверью');
  } else {
    const fx = -дом.нz, fz = дом.нx;
    // старт сбоку от торца, идём поперёк дома насквозь
    const сбоку = {
      x: дом.x + fx * (дом.фронт / 2 + 6),
      z: дом.z + fz * (дом.фронт / 2 + 6),
    };
    const внутрь = { x: -fx, z: -fz };
    const упёрся = идти(сбоку.x, сбоку.z, внутрь.x, внутрь.z, false);
    const сквозной = идти(сбоку.x, сбоку.z, внутрь.x, внутрь.z, true);

    /**
     * Где точка относительно дома: вбок от середины фронта и вглубь от фасада.
     *
     * Первая редакция мерила «расстояние до ближайшей стены» — и человек,
     * который честно вошёл в дверь и упёрся в заднюю стену, считался
     * не вошедшим: до задней стены у него оставалось 28 сантиметров.
     * Мерить надо то, что спрашиваем: внутри он или снаружи.
     */
    const место = (т: { x: number; z: number }): { вбок: number; вглубь: number } => {
      const dx = т.x - дом.x, dz = т.z - дом.z;
      return {
        вбок: Math.abs(dx * fx + dz * fz),
        вглубь: дом.глубина / 2 - (dx * дом.нx + dz * дом.нz),
      };
    };
    const внутри = (т: { x: number; z: number }): boolean => {
      const м = место(т);
      return м.вбок < дом.фронт / 2 - 0.05 && м.вглубь > 0.05 && м.вглубь < дом.глубина - 0.05;
    };
    say('сквозь глухой торец не пройти', !внутри(упёрся),
      `упёрся в ${(место(упёрся).вбок - дом.фронт / 2).toFixed(2)} м от торца`);
    say('без преграды проходит насквозь — иначе проверка пустая', внутри(сквозной),
      `без стен оказался в ${(дом.фронт / 2 - место(сквозной).вбок).toFixed(1)} м внутри торца`);

    // а теперь в дверь: прямо в её середину с улицы
    const дверь = дом.проёмы.find((п) => п.вид === 'дверь' && п.стена === 0 && п.этаж === 0);
    if (!дверь) {
      say('в дверь можно войти', false, 'у дома нет двери на фасаде');
    } else {
      const вдоль = (дверь.от + дверь.до) / 2 - дверь.длинаСтены / 2;
      const уДвери = {
        x: дом.x + fx * вдоль + дом.нx * (дом.глубина / 2 + 5),
        z: дом.z + fz * вдоль + дом.нz * (дом.глубина / 2 + 5),
      };
      const вошёл = идти(уДвери.x, уДвери.z, -дом.нx, -дом.нz, false);
      say('в дверь можно войти', внутри(вошёл),
        внутри(вошёл) ? `вошёл на ${место(вошёл).вглубь.toFixed(1)} м от фасада`
          : 'в дверь не пустило');
    }
  }
}

console.log(`\nПЕШЕХОД${broken ? ' — ЗАВЕДОМО СЛОМАННЫЙ: шеи нет' : ''}\n`);
let failed = 0;
for (const [name, ok, note] of checks) {
  if (!ok) failed++;
  console.log(`  ${ok ? '✓' : '✗'} ${name.padEnd(46, '.')} ${note}`);
}
console.log(`\n${failed === 0 ? 'ПЕШЕХОД В ПОРЯДКЕ' : `ПЕШЕХОД ПРОВАЛЕН: ${failed}`}\n`);
process.exit(failed === 0 ? 0 : 1);
