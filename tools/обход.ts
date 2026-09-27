/**
 * ОБХОД: Клод сам смотрит город так, как его увидит Алекс, — чтобы видимую
 * нелепость ловила машина, а не Алекс.
 *
 * Зачем. 27.09 Алекс: «ты работаешь виртуально, и каждый раз я запускаю и
 * недоволен. Сделай инструмент, чтобы ты сам посмотрел город, — чтобы не я
 * говорил тебе, что пешеходы на перекрёстке исчезают и светофор торчит из
 * здания». Проверки до этого были про устройство (распорядок, парковка),
 * а не про то, как это выглядит.
 *
 *   node --experimental-strip-types tools/обход.ts               — проверки без браузера
 *   node --experimental-strip-types tools/обход.ts старые-столбы — столбы за тротуаром,
 *                                           как до 27.09: ОБЯЗАН упасть
 *   node --experimental-strip-types tools/обход.ts прыжком — за угол переносом,
 *                                           как до 27.09: ОБЯЗАН упасть
 *   node --experimental-strip-types tools/обход.ts снимки  — ещё и лист снимков с уровня
 *                                           глаз по МАРШРУТУ → shots/обход.png
 *   node --experimental-strip-types tools/обход.ts снимки 2,5 — только эти точки
 *   node --experimental-strip-types tools/обход.ts проявление — в браузере: вид не зависит
 *                                           от того, где раскладывались деревья
 *   node --experimental-strip-types tools/обход.ts проявление ступенями — листва от места
 *                                           раскладки, как до 27.09: ОБЯЗАНА упасть
 *
 * Лист снимков — одни и те же точки и часы при каждом запуске, поэтому
 * «было / стало» видно, положив два листа рядом. Клод смотрит его сам
 * после каждого шага, который меняет картинку.
 *
 * Проверки видимых нелепостей:
 *  1. светофор и знак не внутри дома и не на проезжей части никакой улицы;
  *  2. пешеход не перескакивает: за шаг 0.1 с — не больше полуметра (идёт он
 *     1.35 м/с, то есть 0.14 м за шаг; скачок — это «исчез и появился»).
 */

import { дорогиПосёлка, построитьПосёлок } from '../src/city/plan.ts';
import { buildWorld } from '../src/world/world.ts';
import { buildNetwork, moveTraffic, столбы, уБордюра } from '../src/city/traffic.ts';
import { домНаУчастке } from '../src/city/дом.ts';
import { глубинаКруга, собратьТвердь, следДома } from '../src/city/твердь.ts';
import { вывестиНаУлицу, жить } from '../src/city/жизнь.ts';
import { moveWalkers, walkerPose, заРуку } from '../src/city/walkers.ts';
import { расселить } from '../src/city/житель.ts';

const старыеСтолбы = process.argv[2] === 'старые-столбы';
const прыжком = process.argv[2] === 'прыжком';
const checks: [string, boolean, string][] = [];
const say = (имя: string, ок: boolean, что: string): void => { checks.push([имя, ок, что]); };

/** Радиус столба, м: тот же, что у тверди столбов в `main.ts`. */
const СТОЛБ = 0.07;

/**
 * МАРШРУТ ОБХОДА: где встать, куда смотреть и в котором часу. Точки выбраны
 * там, где Алекс уже находил нелепости или где живёт новое: перекрёсток со
 * светофором, двор со стоянкой, двор с площадкой, утренняя улица, деревья
 * вдаль с края города (растительность), вечерний двор.
 */
const МАРШРУТ: readonly { имя: string; час: number; x: number; z: number; курс: number }[] = [
  // на тротуаре узкой улицы, через перекрёсток на широкую (узел 0, −200)
  { имя: 'перекрёсток со светофором, 8:05', час: 8.08, x: -35, z: -195, курс: -0.14 },
  { имя: 'утренняя улица, 7:52', час: 7.874, x: -2, z: 40, курс: 2.32 },
  { имя: 'двор, стоянка, 3:00', час: 3, x: -141, z: -238.7, курс: 0 },
  { имя: 'двор с площадкой, 16:30', час: 16.5, x: 65.6, z: 58.9, курс: 3.14 },
  // деревья на всех дальностях — та же точка, где меряется проявление
  { имя: 'деревья вдаль, 12:00', час: 12, x: -280, z: 96, курс: 0 },
  { имя: 'вечер у дома, 21:00', час: 21, x: -121, z: -228, курс: 3.14 },
];

for (const [половина, имя] of [[300, 'город'], [600, 'большой город']] as const) {
  const посёлок = построитьПосёлок(20260913, половина, 'город');
  const world = buildWorld(дорогиПосёлка(посёлок), 'plain');
  const net = buildNetwork(world);

  // ── 1. СТОЛБЫ: не в доме и не на проезжей части
  const дома = собратьТвердь(посёлок.объекты.map((о) => следДома(домНаУчастке(о, посёлок.вид, посёлок.сид))));
  const с = столбы(world, net);
  /** Заведомо сломанный вариант: столб за внешним краем тротуара, как до 27.09. */
  const место = (x: { x: number; z: number }, shape: number, s: number, dir: number, запас: number): { x: number; z: number } => {
    if (!старыеСтолбы) return x;
    const п = уБордюра(world, shape, s, dir, 0);
    const сдвиг = world.shapes[shape].outerHalf - world.shapes[shape].halfWidth + запас;
    const наружу = { x: (x.x - п.x), z: (x.z - п.z) };
    const длина = Math.hypot(наружу.x, наружу.z) || 1;
    return { x: п.x + (наружу.x / длина) * сдвиг, z: п.z + (наружу.z / длина) * сдвиг };
  };
  const точки = [
    ...с.светофоры.map((x) => ({ ...место(x, x.approach.shape, x.approach.stopS, x.approach.dir, 0.6), что: 'светофор' })),
    ...net.signs.all.map((sg, i) => ({ ...место(с.знаки[i], sg.shape, sg.s, sg.dir, 0.8), что: `знак ${sg.kind}` })),
  ];
  let вДоме = 0, наДороге = 0;
  const примеры: string[] = [];
  for (const т of точки) {
    const вдом = глубинаКруга(дома, т.x, т.z, СТОЛБ) > 0;
    const близ = world.near(т.x, т.z);
    const надороге = близ !== null && близ.distance < близ.halfWidth;
    if (вдом) вДоме++;
    if (надороге) наДороге++;
    if ((вдом || надороге) && примеры.length < 3) примеры.push(`${т.что} (${т.x.toFixed(1)}, ${т.z.toFixed(1)})${вдом ? ' в доме' : ' на дороге'}`);
  }
  say(`«${имя}»: светофоры и знаки у бордюра — не в доме и не на дороге`, вДоме === 0 && наДороге === 0 && точки.length > 20,
    `столбов ${точки.length}: в доме ${вДоме}, на проезжей части ${наДороге}${примеры.length ? '; например ' + примеры.join(', ') : ''}`);

  // ── 2. ПЕШЕХОДЫ НЕ ПЕРЕСКАКИВАЮТ: 10 минут утренней улицы
  if (имя !== 'город') continue;

  /**
   * Точки самого обхода не в доме: 27.09 первая точка стояла в цоколе, и
   * лист снимков открывался кадром «стена в упор» — нелепость, снятая
   * самим инструментом.
   */
  const вСтене = МАРШРУТ.filter((т) => глубинаКруга(дома, т.x, т.z, 0.3) > 0);
  say('точки обхода не в доме', вСтене.length === 0,
    вСтене.length ? `в доме: ${вСтене.map((т) => т.имя).join(', ')}` : `точек ${МАРШРУТ.length}, в доме 0`);
  const р = расселить(посёлок);
  const улица = вывестиНаУлицу(world, net, р, 8);
  const DT = 0.1;
  const было = new Map<object, { x: number; z: number; shape: number }>();
  const дети = new WeakMap<object, object[]>();
  const ключРебёнка = (w: object, k: number): object => {
    const у = дети.get(w) ?? [];
    дети.set(w, у);
    return (у[k] ??= {});
  };
  let шагов = 0, скачков = 0, наУглу = 0, худший = 0;
  const гдеСкачок: string[] = [];
  for (let к = 1; к * DT <= 600; к++) {
    const время = к * DT, час = 8 + время / 3600;
    moveWalkers(world, net, улица.пешие, DT, время, прыжком ? { угол: 'прыжком' } : {});
    moveTraffic(world, net, улица.машины, DT, время, { час, crossing: [] });
    жить(world, net, р, улица, час);
    for (const w of улица.пешие) {
      if (w.state === 'пришёл') continue;
      /**
       * И сам пешеход, и ребёнок у его руки: скачок любого видно одинаково.
       * Следим за САМИМ пешеходом, а не за номером жителя: дошедший уходит
       * в здание, и для следующего дела выходит новый пешеход у своей точки —
       * это вход и выход, а не скачок (первая редакция считала их скачками).
       */
      const люди = [{ ключ: w as object, п: walkerPose(world, w) },
        ...w.ведёт.map((n, k) => ({ ключ: ключРебёнка(w, k), п: заРуку(world, w, k) }))];
      for (const { ключ, п } of люди) {
        const прежде = было.get(ключ);
        было.set(ключ, { x: п.x, z: п.z, shape: w.shape });
        if (прежде === undefined) continue;
        шагов++;
        const d = Math.hypot(п.x - прежде.x, п.z - прежде.z);
        худший = Math.max(худший, d);
        if (d <= 0.5) continue;
        скачков++;
        if (прежде.shape !== w.shape) наУглу++;
        if (гдеСкачок.length < 3) гдеСкачок.push(`${d.toFixed(1)} м${прежде.shape !== w.shape ? ' на повороте за угол' : ''}`);
      }
    }
  }
  say(`«${имя}»: пешеход не перескакивает (за 0.1 с не больше 0.5 м)`, скачков === 0 && шагов > 1000,
    `за 10 минут шагов ${шагов}, скачков ${скачков} (на повороте за угол ${наУглу}), худший ${худший.toFixed(1)} м`
    + `${гдеСкачок.length ? '; например ' + гдеСкачок.join(', ') : ''}`);
}

console.log(`\nОБХОД — видимые нелепости${старыеСтолбы ? ' [СЛОМАНО: столбы за тротуаром]' : ''}\n`);
let плохо = 0;
for (const [имя, ок, что] of checks) {
  if (!ок) плохо++;
  console.log(`  ${ок ? '✓' : '✗'} ${имя.padEnd(58, '.')} ${что}`);
}
console.log(плохо === 0 ? '\nНЕЛЕПОСТЕЙ НЕ НАЙДЕНО\n' : `\nНАЙДЕНО НЕЛЕПОСТЕЙ: ${плохо}\n`);
process.exitCode = плохо === 0 ? 0 : 1;


/**
 * Где мерить проявление: край города, взгляд внутрь. Выбрано перебором
 * точек и направлений по посадкам: отсюда без заслона домами видно деревьев
 * 9 в 25–70 м, 10 в 70–170 м и 13 в 170–260 м — на всех дальностях, где
 * растительность меняет вид. Главная улица не годится: на ней нет деревьев.
 */
const ПРОЯВЛЕНИЕ = { x: -280, z: 96, курс: 0 };

if (process.argv[2] === 'проявление') {
  const сломать = process.argv[3] === 'ступенями';
  const р = await проявление(сломать);
  const доля = р.сдвиг / р.всего;
  // повтор обязан быть нулём: иначе разница кадров — шум отрисовщика, а не проявление
  const ок = р.повтор === 0 && р.сдвиг === 0 && р.ошибки.length === 0;
  console.log(`\nПРОЯВЛЕНИЕ${сломать ? ' [СЛОМАНО: листва от места раскладки]' : ''}\n`);
  console.log(`  ${ок ? '✓' : '✗'} ${'вид зависит только от того, где глаз'.padEnd(58, '.')} `
    + `тот же кадр повторно: ${р.повтор} точек; после раскладки в 3.9 м позади: ${р.сдвиг} точек из ${р.всего} (${(доля * 100).toFixed(2)}%)`
    + `${р.ошибки.length ? '; ошибки: ' + р.ошибки.join('; ') : ''}`);
  process.exitCode = ок ? 0 : 1;
}

/**
 * `снимки` — весь маршрут; `снимки 1,5` — только эти точки (с единицы).
 * Каждый кадр пишется в `shots/обход/` сразу, как снят: съёмка в контейнере
 * идёт минутами на кадр, и оборвавшаяся на пятом кадре не должна терять
 * четыре снятых. Лист собирается из того, что лежит в папке.
 */
if (process.argv[2] === 'снимки') await листСнимков(process.argv[3]?.split(',').map((n) => Number(n) - 1) ?? МАРШРУТ.map((_, i) => i));

async function листСнимков(какие: readonly number[]): Promise<void> {
  const { createServer } = await import('vite');
  const { chromium } = await import('playwright');
  const { writeFileSync, mkdirSync, existsSync, readFileSync } = await import('node:fs');
  const PORT = 5231;
  const начало = Date.now();
  const лог = (что: string): void => console.log(`  [${((Date.now() - начало) / 1000).toFixed(0).padStart(4)} с] ${что}`);
  const server = await createServer({ server: { port: PORT, strictPort: true, hmr: false }, logLevel: 'error' });
  await server.listen();
  const browser = await chromium.launch();
  mkdirSync('shots/обход', { recursive: true });
  const файл = (i: number): string => `shots/обход/${String(i + 1).padStart(2, '0')}.png`;
  try {
    for (const i of какие) {
      const т = МАРШРУТ[i];
      const page = await browser.newPage({ viewport: { width: 960, height: 540 } });
      const ошибки: string[] = [];
      page.on('pageerror', (e) => ошибки.push(String(e).split('\n')[0]));
      await page.route('**://fonts.googleapis.com/**', (r) => r.abort());
      await page.route('**://fonts.gstatic.com/**', (r) => r.abort());
      const адрес = new URLSearchParams({ scene: 'город', traffic: '1', час: String(т.час), пешком: `${т.x},${т.z},${т.курс}`, bare: '1' });
      лог(`${i + 1}. ${т.имя}: открываю`);
      await page.goto(`http://localhost:${PORT}/?${адрес}`, { waitUntil: 'load', timeout: 300000 });
      await page.waitForFunction(() => (window as unknown as { __ready?: boolean }).__ready === true, null, { timeout: 300000, polling: 1000 });
      лог(`${i + 1}. город собран`);
      await page.waitForFunction(() => ((window as unknown as { __стоимостьКадра?: () => { трава?: { плиток?: number } } })
        .__стоимостьКадра?.().трава?.плиток ?? 0) > 0, null, { timeout: 120000, polling: 1000 }).catch(() => ошибки.push('трава не появилась'));
      await page.evaluate(async () => { for (let k = 0; k < 4; k++) await new Promise((r) => requestAnimationFrame(r)); });
      writeFileSync(файл(i), await page.screenshot({ timeout: 300000 }));
      writeFileSync(файл(i) + '.txt', ошибки.join('; '));
      лог(`${i + 1}. снято${ошибки.length ? ' — ' + ошибки.join('; ') : ''}`);
      await page.close();
    }
    // лист: два столбца, подписи — чтобы смотреть всё одним взглядом
    const кадры = МАРШРУТ.map((т, i) => ({ имя: т.имя, i })).filter(({ i }) => existsSync(файл(i)))
      .map(({ имя, i }) => ({ имя, png: readFileSync(файл(i)).toString('base64'), ошибки: existsSync(файл(i) + '.txt') ? readFileSync(файл(i) + '.txt', 'utf8') : '' }));
    const лист = await browser.newPage({ viewport: { width: 1940, height: 1700 } });
    await лист.setContent(`<body style="margin:0;background:#15171a;font:16px sans-serif;color:#ddd">
      <div style="display:grid;grid-template-columns:960px 960px;gap:10px;padding:5px">
      ${кадры.map((к) => `<figure style="margin:0"><img src="data:image/png;base64,${к.png}" width="960" height="540">
        <figcaption style="padding:4px 2px">${к.имя}${к.ошибки ? ' <b style="color:#f66">' + к.ошибки + '</b>' : ''}</figcaption></figure>`).join('')}
      </div></body>`);
    writeFileSync('shots/обход.png', await лист.screenshot({ fullPage: true }));
    лог('лист снимков: shots/обход.png');
  } finally {
    await browser.close();
    await server.close();
  }
}

/**
 * ПРОЯВЛЕНИЕ: что видно, зависит только от того, где глаз сейчас.
 *
 * 27.09 Алекс: «растительность прорисовывается по мере того, как едешь».
 * Проявление — это когда картинка меняется не потому, что глаз сдвинулся,
 * а потому, что где-то пересчиталось, что рисовать. Поэтому меряется не
 * «как выглядит», а ровно это: один и тот же вид снимается дважды — раз
 * после раскладки деревьев в самом месте глаза, раз после раскладки в 3.9 м
 * позади (глаз дошёл сюда, не вызвав новой). У честной растительности кадры
 * совпадают до точки. Третий кадр — повтор первого: он показывает, что сам
 * отрисовщик повторяем, иначе разница ничего не значила бы.
 */
async function проявление(сломать: boolean): Promise<{ повтор: number; сдвиг: number; всего: number; ошибки: string[] }> {
  const { createServer } = await import('vite');
  const { chromium } = await import('playwright');
  const PORT = 5232;
  const server = await createServer({ server: { port: PORT, strictPort: true, hmr: false }, logLevel: 'error' });
  await server.listen();
  const browser = await chromium.launch();
  try {
    const page = await browser.newPage({ viewport: { width: 640, height: 360 } });
    const ошибки: string[] = [];
    page.on('pageerror', (e) => ошибки.push(String(e).split('\n')[0]));
    await page.route('**://fonts.googleapis.com/**', (r) => r.abort());
    await page.route('**://fonts.gstatic.com/**', (r) => r.abort());
    const адрес = new URLSearchParams({ scene: 'город', bare: '1', трава: 'нет', fog: '6000', ...(сломать ? { редеть: 'ступенями' } : {}) });
    await page.goto(`http://localhost:${PORT}/?${адрес}`, { waitUntil: 'load', timeout: 180000 });
    await page.waitForFunction(() => (window as unknown as { __ready?: boolean }).__ready === true, null, { timeout: 180000 });
    await page.evaluate(() => (window as unknown as { __времяТравы: (t: number) => void }).__времяТравы(0));
    const { x, z, курс } = ПРОЯВЛЕНИЕ;
    const fx = Math.cos(курс), fz = Math.sin(курс);
    /** Глаз на `вперёд` метров вдоль курса от точки; смотрит вдоль улицы. */
    const встать = async (вперёд: number): Promise<void> => {
      await page.evaluate(([ox, oz, ax, az]) => {
        (window as unknown as { __навести: (от: number[], на: number[]) => void }).__навести([ox, 5, oz], [ax, 3, az]);
      }, [x + fx * вперёд, z + fz * вперёд, x + fx * (вперёд + 200), z + fz * (вперёд + 200)]);
      await page.evaluate(async () => { for (let k = 0; k < 3; k++) await new Promise((r) => requestAnimationFrame(r)); });
    };
    const снять = async (): Promise<Buffer> => page.screenshot({ timeout: 300000 });
    await встать(20); await встать(0);
    const здесь = await снять();
    await встать(20); await встать(0);
    const здесьСнова = await снять();
    await встать(20); await встать(-3.9); await встать(0);
    const сзади = await снять();
    // кадры — на диск: зелёная цифра по пустому кадру ничего не значит, его надо видеть
    const { writeFileSync, mkdirSync } = await import('node:fs');
    mkdirSync('shots', { recursive: true });
    writeFileSync(`shots/проявление${сломать ? '-ступенями' : ''}-здесь.png`, здесь);
    writeFileSync(`shots/проявление${сломать ? '-ступенями' : ''}-сзади.png`, сзади);
    const разница = await page.evaluate(async ([a, b, c]) => {
      const пиксели = async (png: string): Promise<Uint8ClampedArray> => {
        const img = new Image();
        img.src = `data:image/png;base64,${png}`;
        await img.decode();
        const cv = document.createElement('canvas');
        cv.width = img.width; cv.height = img.height;
        const cx = cv.getContext('2d')!;
        cx.drawImage(img, 0, 0);
        return cx.getImageData(0, 0, img.width, img.height).data;
      };
      const [pa, pb, pc] = await Promise.all([a, b, c].map(пиксели));
      const счёт = (p: Uint8ClampedArray, q: Uint8ClampedArray): number => {
        let n = 0;
        for (let i = 0; i < p.length; i += 4)
          if (Math.max(Math.abs(p[i] - q[i]), Math.abs(p[i + 1] - q[i + 1]), Math.abs(p[i + 2] - q[i + 2])) > 8) n++;
        return n;
      };
      return { повтор: счёт(pa, pb), сдвиг: счёт(pa, pc), всего: pa.length / 4 };
    }, [здесь, здесьСнова, сзади].map((b) => b.toString('base64')));
    return { ...разница, ошибки };
  } finally {
    await browser.close();
    await server.close();
  }
}
