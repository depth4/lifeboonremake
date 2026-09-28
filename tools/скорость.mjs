/**
 * КУДА УХОДИТ ВРЕМЯ — профиль процессора настоящей страницы игрока.
 *
 * 28.09 Алекс: «пока что всё ещё криво, очень-очень-очень медленно».
 * Прикидывать, что тормозит, бесполезно — меряем. Страница открывается
 * так же, как у игрока (пустой адрес = большой город, за рулём), и
 * профилировщик Chrome снимает два куска:
 *
 *   1. загрузку — от адреса до готового города;
 *   2. десять секунд езды с газом в пол — работу кадра.
 *
 * Печатаются функции, которые съели больше всего времени: «сама» — время
 * в самой функции, «с вложенными» — вместе со всем, что она вызвала.
 * Видеокарту контейнер не меряет (рисует программно), поэтому для неё —
 * косвенные признаки: вызовы отрисовки и треугольники за кадр.
 *
 * Запуск: node tools/скорость.mjs [адрес-параметры]
 *   node tools/скорость.mjs                 — как у игрока
 *   node tools/скорость.mjs "scene=город"   — сцена поменьше
 */

import { createServer } from 'vite';
import { chromium } from 'playwright';
import { writeFileSync, mkdirSync } from 'node:fs';

const ПАРАМЕТРЫ = process.argv[2] ?? '';
const PORT = 5310;

/** Сводка профиля: самые дорогие функции, сама и с вложенными, мс. */
function сводка(profile, сколько = 18) {
  const узлы = new Map(profile.nodes.map((n) => [n.id, n]));
  const родитель = new Map();
  for (const n of profile.nodes) for (const c of n.children ?? []) родитель.set(c, n.id);
  const имя = (n) => {
    const f = n.callFrame;
    const файл = f.url ? f.url.replace(/^.*\/(src|node_modules)\//, '$1/').replace(/\?.*$/, '') : '';
    return `${f.functionName || '(безымянная)'} ${файл}${файл ? ':' + (f.lineNumber + 1) : ''}`;
  };
  const сама = new Map(), всего = new Map();
  let итого = 0;
  profile.samples.forEach((id, i) => {
    const dt = (profile.timeDeltas[i] ?? 0) / 1000;
    итого += dt;
    const n = узлы.get(id);
    const k = имя(n);
    сама.set(k, (сама.get(k) ?? 0) + dt);
    const виденные = new Set();
    for (let u = id; u !== undefined; u = родитель.get(u)) {
      const kk = имя(узлы.get(u));
      if (виденные.has(kk)) continue;
      виденные.add(kk);
      всего.set(kk, (всего.get(kk) ?? 0) + dt);
    }
  });
  const верх = (m) => [...m.entries()].sort((a, b) => b[1] - a[1]).slice(0, сколько);
  return { итого, сама: верх(сама), всего: верх(всего) };
}

const печать = (заголовок, с) => {
  console.log(`\n${заголовок} — всего ${(с.итого / 1000).toFixed(1)} с процессора`);
  console.log('  сама:');
  for (const [k, мс] of с.сама) console.log(`    ${(мс / 1000).toFixed(2).padStart(7)} с  ${(100 * мс / с.итого).toFixed(1).padStart(5)}%  ${k}`);
  console.log('  с вложенными:');
  for (const [k, мс] of с.всего) console.log(`    ${(мс / 1000).toFixed(2).padStart(7)} с  ${(100 * мс / с.итого).toFixed(1).padStart(5)}%  ${k}`);
};

const server = await createServer({ server: { port: PORT, strictPort: true, hmr: false }, logLevel: 'error' });
await server.listen();
const browser = await chromium.launch();
try {
  const page = await browser.newPage({ viewport: { width: 1280, height: 720 } });
  const ошибки = [];
  page.on('pageerror', (e) => ошибки.push(String(e).split('\n')[0]));
  await page.route('**://fonts.googleapis.com/**', (r) => r.abort());
  await page.route('**://fonts.gstatic.com/**', (r) => r.abort());
  const cdp = await page.context().newCDPSession(page);
  await cdp.send('Profiler.enable');
  await cdp.send('Profiler.setSamplingInterval', { interval: 500 });

  // 1. загрузка
  await cdp.send('Profiler.start');
  const t0 = Date.now();
  await page.goto(`http://localhost:${PORT}/${ПАРАМЕТРЫ ? '?' + ПАРАМЕТРЫ : ''}`, { waitUntil: 'commit', timeout: 600000 });
  await page.waitForFunction(() => window.__ready === true, null, { timeout: 900000, polling: 1000 });
  const загрузка = (Date.now() - t0) / 1000;
  const { profile: профильЗагрузки } = await cdp.send('Profiler.stop');

  // 2. езда: газ в пол десять секунд
  await page.evaluate(async () => { for (let k = 0; k < 10; k++) await new Promise((r) => requestAnimationFrame(r)); });
  const вМашине = await page.evaluate(() => window.__car?.() !== null);
  await page.keyboard.down('w');
  await cdp.send('Profiler.start');
  const кадры = await page.evaluate(async () => {
    const t = performance.now(); let n = 0;
    while (performance.now() - t < 10000) { await new Promise((r) => requestAnimationFrame(r)); n++; }
    return { кадров: n, секунд: (performance.now() - t) / 1000 };
  });
  const { profile: профильЕзды } = await cdp.send('Profiler.stop');
  await page.keyboard.up('w');
  const цена = await page.evaluate(() => window.__стоимостьКадра?.());

  const з = сводка(профильЗагрузки), е = сводка(профильЕзды);
  console.log(`\nАДРЕС: /${ПАРАМЕТРЫ ? '?' + ПАРАМЕТРЫ : ''}   ошибки: ${ошибки.length ? ошибки.join('; ') : 'нет'}`);
  console.log(`загрузка до готового города: ${загрузка.toFixed(1)} с (контейнер)`);
  console.log(`езда: ${кадры.кадров} кадров за ${кадры.секунд.toFixed(1)} с = ${(кадры.кадров / кадры.секунд).toFixed(2)} к/с в контейнере (рисует программно); за рулём: ${вМашине}`);
  console.log(`за кадр: вызовов отрисовки ${цена?.вызовов}, треугольников ${цена?.треугольников}`);
  печать('ЗАГРУЗКА', з);
  печать('ЕЗДА, 10 с', е);
  mkdirSync('shots', { recursive: true });
  writeFileSync('shots/скорость.json', JSON.stringify({ адрес: ПАРАМЕТРЫ, загрузка, кадры, цена, ошибки, загрузкаПрофиль: з, ездаПрофиль: е }, null, 1));
} finally {
  await browser.close();
  await server.close();
}
