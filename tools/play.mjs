/**
 * Проверка инструмента строительства настоящими кликами.
 *
 * Тут нужна не картинка, а ответ на вопрос: если игрок ведёт дорогу в другую
 * дорогу — она соединится или инструмент откажет? Ответ читается со страницы:
 * число перекрёстков и строка подсказки.
 *
 * Запуск: npm run play
 */

import { createServer } from 'vite';
import { chromium } from 'playwright';
import { mkdirSync } from 'node:fs';

const PORT = 5199;
mkdirSync('shots', { recursive: true });

const server = await createServer({ server: { port: PORT, strictPort: true }, logLevel: 'warn' });
await server.listen();
const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1600, height: 900 } });
const errors = [];
page.on('pageerror', (e) => errors.push(String(e).split('\n')[0]));

const facts = async () => page.evaluate(() => ({
  name: document.getElementById('road-name')?.textContent ?? '',
  hint: document.getElementById('hint')?.textContent ?? '',
  refused: document.getElementById('hint')?.classList.contains('refused') ?? false,
  snapped: document.getElementById('hint')?.classList.contains('snapped') ?? false,
}));

/** Точка экрана, куда смотрит место (x, z) на земле. */
const screenOf = async (x, z) => page.evaluate(([x, z]) => {
  const w = window;
  return w.__project ? w.__project(x, z) : null;
}, [x, z]);

await page.goto(`http://localhost:${PORT}/?view=plan&scene=крест&terrain=plateau`, { waitUntil: 'load' });
await page.waitForFunction(() => window.__ready === true, null, { timeout: 40000 });

console.log('в начале:', (await facts()).name);

await page.click('button[data-tool="road"]');

/** Ведём дорогу с пустого места ровно в бок существующей. */
const path = [
  { x: -70, z: -80 },
  { x: -40, z: -55 },
  { x: -8, z: -34 },   // почти в горизонтальную дорогу (она по z = 0)
  { x: -2, z: -8 },    // край проезжей части — сюда должна сработать привязка
];

for (const p of path) {
  const at = await screenOf(p.x, p.z);
  if (!at) throw new Error('нет проекции — страница не отдала __project');
  await page.mouse.move(at.x, at.y);
  await page.waitForTimeout(60);
  const f = await facts();
  console.log(`  веду в (${p.x}, ${p.z}): ${f.snapped ? 'ПРИВЯЗКА — ' : ''}${f.hint}`);
  await page.mouse.click(at.x, at.y);
  await page.waitForTimeout(60);
}

await page.keyboard.press('Escape');
await page.waitForTimeout(80);
await page.mouse.move(900, 460);
await page.waitForTimeout(60);
await page.mouse.click(900, 460);
await page.waitForTimeout(200);

const after = await facts();
console.log('после постройки:', after.name);
console.log('подсказка:', after.hint, after.refused ? '  ← ОТКАЗ' : '');
await page.screenshot({ path: 'shots/построено.png' });

await browser.close();
if (errors.length) {
  console.log('ошибки на странице:');
  for (const e of errors) console.log('  ✗ ' + e);
}
server.close().catch(() => {});
process.exit(errors.length > 0 || after.refused ? 1 : 0);
