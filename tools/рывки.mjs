/**
 * Рывки зелени: сколько миллисекунд кадра уходит на траву, деревья и рамы,
 * пока камера едет по городу.
 *
 *   node tools/рывки.mjs          — камера едет по «большому городу» 600 м
 *                                   со скоростью 108 км/ч (0.5 м за кадр)
 *   node tools/рывки.mjs сразу    — поле травы строится в одном кадре,
 *                                   как до 25.09: ОБЯЗАНА упасть
 *
 * Меряется не средний кадр, а САМЫЙ ДОЛГИЙ: рывок — это один длинный кадр
 * среди коротких, в среднем его не видно (Алекс: «60 кадров стабильно, но
 * рывки при ходьбе»). Кадр рисует программный отрисовщик, и его время здесь
 * ничего не значит; меряется только работа зелени на процессоре — та,
 * что на машине Алекса та же самая. Поэтому сам кадр не рисуется (`кадр=нет`).
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
  await page.goto(`http://localhost:${PORT}/?scene=${encodeURIComponent('большой город')}&view=road&bare=1&кадр=нет${сломать ? '&поле=сразу' : ''}`,
    { waitUntil: 'load', timeout: 120000 });
  await page.waitForFunction(() => window.__ready === true, null, { timeout: 180000 });
  /**
   * Сначала встать на старт и дать зелени устроиться: первое поле
   * строится целиком — это загрузка, а не рывок на ходу. Без этого
   * замер ловил прыжок камеры на 230 м в первом кадре маршрута.
   */
  await page.evaluate(async () => {
    window.__навести([-300, 1.7, 12], [-270, 1.5, 12]);
    for (let k = 0; k < 30; k++) await new Promise((r) => requestAnimationFrame(r));
    window.__работаЗелени();
  });
  const работа = await page.evaluate(async () => {
    const все = [];
    // 0.5 м за кадр — 108 км/ч при 60 кадрах: быстрее по городу не ездят
    for (let k = 0; k < 1200; k++) {
      const x = -300 + k * 0.5;
      window.__навести([x, 1.7, 12], [x + 30, 1.5, 12]);
      await new Promise((r) => requestAnimationFrame(r));
      все.push(...window.__работаЗелени());
    }
    return все;
  });
  // по частям: кто именно съел худший кадр
  const части = ['трава', 'деревья', 'рамы'];
  const худшиеЧасти = части.map((ч) => `${ч} ${Math.max(0, ...работа.map((р) => р[ч])).toFixed(1)}`).join(', ');
  const всего = работа.map((р) => р.трава + р.деревья + р.рамы).sort((a, b) => a - b);
  const худший = всего.at(-1) ?? 0;
  const p50 = всего[Math.floor(всего.length / 2)] ?? 0;
  const долгих = всего.filter((t) => t > ПОТОЛОК).length;
  const ок = худший <= ПОТОЛОК && ошибки.length === 0;
  console.log(`\nРЫВКИ ЗЕЛЕНИ${сломать ? ' — ЗАВЕДОМО СЛОМАННО: поле в одном кадре' : ''}\n`);
  console.log(`  ${ок ? '✓' : '✗'} худший кадр зелени не больше ${ПОТОЛОК} мс... ${худший.toFixed(1)} мс; `
    + `середина ${p50.toFixed(1)} мс; кадров дольше потолка ${долгих} из ${всего.length}`);
  console.log(`    худшее по частям, мс: ${худшиеЧасти}`);
  for (const о of ошибки) console.log('  ✗ ' + о);
  console.log(ок ? '\nРЫВКОВ НЕТ\n' : '\nРЫВКИ ЕСТЬ\n');
  process.exitCode = ок ? 0 : 1;
} finally {
  await browser.close();
  await server.close();
}
