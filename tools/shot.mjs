/**
 * Снимок экрана из терминала. Никакого монитора не нужно.
 * Запуск: npm run shot [ракурс]   — ракурсы перечислены в src/render.ts
 */

import { createServer } from 'vite';
import { chromium } from 'playwright';
import { mkdirSync } from 'node:fs';

const PORT = 5199;
const view = process.argv[2] ?? 'road';
const out = `shots/${view}.png`;
mkdirSync('shots', { recursive: true });

const server = await createServer({ server: { port: PORT, strictPort: true }, logLevel: 'warn' });
await server.listen();

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1600, height: 900 } });

const problems = [];
page.on('pageerror', (e) => problems.push(String(e)));
page.on('console', (m) => { if (m.type() === 'error') problems.push(m.text()); });

try {
  await page.goto(`http://localhost:${PORT}/?view=${view}`, { waitUntil: 'load' });
  await page.waitForFunction(() => window.__ready === true, null, { timeout: 25000 });
  await page.screenshot({ path: out });
} catch (e) {
  problems.push(e.message.split('\n')[0]);
}

await browser.close();

if (problems.length > 0) {
  console.log('на странице проблемы:');
  for (const p of problems) console.log('  ✗ ' + p);
} else {
  console.log(`снимок: ${out}`);
}

// vite держит открытые сокеты и сам процесс не заканчивает — выходим принудительно
server.close().catch(() => {});
process.exit(problems.length > 0 ? 1 : 0);
