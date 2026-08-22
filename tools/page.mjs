/**
 * Собирает проект в одну самодостаточную страницу — её можно открыть по ссылке
 * без установки чего-либо. Внутри та же самая сборка, что и в разработке:
 * второго источника правды не заводим.
 *
 * Запуск: npm run page   ->  build/page.html
 */

import { build } from 'vite';
import { mkdirSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';

const TMP = 'build/.vite';
const OUT = 'build/page.html';

rmSync('build', { recursive: true, force: true });
mkdirSync('build', { recursive: true });

await build({ logLevel: 'warn', build: { outDir: TMP, emptyOutDir: true, assetsInlineLimit: 0 } });

const html = readFileSync(join(TMP, 'index.html'), 'utf8');

const script = html.match(/<script[^>]*src="([^"]+)"[^>]*><\/script>/);
if (!script) throw new Error('в собранной странице нет скрипта — сборка сломалась');
const bundle = readFileSync(join(TMP, script[1].replace(/^\//, '')), 'utf8');

// страница для артефакта отдаётся без обёрток <html>/<head>/<body> — их добавляет сам артефакт
const head = html.slice(html.indexOf('<head>') + 6, html.indexOf('</head>'));
const body = html.slice(html.indexOf('<body>') + 6, html.indexOf('</body>'));

const strip = (part) =>
  part
    .replace(/<script[^>]*\ssrc="[^"]*"[^>]*><\/script>/g, '')
    .replace(/<link[^>]*rel="modulepreload"[^>]*>/g, '')
    .replace(/<meta charset[^>]*>/g, '')
    .trim();

const page = [
  strip(head),
  strip(body),
  '<script type="module">',
  bundle,
  '</script>',
].join('\n');

writeFileSync(OUT, page);
rmSync(TMP, { recursive: true, force: true });
console.log(`страница: ${OUT} (${(page.length / 1024).toFixed(0)} КБ)`);
