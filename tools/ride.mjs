/**
 * Проехаться по кварталу из терминала и снять, что получилось.
 *
 * Почему не хватило `npm run shot`: тот снимает неподвижные ракурсы. Здесь
 * надо нажать на газ, повернуть и затормозить — и убедиться, что машина
 * поехала, повернула и встала прямо в браузере, а не только в счёте.
 *
 * ВАЖНО про время: часы снаружи и время, насчитанное физикой, — разные вещи.
 * В безголовом браузере кадры идут медленнее реального времени, поэтому все
 * сроки здесь меряются временем физики, которое машина сообщает сама.
 *
 *   npm run ride                — сцена «крест», равнина
 *   npm run ride -- горка горы  — сцена и рельеф
 */

import { createServer } from 'vite';
import { chromium } from 'playwright';
import { mkdirSync } from 'node:fs';
import { VIPER } from '../src/car/passport.ts';
import { P_ZERO } from '../src/car/tyre.ts';
import { createCar, forwardSpeed, step } from '../src/car/car.ts';
import { GroundIndex } from '../src/car/ground.ts';
import { buildWorld } from '../src/world/world.ts';
import { buildSurface } from '../src/surface/index.ts';
import { SCENES } from '../src/scenes.ts';

/**
 * Эталон: та же машина, посчитанная здесь же, в терминале, — по той же сцене,
 * из той же точки, с тем же газом, что нажимает браузер. Число не переписано
 * ниоткуда: оно считается заново каждым запуском. Разойтись с браузером оно
 * может только если браузер считает НЕ ту машину или подаёт НЕ тот газ.
 */
function referenceHundred(from) {
  const index = new GroundIndex(buildSurface(buildWorld(SCENES[scene], terrain), 'A'));
  const car = createCar(VIPER, from.x, from.z, from.yaw);
  const dt = 1 / 300;
  let gas = 0;
  for (let t = 0; t < 40; t += dt) {
    gas = Math.min(0.85, gas + dt / 0.22); // тот же ход педали, что у клавиши W
    step(car, VIPER, P_ZERO, (x, z) => index.sample(x, z), { steer: 0, throttle: gas, brake: 0, handbrake: false, assist: false }, dt);
    if (forwardSpeed(car) >= 100 / 3.6) return t;
  }
  return NaN;
}

const PORT = 5202;
// «решётка» — квартал 230×230 с четырьмя перекрёстками. На «кресте» дорога
// просто кончается: машина на сотне проезжает её за восемь секунд.
const scene = process.argv[2] ?? 'решётка';
const terrain = process.argv[3] ?? 'plain';
const OPTIONAL = /fonts\.(googleapis|gstatic)\.com/;

mkdirSync('shots', { recursive: true });
const server = await createServer({ server: { port: PORT, strictPort: true }, logLevel: 'warn' });
await server.listen();

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1600, height: 900 } });
// Шрифты грузятся с чужого хоста, и в контейнере это иногда виснет.
// Проверка не про шрифты — рубим их сразу, чтобы снимки не ждали сети.
await page.route('**://fonts.googleapis.com/**', (r) => r.abort());
await page.route('**://fonts.gstatic.com/**', (r) => r.abort());

const problems = [];
page.on('pageerror', (e) => problems.push('ошибка в коде: ' + String(e).split('\n')[0]));
page.on('requestfailed', (r) => { if (!OPTIONAL.test(r.url())) problems.push('не загрузилось: ' + r.url()); });

const car = () => page.evaluate(() => window.__car());

/**
 * Дождаться события и снять показания В ТОТ ЖЕ МИГ.
 *
 * Читать состояние отдельным запросом после ожидания нельзя: между тем, как
 * условие сработало, и тем, как ответ дойдёт обратно, машина проезжает ещё
 * секунду. На этом первая версия проверки и соврала на целую секунду.
 */
async function until(name, mark, limit = 45000) {
  await page.evaluate(() => { window.__hit = null; });
  try {
    await page.waitForFunction((m) => {
      const c = window.__car();
      if (c === null) return false;
      const hit =
        m === 'газ' ? c.throttle > 0.05
        : m === 'шестьдесят' ? c.speed * 3.6 >= 60
        : m === 'сотня' ? c.speed * 3.6 >= 100
        : m === 'поворот' ? Math.abs(c.yaw - window.__yaw0) > 0.8
        // «встала» — это либо ноль, либо уже включился задний ход: держать
        // тормоз дольше нельзя, он на стоянке становится задней тягой
        : Math.abs(c.speed) * 3.6 < 1.5 || c.reverse === true;
      if (hit) window.__hit = c;
      return hit;
    }, mark, { timeout: limit, polling: 30 });
  } catch {
    problems.push(`не дождались: ${name}`);
  }
  return page.evaluate(() => window.__hit ?? window.__car());
}

const url = `http://localhost:${PORT}/?scene=${encodeURIComponent(scene)}&terrain=${terrain}&view=close`;
await page.goto(url, { waitUntil: 'load' });
await page.waitForFunction(() => window.__ready === true, null, { timeout: 40000 });
await page.click('button[data-drive="seat"]');
await page.waitForFunction(() => window.__car() !== null, null, { timeout: 10000 });
// взять руль: щелчок по картинке захватывает указатель, как в игре
await page.mouse.click(800, 500);
await page.waitForTimeout(300);
const held = await page.evaluate(() => document.pointerLockElement !== null);
if (!held) problems.push('указатель не захватился — рулить нечем');
// Взяли руль и мыши не касались — руль обязан быть прямым. Браузер при
// захвате телепортирует курсор в середину и присылает это как движение;
// если его засчитать, машина уезжает в поле сама.
const grabbed = await car();

const spawn = await car();
await page.evaluate(() => { window.__yaw0 = window.__car().yaw; });
/**
 * Снимок — это доказательство, а не утверждение. Если браузер завис на
 * загрузке шрифтов, приговор поездке от этого не меняется: пробуем ещё раз,
 * не вышло — говорим вслух и едем дальше. Проверку это не ослабляет:
 * ни одна галочка на снимках не держится.
 */
let missed = 0;
const shot = async (name) => {
  for (const wait of [8000, 20000]) {
    try { await page.screenshot({ path: `shots/${name}.png`, timeout: wait }); return; }
    catch { /* пробуем ещё раз */ }
  }
  missed++;
  console.log(`  ! снимок «${name}» не получился — браузер не отдал картинку`);
};

await shot('ride-1-стоим');

// Эталон считается ДО того, как машина тронется: пока Node занят счётом,
// браузер продолжает жить, и время в нём идёт. Первая версия проверки на
// этом и обманулась — приписала разгону целую секунду стояния на месте.
const REFERENCE = referenceHundred(spawn);

// 1. РАЗГОН. Отсчёт ведём НЕ от нажатия клавиши, а от мига, когда физика
// увидела газ: между этими событиями лежит неизвестная задержка браузера,
// и из-за неё первая версия проверки то проходила, то падала.
await page.keyboard.down('w');
const start = await until('газ появился', 'газ', 10000);
const hundred = await until('разгон до 100 км/ч', 'сотня');
await shot('ride-2-разгон');

// 2. ТОРМОЗ в пол до полной остановки, пока не уехали далеко.
await page.keyboard.up('w');
await page.keyboard.down('s');
const stopped = await until('полная остановка', 'стоп');
await page.keyboard.up('s');
await shot('ride-3-встали');
await page.waitForTimeout(500);

// 3. ПОМОЩЬ РУЛЮ — на шестидесяти. Там предел по сцеплению уже работает
// полностью, но машина ещё не сходит с ума: на сотне полный выворот без
// помощи разворачивает её на месте, и всё, что идёт следом, теряет смысл.
await page.evaluate(() => { window.__yaw0 = window.__car().yaw; });
await page.keyboard.down('w');
await until('разгон до шестидесяти', 'шестьдесят', 25000);
await page.keyboard.up('w');
// руль вправо до упора: с захваченным указателем это сдвиг, а не позиция
for (let i = 0; i < 12; i++) await page.mouse.move(800 + i * 90, 500);
await page.waitForTimeout(350);
const withHelp = await car();
// переключаем КЛАВИШЕЙ: указатель захвачен рулём, по кнопкам мышью не попасть
await page.keyboard.press('g');
await page.waitForTimeout(400);
const noHelp = await car();
await page.keyboard.press('g');

// 4. ПОВОРОТ — руль уже вывернут, ждём, пока курс изменится заметно.
const turned = await until('поворот', 'поворот', 30000);
await shot('ride-4-поворот');
// Просто тормозим пару секунд и едем дальше. Ждать полной остановки тут
// незачем: торможение уже проверено отдельно, а ожидание хрупкое —
// на траве машина может докатываться дольше любого срока.
await page.keyboard.press('r'); // выровнять руль
await page.keyboard.down('s');
await page.waitForTimeout(2500);
await page.keyboard.up('s');

// 5. Поставить машину обратно на дорогу и выйти: она остаётся стоять,
// и на неё можно посмотреть со стороны — проверка глазами.
await page.keyboard.press('Enter'); // выйти из машины: она остаётся стоять
await page.waitForTimeout(1600);
await shot('ride-5-стоит');

// 6. ТРАФИК. Включаем в самом конце и отдельно: восемнадцать чужих машин
// заметно роняют частоту кадров в безголовом браузере, а ездовые проверки
// ограничены реальным временем и начинают не дожидаться.
await page.click('button[data-drive="traffic"]');
await page.waitForTimeout(600);
const trafficBefore = await page.evaluate(() => window.__traffic());
await page.waitForTimeout(2500);
const trafficAfter = await page.evaluate(() => window.__traffic());
// смотрим на весь квартал: иначе камера стоит у машины игрока и чужих не видно
await page.click('button[data-view="road"]');
await page.waitForTimeout(2600);
await shot('ride-6-трафик');
await page.click('button[data-view="over"]');
await page.waitForTimeout(2600);
await shot('ride-7-сверху');
// один перекрёсток крупно: пути через него и кто кого пропускает
await page.click('button[data-view="node"]');
await page.waitForTimeout(6000);
await shot('ride-9-перекрёсток');

// 7. ВИД ИЗ САЛОНА, уже среди трафика и светофоров. Машину сначала ставим
// обратно на дорогу: к концу поездки она стоит в поле, и оттуда не видно города
await page.click('button[data-drive="park"]');
await page.click('button[data-drive="seat"]');
await page.waitForTimeout(500);
await page.mouse.click(800, 500);             // взять руль
await page.keyboard.press('c');               // пересесть за руль изнутри
await page.keyboard.down('w');
await page.waitForTimeout(2500);
await page.keyboard.up('w');
await page.waitForTimeout(300);
await shot('ride-8-из-салона');

await browser.close();

const row = (what, c) => console.log(
  `  ${what.padEnd(20, '.')} ${(c.speed * 3.6).toFixed(0).padStart(4)} км/ч  ` +
  `передача ${c.reverse ? 'R' : c.gear + 1}  ${Math.round(c.rpm)} об/мин  ` +
  `время физики ${c.sim.toFixed(2)} с  под колёсами ${[...new Set(c.materials)].join('+')}`);

console.log('\nчто говорила машина:');
row('тронулись', start);
row('набрали сотню', hundred);
row('встали от тормоза', stopped);
row('повернули', turned);

const checks = [
  ['руль прям, пока мышь не трогали', Math.abs(grabbed.command) < 0.02, `${(grabbed.command * 100).toFixed(1)}% хода`],
  ['разогналась до 100 км/ч', hundred.speed * 3.6 >= 99, `за ${(hundred.sim - start.sim).toFixed(2)} с физики`],
  ['браузер считает ту же машину', Math.abs(hundred.sim - start.sim - REFERENCE) < 0.25, `${(hundred.sim - start.sim).toFixed(2)} с в браузере против ${REFERENCE.toFixed(2)} в терминале`],
  ['повернула по рулю', Math.abs(turned.yaw - start.yaw) > 0.7, `${((turned.yaw - start.yaw) * 180 / Math.PI).toFixed(0)}°`],
  ['встала от тормоза', Math.abs(stopped.speed) * 3.6 < 1.5, `${(stopped.speed * 3.6).toFixed(1)} км/ч`],
  ['ни разу не потеряла опору', !start.lost && !hundred.lost && !turned.lost && !stopped.lost, 'колёса на поверхности'],
  ['осталась в пределах квартала', Math.hypot(turned.x, turned.z) < 175, `${Math.hypot(turned.x, turned.z).toFixed(0)} м от центра`],
  ['мышь выворачивает руль до упора', Math.abs(noHelp.command) > 0.95, `${(noHelp.command * 100).toFixed(0)}% хода`],
  ['чужие машины поехали',
    trafficAfter.length > 0 && trafficAfter.some((c, i) => Math.abs(c.s - trafficBefore[i].s) > 3 || c.shape !== trafficBefore[i].shape),
    `${trafficAfter.length} штук, самая быстрая ${(Math.max(...trafficAfter.map((c) => c.speed)) * 3.6).toFixed(0)} км/ч`],
  ['помощь держит колёса в пределе сцепления',
    Math.abs(withHelp.steer) < Math.abs(noHelp.steer) * 0.6,
    `${(Math.abs(withHelp.steer) * 180 / Math.PI).toFixed(1)}° с помощью против ${(Math.abs(noHelp.steer) * 180 / Math.PI).toFixed(1)}° без неё, упор ${(noHelp.lock * 180 / Math.PI).toFixed(1)}°`],
];
console.log('');
let bad = 0;
for (const [name, ok, detail] of checks) {
  if (!ok) bad++;
  console.log(`  ${ok ? '✓' : '✗'} ${name.padEnd(32, '.')} ${detail}`);
}
for (const p of problems) console.log('  ✗ ' + p);
if (missed > 0) console.log(`  снимков не получилось: ${missed} — приговор от них не зависит`);
console.log(bad + problems.length === 0 ? '\nПОЕЗДКА ПРОЙДЕНА\n' : `\nПОЕЗДКА ПРОВАЛЕНА: ${bad + problems.length}\n`);

server.close().catch(() => {});
process.exit(bad + problems.length > 0 ? 1 : 0);
