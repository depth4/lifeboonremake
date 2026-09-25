/**
 * Рывки зелени: сколько миллисекунд кадра уходит на траву, деревья и рамы,
 * пока камера едет по городу.
 *
 *   node tools/рывки.mjs          — камера едет по «большому городу» 600 м
 *   node tools/рывки.mjs сразу    — поле травы строится в одном кадре,
 *                                   как до 25.09: ОБЯЗАНА упасть
 *
 * Меряется не средний кадр, а САМЫЙ ДОЛГИЙ: рывок — это один длинный кадр
 * среди коротких, в среднем его не видно (Алекс: «60 кадров стабильно, но
 * рывки при ходьбе»). Кадр рисует программный отрисовщик, и его время здесь
 * ничего не значит; меряется только работа зелени на процессоре — та,
 * что на машине Алекса та же самая.
 *
 * Потолок: 8 мс. Кадр при 60 в секунду — 16.7 мс, и зелень не вправе съесть
 * из них половину даже в худший кадр.
 */

import { createServer } from 'vite';
import { chromium } from 'playwright';

const PORT = 5207;
const ПОТОЛОК = 8;
const сломать = process.argv[2] === 'сразу';

const server = await createServer({ server: { port: PORT, strictPort: true, hmr: false }, logLevel: 'error' });
await server.listen();
const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 320, height: 180 } });
const ошибки = [];
page.on('pageerror', (e) => ошибки.push(String(e).split('\n')[0]));
try {
  await page.goto(`http://localhost:${PORT}/?scene=${encodeURIComponent('большой город')}&view=road&bare=1${сломать ? '&поле=сразу' : ''}`,
    { waitUntil: 'load', timeout: 120000 });
  await page.waitForFunction(() => window.__ready === true, null, { timeout: 180000 });
  // первое поле строится целиком — это не рывок на ходу, а загрузка
  await page.evaluate(() => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))));
  await page.evaluate(() => window.__работаЗелени());
  const работа = await page.evaluate(async () => {
    const все = [];
    for (let k = 0; k < 200; k++) {
      const x = -300 + k * 3;
      window.__навести([x, 1.7, 12], [x + 30, 1.5, 12]);
      await new Promise((r) => requestAnimationFrame(r));
      все.push(...window.__работаЗелени());
    }
    return все;
  });
  работа.sort((a, b) => a - b);
  const худший = работа.at(-1) ?? 0;
  const p50 = работа[Math.floor(работа.length / 2)] ?? 0;
  const долгих = работа.filter((t) => t > ПОТОЛОК).length;
  const ок = худший <= ПОТОЛОК && ошибки.length === 0;
  console.log(`\nРЫВКИ ЗЕЛЕНИ${сломать ? ' — ЗАВЕДОМО СЛОМАННО: поле в одном кадре' : ''}\n`);
  console.log(`  ${ок ? '✓' : '✗'} худший кадр зелени не больше ${ПОТОЛОК} мс... ${худший.toFixed(1)} мс; `
    + `середина ${p50.toFixed(1)} мс; кадров дольше потолка ${долгих} из ${работа.length}`);
  for (const о of ошибки) console.log('  ✗ ' + о);
  console.log(ок ? '\nРЫВКОВ НЕТ\n' : '\nРЫВКИ ЕСТЬ\n');
  process.exitCode = ок ? 0 : 1;
} finally {
  await browser.close();
  await server.close();
}
