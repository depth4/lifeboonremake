/**
 * Плавность: ровно ли движется картинка от кадра к кадру — за рулём и пешком.
 *
 *   node tools/плавность.mjs          — обязано пройти
 *   node tools/плавность.mjs сломать  — время кадра по часам, поза машины
 *                                       последним шагом физики, как до 25.09:
 *                                       ОБЯЗАНО упасть
 *
 * Зачем. Алекс: «60 кадров стабильно, но рывки при ходьбе и езде». Рывок
 * бывает двух родов. Длинный кадр — его меряет `рывки.mjs`. И ровные кадры,
 * в которых мир сдвинут неровно: кадры идут через 16.7 мс, а машина за них
 * проезжает то 22 см, то 53. Глаз видит это как дрожь, а счётчик кадров — нет.
 *
 * Что меряется. Страница пишет по кадру: когда кадр показан (время кадра
 * у браузера) и где в нём камера и машина. Скорость за кадр — сдвиг,
 * делённый на время между ПОКАЗАМИ. Дрожь кадра — насколько его скорость
 * отличается от средней соседей, в долях скорости. Плавное движение, даже
 * с разгоном и качанием головы, соседям почти равно (разгон за кадр меняет
 * скорость на доли процента); рывок — нет.
 *
 * Потолок: 3% в худшем кадре. Сама картинка не рисуется (`кадр=нет`):
 * меряется не программный отрисовщик контейнера, а то, куда страница ставит
 * мир, — оно на машине Алекса то же самое.
 */

import { createServer } from 'vite';
import { chromium } from 'playwright';

const PORT = 5220;
const ПОТОЛОК = 0.03;
const сломать = process.argv[2] === 'сломать';
const адрес = (доп) => `http://localhost:${PORT}/?scene=${encodeURIComponent('решётка')}&трава=нет&кадр=нет&bare=0`
  + `${сломать ? '&плавно=нет' : ''}${доп}`;

const server = await createServer({ server: { port: PORT, strictPort: true, hmr: false }, logLevel: 'error' });
await server.listen();
const browser = await chromium.launch();
const ошибки = [];

/**
 * Дрожь по следу: для каждого кадра — отличие его скорости от средней
 * соседей, в долях скорости `мерило` (по умолчанию — средней скорости
 * того же, что меряем).
 */
function дрожь(след, где, мерило = null) {
  const v = [];
  for (let i = 1; i < след.length; i++) {
    const dT = (след[i][0] - след[i - 1][0]) / 1000;
    // кадр длиннее 50 мс — это длинный кадр (его меряет рывки.mjs), а не дрожь
    if (dT <= 0 || dT > 0.05) { v.push(null); continue; }
    v.push(где(след[i]).map((x, k) => (x - где(след[i - 1])[k]) / dT));
  }
  const длина = (a) => Math.hypot(...a);
  const годные = v.filter((x) => x !== null);
  const средняя = годные.reduce((s, x) => s + длина(x), 0) / Math.max(1, годные.length);
  const д = [];
  for (let i = 1; i + 1 < v.length; i++) {
    if (!v[i - 1] || !v[i] || !v[i + 1]) continue;
    д.push(длина(v[i].map((x, k) => x - (v[i - 1][k] + v[i + 1][k]) / 2)) / (мерило ?? средняя));
  }
  д.sort((a, b) => a - b);
  return { худшая: д.at(-1) ?? 1, p95: д[Math.floor(д.length * 0.95)] ?? 1, кадров: д.length, скорость: средняя };
}

async function страница(доп) {
  const page = await browser.newPage({ viewport: { width: 1280, height: 720 } });
  page.on('pageerror', (e) => ошибки.push(String(e).split('\n')[0]));
  await page.goto(адрес(доп), { waitUntil: 'load', timeout: 120000 });
  await page.waitForFunction(() => window.__ready === true, null, { timeout: 120000 });
  return page;
}

/** Писать след, пока держим клавиши, — столько кадров. */
async function записать(page, кадров) {
  await page.evaluate(() => window.__следКадров(true));
  await page.evaluate(async (n) => { for (let k = 0; k < n; k++) await new Promise((r) => requestAnimationFrame(r)); }, кадров);
  return page.evaluate(() => window.__следКадров(false));
}

try {
  const строки = [];
  // ── ЗА РУЛЁМ: разогнаться, потом записать 3 секунды на газу
  {
    const page = await страница('&view=close');
    await page.evaluate(() => document.querySelector('button[data-drive="seat"]').click());
    await page.waitForFunction(() => window.__car() !== null);
    await page.keyboard.down('w');
    await page.waitForFunction(() => window.__car().speed > 12, null, { timeout: 60000, polling: 50 });
    const след = await записать(page, 180);
    await page.keyboard.up('w');
    const машина = дрожь(след, (к) => [к[4], к[5], к[6]]);
    строки.push(['машина', машина]);
    строки.push(['камера за машиной', дрожь(след, (к) => [к[1], к[2], к[3]])]);
    /**
     * Машина относительно камеры — то, что видит глаз: камера догоняет
     * машину плавно, и на экране машина чуть ездит. Относительная скорость
     * мала (1–2 м/с), и доля от неё раздувала миллиметр до процентов;
     * мерило — скорость самой машины, как у строк выше.
     */
    строки.push(['машина на экране', дрожь(след, (к) => [к[4] - к[1], к[5] - к[2], к[6] - к[3]], машина.скорость)]);
    await page.close();
  }
  // ── ПЕШКОМ: посреди газона квартала, до бордюра дальше, чем пройдёшь за 3 секунды:
  // шаг на бордюр — подъём глаза, а не дрожь кадра, и мерить его здесь нечего
  {
    const page = await страница('&пешком=-25,0,0');
    await page.keyboard.down('w');
    await page.waitForFunction(() => (window.__walker()?.speed ?? 0) > 1, null, { timeout: 30000, polling: 50 });
    const след = await записать(page, 180);
    await page.keyboard.up('w');
    строки.push(['камера пешком', дрожь(след, (к) => [к[1], к[2], к[3]])]);
    await page.close();
  }

  console.log(`\nПЛАВНОСТЬ${сломать ? ' — ЗАВЕДОМО СЛОМАННО: время по часам, поза последним шагом физики' : ''}\n`);
  let плохо = 0;
  for (const [имя, д] of строки) {
    const ок = д.худшая <= ПОТОЛОК;
    if (!ок) плохо++;
    console.log(`  ${ок ? '✓' : '✗'} ${(имя + ': дрожь в худшем кадре').padEnd(44, '.')} ${(д.худшая * 100).toFixed(1)}%`
      + ` (95% кадров ≤ ${(д.p95 * 100).toFixed(1)}%, кадров ${д.кадров}, скорость ${д.скорость.toFixed(1)} м/с)`);
  }
  for (const о of ошибки) { console.log('  ✗ ' + о); плохо++; }
  console.log(плохо === 0 ? '\nДВИЖЕТСЯ РОВНО\n' : '\nДРОЖИТ\n');
  process.exitCode = плохо === 0 ? 0 : 1;
} finally {
  await browser.close();
  await server.close();
}
