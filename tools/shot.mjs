/**
 * Снимки экрана из терминала. Никакого монитора не нужно.
 *
 *   npm run shot                       — ракурс «вдоль», сцена по умолчанию
 *   npm run shot -- close крест горы   — ракурс, сцена, рельеф
 *   npm run shot -- all plan           — по снимку на каждую сцену
 *
 * Все снимки одного запуска делаются в одном браузере: так на дюжину сцен
 * уходит несколько секунд, а не минута.
 */

import { createServer } from 'vite';
import { chromium } from 'playwright';
import { mkdirSync } from 'node:fs';
import { SCENES, кусок } from '../src/scenes.ts';
import { ЗАСТРОЙКА, ДОМ } from '../src/city/norms.ts';
import { buildWorld } from '../src/world/world.ts';
import { buildSurface } from '../src/surface/index.ts';
import { GroundIndex } from '../src/car/ground.ts';

const PORT = 5199;
const args = process.argv.slice(2);
let all = args[0] === 'all';
let view = (all ? args[1] : args[0]) ?? 'road';
let terrain = (all ? args[2] : args[2]) ?? 'plateau';
let scene = all ? null : args[1];

// наводка: npm run shot -- наводка крест холмы from=x,y,z at=x,y,z
const aim = Object.fromEntries(
  args.filter((a) => a.includes('=')).map((a) => a.split('=')),
);

/**
 * Прицел ОТ ОБЪЕКТА: `npm run shot -- перед магазин город`.
 *
 * Считать координаты камеры руками — это каждый раз лотерея: дважды
 * подряд камера оказывалась внутри дома, и оба снимка пришлось выкинуть.
 * Здесь она встаёт туда, где стоит человек: на тротуар своей улицы,
 * лицом к фасаду, на высоте глаз.
 *
 *   перед <назначение> [сцена]  — смотреть на объект с тротуара
 *   вдоль <назначение> [сцена]  — встать там же и смотреть ВДОЛЬ улицы
 */
const ГЛАЗ = 1.65;
if (args[0] === 'перед' || args[0] === 'вдоль') {
  const что = args[1] ?? 'магазин';
  const имя = args[2] ?? 'город';
  const к = кусок(имя);
  const о = к.объекты.find((o) => o.что === что);
  if (!о) {
    console.log(`в окне сцены «${имя}» нет объекта «${что}»`);
    process.exit(1);
  }
  /**
   * Высота глаз — ОТ ЗЕМЛИ, а не от нуля. «Плато» это не плоскость в нуле:
   * под посёлком там 2.7 м, и камера, поставленная на 1.65 абсолютных,
   * оказывается в грунте. Снимок получился «дом висит в синеве», и я чуть
   * не пошёл искать поломку в домах.
   */
  const земля = new GroundIndex(buildSurface(buildWorld(SCENES[имя], 'plateau'), 'A'));
  const улица = к.улицы[о.улица];
  const вдольX = улица.a.z === улица.b.z;
  const ось = вдольX ? улица.a.z : улица.a.x;
  const отступДома = ЗАСТРОЙКА[имя].отступДома;
  // середина дома: пятно сдвинуто к улице на отступ, остальное участка — двор
  const вглубь = о.участокГлубина / 2 - о.глубина / 2 - отступДома;
  const дx = о.x + о.нx * вглубь;
  const дz = о.z + о.нz * вглубь;
  // фасад — передняя плоскость дома
  const фx = дx + о.нx * (о.глубина / 2);
  const фz = дz + о.нz * (о.глубина / 2);
  /**
   * Встаём на ТРОТУАР, а не на проезжую часть: полуширина проезжей части
   * плюс метр. Иначе человек на снимке стоит посреди четырёхполосной
   * магистрали, и это видно.
   */
  const полуширина = улица.полосВСторону * 3.5 + 1.2;
  const доОси = Math.abs((вдольX ? фz : фx) - ось);
  const шаг = доОси - (полуширина + 1.2);
  const кx = фx + о.нx * шаг;
  const кz = фz + о.нz * шаг;
  const высота = о.этажей * (что === 'жильё' ? ДОМ.этаж.жилой : ДОМ.этаж.общественный);
  const подНогами = (x, z) => земля.sample(x, z).height;
  if (args[0] === 'перед') {
    aim.from = `${кx.toFixed(1)},${(подНогами(кx, кz) + ГЛАЗ).toFixed(2)},${кz.toFixed(1)}`;
    aim.at = `${фx.toFixed(1)},${(подНогами(фx, фz) + высота * 0.4).toFixed(2)},${фz.toFixed(1)}`;
  } else {
    /**
     * Вдоль улицы — от её НАЧАЛА, а не «на полсотни метров вбок от дома».
     * Отступ вбок легко уводит камеру за перекрёсток и внутрь соседнего
     * дома: снимок получился двухцветным прямоугольником. Начало улицы
     * всегда на краю плиты, и там заведомо пусто.
     */
    const от = вдольX ? Math.min(улица.a.x, улица.b.x) : Math.min(улица.a.z, улица.b.z);
    const до = вдольX ? Math.max(улица.a.x, улица.b.x) : Math.max(улица.a.z, улица.b.z);
    const поперёк = (вдольX ? кz : кx);
    const сx = вдольX ? от + 10 : поперёк;
    const сz = вдольX ? поперёк : от + 10;
    const цx = вдольX ? до - 10 : поперёк;
    const цz = вдольX ? поперёк : до - 10;
    aim.from = `${сx.toFixed(1)},${(подНогами(сx, сz) + ГЛАЗ).toFixed(2)},${сz.toFixed(1)}`;
    aim.at = `${цx.toFixed(1)},${(подНогами(цx, цz) + 3).toFixed(2)},${цz.toFixed(1)}`;
  }
  aim.fog ??= '300';
  aim.bare ??= '1';
  // прицел готов — дальше работает обычная «наводка»
  all = false;
  view = 'наводка';
  scene = имя;
  terrain = 'plateau';
}

const suffix = aim.variant ? `-${aim.variant}` : '';

const jobs = all
  ? Object.keys(SCENES).map((name) => ({ scene: name, view, terrain, out: `shots/${name}-${view}${suffix}.png` }))
  : [{ scene, view, terrain, out: `shots/${scene ? `${scene}-` : ''}${view}${suffix}.png` }];

mkdirSync('shots', { recursive: true });

/**
 * Шрифты подключаются с чужого хоста и не обязательны: у каждого начертания
 * есть запасное. В контейнере интернета у браузера нет, и падение этих
 * запросов — не ошибка страницы. Всё остальное — ошибка.
 */
const OPTIONAL = /fonts\.(googleapis|gstatic)\.com/;

const server = await createServer({ server: { port: PORT, strictPort: true }, logLevel: 'warn' });
await server.listen();

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1600, height: 900 } });

const problems = [];
page.on('pageerror', (e) => problems.push('ошибка в коде: ' + String(e).split('\n')[0]));
page.on('requestfailed', (r) => {
  if (!OPTIONAL.test(r.url())) problems.push('не загрузилось: ' + r.url());
});

for (const job of jobs) {
  const url = new URL(`http://localhost:${PORT}/`);
  url.searchParams.set('view', job.view);
  url.searchParams.set('terrain', job.terrain);
  if (job.scene) url.searchParams.set('scene', job.scene);
  for (const [k, v] of Object.entries(aim)) url.searchParams.set(k, v);
  try {
    await page.goto(url.href, { waitUntil: 'load' });
    await page.waitForFunction(() => window.__ready === true, null, { timeout: 40000 });
    await page.screenshot({ path: job.out });
    console.log(`снимок: ${job.out}`);
  } catch (e) {
    problems.push(`${job.out}: страница не ожила — ${e.message.split('\n')[0]}`);
  }
}

await browser.close();

if (problems.length > 0) {
  console.log('на странице проблемы:');
  for (const p of problems) console.log('  ✗ ' + p);
}

// vite держит открытые сокеты и сам процесс не заканчивает — выходим принудительно
server.close().catch(() => {});
process.exit(problems.length > 0 ? 1 : 0);
