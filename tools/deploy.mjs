/**
 * Выкладывает собранные страницы в ветку gh-pages — ту, из которой GitHub
 * делает обычный сайт по адресу depth4.github.io/lifeboonremake.
 *
 * Рабочее дерево при этом не трогается вообще: ветка собирается из готовых
 * файлов напрямую, минуя переключение веток. Поэтому выкладка не может
 * помешать тому, что сейчас в работе.
 *
 * Запуск: npm run deploy
 */

import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';

const BRANCH = 'gh-pages';
const FILES = [
  ['build/pages/index.html', 'index.html'],
  ['build/pages/report.html', 'report.html'],
];

const git = (...args) => execFileSync('git', args, { encoding: 'utf8' }).trim();

/**
 * Живой мир обязателен. Страницу сравнения, если её сейчас не пересобирали,
 * берём ту, что уже выложена: выкладка не должна СТИРАТЬ то, чего она просто
 * не трогала.
 */
if (!existsSync(FILES[0][0])) {
  console.log(`нет файла ${FILES[0][0]} — сначала npm run site`);
  process.exit(1);
}

// .nojekyll выключает сборщик блогов, который GitHub иначе прогоняет по файлам
const empty = execFileSync('git', ['hash-object', '-w', '--stdin'], { input: '', encoding: 'utf8' }).trim();
const entries = [`100644 blob ${empty}\t.nojekyll`];
let carried = null;
try {
  git('fetch', 'origin', BRANCH);
  carried = git('rev-parse', 'FETCH_HEAD');
} catch {
  carried = null;
}
for (const [from, to] of FILES) {
  if (existsSync(from)) {
    entries.push(`100644 blob ${git('hash-object', '-w', from)}\t${to}`);
    continue;
  }
  if (carried === null) continue;
  try {
    entries.push(`100644 blob ${git('rev-parse', `${carried}:${to}`)}\t${to}`);
    console.log(`${to} не пересобирали — оставляю ту, что уже выложена`);
  } catch {
    console.log(`${to} не пересобирали и на сайте её нет — пропускаю`);
  }
}

const tree = execFileSync('git', ['mktree'], { input: entries.join('\n') + '\n', encoding: 'utf8' }).trim();

const parent = carried;

const stamp = new Date().toLocaleString('ru-RU', { day: 'numeric', month: 'long', hour: '2-digit', minute: '2-digit' });
const message = `Сайт: сборка ${stamp} из ${git('rev-parse', '--short', 'HEAD')}`;
const args = ['commit-tree', tree, '-m', message];
if (parent) args.splice(2, 0, '-p', parent);
const commit = execFileSync('git', args, { encoding: 'utf8' }).trim();

git('update-ref', `refs/heads/${BRANCH}`, commit);
execFileSync('git', ['push', 'origin', `${BRANCH}:${BRANCH}`], { encoding: 'utf8', stdio: 'inherit' });

console.log(`выложено в ветку ${BRANCH}: ${message}`);
console.log('  https://depth4.github.io/lifeboonremake/            — живой мир');
console.log('  https://depth4.github.io/lifeboonremake/report.html — сравнение вариантов');
