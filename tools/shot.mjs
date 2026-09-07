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
import { SCENES } from '../src/scenes.ts';

const PORT = 5199;
const args = process.argv.slice(2);
const all = args[0] === 'all';
const view = (all ? args[1] : args[0]) ?? 'road';
const terrain = (all ? args[2] : args[2]) ?? 'plateau';
const scene = all ? null : args[1];

// наводка: npm run shot -- наводка крест холмы from=x,y,z at=x,y,z
const aim = Object.fromEntries(
  args.filter((a) => a.includes('=')).map((a) => a.split('=')),
);

const jobs = all
  ? Object.keys(SCENES).map((name) => ({ scene: name, view, terrain, out: `shots/${name}-${view}.png` }))
  : [{ scene, view, terrain, out: `shots/${scene ? `${scene}-` : ''}${view}.png` }];

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
