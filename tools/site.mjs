/**
 * Собирает мир в ОДИН файл, который открывается по ссылке и работает целиком:
 * можно крутить камеру, переключать сцены и рельеф, строить дороги.
 *
 * Зачем отдельно от `npm run page`: та страница — отчёт с картинками,
 * а эта — сам мир, живой.
 *
 * Главное здесь — отметка сборки. Она ставится автоматически из даты и номера
 * последнего изменения, поэтому соврать не может. Рядом список того, что в этой
 * сборке нового — чтобы на вопрос «я открыл свежую версию или старую?»
 * отвечала сама страница, а не память.
 *
 * Запуск: npm run site
 */

import { build } from 'vite';
import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync, rmSync } from 'node:fs';

const OUT = 'build/мир.html';
const DIST = 'build/dist';

const git = (...args) => execFileSync('git', args, { encoding: 'utf8' }).trim();

const commit = git('rev-parse', '--short', 'HEAD');
const when = new Date().toLocaleString('ru-RU', {
  day: 'numeric', month: 'long', hour: '2-digit', minute: '2-digit',
});
const stamp = `сборка ${when} · ${commit}`;

// Что нового — берём заголовки последних изменений. Не переписываем руками:
// переписанное однажды разойдётся с тем, что внутри.
const changes = git('log', '-6', '--pretty=%s')
  .split('\n')
  .map((line) => line.trim())
  .filter(Boolean)
  .join('\n');

await build({
  root: '.',
  base: './',
  logLevel: 'warn',
  define: {
    'import.meta.env.VITE_BUILD': JSON.stringify(stamp),
    'import.meta.env.VITE_CHANGES': JSON.stringify(changes),
  },
  build: {
    outDir: DIST,
    emptyOutDir: true,
    target: 'es2020',
    assetsInlineLimit: 1024 * 1024,
    rollupOptions: { output: { inlineDynamicImports: true } },
  },
});

let html = readFileSync(`${DIST}/index.html`, 'utf8');

/** Всё внутрь одного файла: чужих файлов рядом с ним не будет. */
const inline = (pattern, wrap) => {
  html = html.replace(pattern, (_whole, href) => {
    const text = readFileSync(`${DIST}/${href.replace(/^\.\//, '')}`, 'utf8');
    // строка «конец скрипта» внутри кода оборвала бы страницу на полуслове
    return wrap(text.replace(/<\/script/gi, '<\\/script'));
  });
};
inline(/<script type="module"[^>]*src="([^"]+)"[^>]*><\/script>/g, (js) => `<script type="module">\n${js}\n</script>`);
inline(/<link rel="stylesheet"[^>]*href="(\.\/assets[^"]+)"[^>]*>/g, (css) => `<style>\n${css}\n</style>`);

// Артефакт сам оборачивает страницу в скелет, поэтому отдаём только начинку.
// Указание кодировки оставляем: без него файл, открытый просто с диска,
// покажет кракозябры и обвалится на первой же русской строке в коде.
const head = html.match(/<head>([\s\S]*?)<\/head>/i)?.[1] ?? '';
const body = html.match(/<body>([\s\S]*?)<\/body>/i)?.[1] ?? html;
const page = `${head.trim()}\n${body.trim()}\n`;

writeFileSync(OUT, page);
rmSync(DIST, { recursive: true, force: true });
console.log(`мир одним файлом: ${OUT}, ${(page.length / 1024 / 1024).toFixed(2)} МБ`);
console.log(`отметка: ${stamp}`);
