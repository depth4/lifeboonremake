/**
 * Проверка инструмента строительства настоящими кликами.
 *
 * Тут нужна не картинка, а ответ на вопрос: если игрок ведёт дорогу так,
 * как ему вздумается, — инструмент помогает или отказывает? Ответ читается
 * со страницы: число перекрёстков и строка подсказки.
 *
 * Главное, что здесь проверяется: ОТКАЗОВ НЕТ НИ В ОДНОМ СЛУЧАЕ.
 * Отказ — это перекладывание работы на игрока.
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

const facts = async () => page.evaluate(() => {
  const hint = document.getElementById('hint');
  const junctions = document.getElementById('facts')?.textContent?.match(/перекрёстков\s+(\d+)/);
  const roads = document.getElementById('road-name')?.textContent?.match(/дорог:\s*(\d+)/);
  const ms = document.getElementById('facts')?.textContent?.match(/пересборка\s+(\d+)/);
  return {
    hint: hint?.textContent ?? '',
    refused: hint?.classList.contains('refused') ?? false,
    snapped: hint?.classList.contains('snapped') ?? false,
    junctions: junctions ? Number(junctions[1]) : -1,
    roads: roads ? Number(roads[1]) : -1,
    ms: ms ? Number(ms[1]) : -1,
  };
});

const screenOf = (x, z) => page.evaluate(([x, z]) => window.__project(x, z), [x, z]);

/** Провести дорогу по точкам мира. Возвращает, был ли отказ и где привязалось. */
async function draw(points, { drag = false } = {}) {
  const snaps = [];
  let refused = false;
  for (const [i, p] of points.entries()) {
    const at = await screenOf(p.x, p.z);
    await page.mouse.move(at.x, at.y);
    await page.waitForTimeout(50);
    const before = await facts();
    if (before.snapped) snaps.push(before.hint.replace('привязка к ', '').replace(' — клик соединит', ''));
    if (drag && i > 0 && i < points.length - 1) {
      await page.mouse.down();
      await page.mouse.move(at.x + 34, at.y - 26, { steps: 4 });
      await page.mouse.up();
    } else {
      await page.mouse.click(at.x, at.y);
    }
    await page.waitForTimeout(50);
  }
  await page.keyboard.press('Escape');
  await page.waitForTimeout(80);
  await page.mouse.move(880, 470);
  await page.waitForTimeout(50);
  await page.mouse.click(880, 470);
  await page.waitForTimeout(250);
  const after = await facts();
  refused = after.refused;
  return { snaps, refused, ...after };
}

const CASES = [
  {
    name: 'вести дорогу в бок существующей',
    scene: 'крест',
    path: [{ x: -70, z: -80 }, { x: -40, z: -55 }, { x: -8, z: -34 }, { x: -2, z: -8 }],
  },
  {
    name: 'вести дорогу прямо в перекрёсток',
    scene: 'крест',
    path: [{ x: 78, z: -78 }, { x: 40, z: -40 }, { x: 4, z: -4 }],
  },
  {
    name: 'подойти под очень острым углом',
    scene: 'крест',
    path: [{ x: -104, z: 26 }, { x: -40, z: 12 }, { x: -6, z: 3 }],
  },
  {
    name: 'пересечь сразу две дороги',
    scene: 'решётка',
    path: [{ x: -100, z: -100 }, { x: -20, z: -20 }, { x: 60, z: 60 }, { x: 104, z: 104 }],
  },
  {
    name: 'изогнутая дорога рядом с существующей',
    scene: 'впритык',
    path: [{ x: -90, z: 60 }, { x: -30, z: 40 }, { x: 30, z: 46 }, { x: 90, z: 62 }],
    drag: true,
  },
  {
    name: 'дорога поверх другой, почти вдоль неё',
    scene: 'крест',
    path: [{ x: -100, z: 4 }, { x: -20, z: -2 }, { x: 60, z: 2 }],
  },
];

let bad = 0;
console.log('инструмент строительства: настоящие клики мышью\n');

for (const c of CASES) {
  await page.goto(`http://localhost:${PORT}/?view=plan&scene=${encodeURIComponent(c.scene)}&terrain=plateau`, { waitUntil: 'load' });
  await page.waitForFunction(() => window.__ready === true, null, { timeout: 40000 });
  const before = await facts();
  await page.click('button[data-tool="road"]');

  const r = await draw(c.path, { drag: c.drag ?? false });
  const built = r.roads > before.roads;
  const ok = !r.refused && built;
  if (!ok) bad++;
  console.log(
    `${ok ? '✓' : '✗'} ${c.name.padEnd(42)} ` +
    `дорог ${before.roads}→${r.roads}, перекрёстков ${before.junctions}→${r.junctions}, ` +
    `${r.ms} мс${r.snaps.length ? `, привязка: ${[...new Set(r.snaps)].join(', ')}` : ''}` +
    `${r.refused ? '  ОТКАЗ: ' + r.hint : ''}${built ? '' : '  дорога не построилась'}`,
  );
  if (c.name.startsWith('вести дорогу в бок')) await page.screenshot({ path: 'shots/построено.png' });
}

await browser.close();
if (errors.length) {
  console.log('\nошибки на странице:');
  for (const e of errors) console.log('  ✗ ' + e);
}
console.log(bad === 0 && errors.length === 0
  ? '\n✓ ни одного отказа: инструмент принял всё, что нарисовали'
  : `\n${bad} случаев не прошло`);

server.close().catch(() => {});
process.exit(bad > 0 || errors.length > 0 ? 1 : 0);
