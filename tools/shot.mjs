/**
 * Снимки экрана из терминала. Никакого монитора не нужно.
 *
 *   npm run shot                       — ракурс «вдоль», сцена по умолчанию
 *   npm run shot -- close крест горы   — ракурс, сцена, рельеф
 *   npm run shot -- all plan           — по снимку на каждую сцену
 *
 * Все снимки одного запуска делаются в одном браузере: так на дюжину сцен
 * уходит несколько секунд, а не минута. Поэтому же снимать умеет не только
 * командная строка: `снять(список)` вывозится наружу, и страница сравнения
 * сама добывает себе недостающие картинки, вместо того чтобы ждать, пока
 * их кто-нибудь сделает руками.
 */

import { createServer } from 'vite';
import { chromium } from 'playwright';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { SCENES } from '../src/scenes.ts';

const PORT = 5199;

/**
 * Шрифты подключаются с чужого хоста и не обязательны: у каждого начертания
 * есть запасное. В контейнере интернета у браузера нет, и падение этих
 * запросов — не ошибка страницы. Всё остальное — ошибка.
 */
const OPTIONAL = /fonts\.(googleapis|gstatic)\.com/;

/**
 * Снять пачку кадров в ОДНОМ браузере и одном сервере.
 *
 * Работа: `{ out, scene, view, terrain, params }`. `params` — всё, что уходит
 * в адрес страницы как есть: наводка камеры, `traffic=1`, `bare=1`, вариант.
 *
 * Возвращает список бед. Пустой список — всё снято.
 */
export async function снять(работы, { тихо = false } = {}) {
  if (работы.length === 0) return [];
  const server = await createServer({ server: { port: PORT, strictPort: true }, logLevel: 'warn' });
  await server.listen();

  const browser = await chromium.launch();
  const page = await browser.newPage({ viewport: { width: 1600, height: 900 } });

  const беды = [];
  page.on('pageerror', (e) => беды.push('ошибка в коде: ' + String(e).split('\n')[0]));
  page.on('requestfailed', (r) => {
    if (!OPTIONAL.test(r.url())) беды.push('не загрузилось: ' + r.url());
  });

  for (const job of работы) {
    const url = new URL(`http://localhost:${PORT}/`);
    url.searchParams.set('view', job.view);
    url.searchParams.set('terrain', job.terrain);
    if (job.scene) url.searchParams.set('scene', job.scene);
    for (const [k, v] of Object.entries(job.params ?? {})) url.searchParams.set(k, v);
    mkdirSync(dirname(job.out), { recursive: true });
    try {
      await page.goto(url.href, { waitUntil: 'load' });
      await page.waitForFunction(() => window.__ready === true, null, { timeout: 40000 });
      /**
       * Страница отвечает, ЧТО она показала, и это сверяется с заказом.
       * Списки имён сюда не переписываются: подмену ловит сама страница,
       * а значит ловятся все подмены разом — сцены, рельефа, варианта
       * и ракурса. 17.09 именно так нашлось, что `холмы` снимают ПЛАТО.
       */
      /**
       * Страница сама признаётся, если чего-то в адресе не поняла и взяла
       * своё. Сверять здесь имена нельзя — это был бы второй список имён
       * рядом с настоящим, и он бы с ним разошёлся. Здесь только отказ
       * работать с подменой: снимок не той земли выглядит как доказательство.
       */
      const показано = await page.evaluate(() => window.__чтоПоказано?.() ?? null);
      if (показано === null || показано.подмены === undefined) {
        беды.push(`${job.out}: страница не отвечает, что показала`);
        continue;
      }
      if (показано.подмены.length > 0) {
        беды.push(`${job.out}: снято не то, что заказано — ${показано.подмены.join('; ')}`);
        continue;
      }
      await page.screenshot({ path: job.out });
      if (!тихо) console.log(`снимок: ${job.out}`);
    } catch (e) {
      беды.push(`${job.out}: страница не ожила — ${e.message.split('\n')[0]}`);
    }
  }

  await browser.close();
  // vite держит открытые сокеты и сам процесс не заканчивает
  server.close().catch(() => {});
  return беды;
}

/** Запущен ли этот файл сам, а не ввезён кем-то. */
const сам = process.argv[1] && import.meta.url.endsWith(process.argv[1].split('/').pop());

if (сам) {
  const args = process.argv.slice(2);
  const all = args[0] === 'all';
  const view = (all ? args[1] : args[0]) ?? 'road';
  const terrain = args[2] ?? 'plateau';
  const scene = all ? null : args[1];

  // наводка: npm run shot -- наводка крест холмы from=x,y,z at=x,y,z
  const params = Object.fromEntries(args.filter((a) => a.includes('=')).map((a) => a.split('=')));
  const suffix = params.variant ? `-${params.variant}` : '';

  const работы = all
    ? Object.keys(SCENES).map((name) => ({
      scene: name, view, terrain, params, out: `shots/${name}-${view}${suffix}.png`,
    }))
    : [{
      scene, view, terrain, params,
      out: `shots/${scene ? `${scene}-` : ''}${view}${suffix}.png`,
    }];

  const беды = await снять(работы);
  if (беды.length > 0) {
    console.log('на странице проблемы:');
    for (const p of беды) console.log('  ✗ ' + p);
  }
  process.exit(беды.length > 0 ? 1 : 0);
}
