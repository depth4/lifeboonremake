/**
 * Выкладывает собранные страницы в ветку gh-pages — ту, из которой GitHub
 * делает обычный сайт по адресу depth4.github.io/lifeboonremake.
 *
 * Рабочее дерево при этом не трогается вообще: ветка собирается из готовых
 * файлов напрямую, минуя переключение веток. Поэтому выкладка не может
 * помешать тому, что сейчас в работе.
 *
 * Перед выкладкой собранный файл ПРОВЕРЯЕТСЯ: он открывается по-настоящему,
 * в нём заводится машина, разгоняется и тормозит. Не «не забыть проверить»,
 * а нельзя выложить непроверенное: сломанная сборка сюда просто не пройдёт.
 *
 * Запуск: npm run deploy
 */

import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { chromium } from 'playwright';

const BRANCH = 'gh-pages';
/**
 * Живой мир — ОБЯЗАТЕЛЕН, страница сравнения — нет.
 *
 * Раньше требовались оба, и выкладка не проходила совсем, если не собралась
 * страница сравнения: она берёт картинки из `shots/`, а `shots/` в репозитории
 * не хранится, и в свежем контейнере их просто нет. Получалось, что свежий
 * город нельзя выложить из-за старого отчёта.
 *
 * Правило простое и годится не только здесь: **не собрал — не трогай.**
 * Не собранный файл не удаляется с сайта, а переносится с него как был.
 */
const FILES = [
  ['build/pages/index.html', 'index.html', 'обязателен'],
  ['build/pages/report.html', 'report.html', 'переносится'],
];

const git = (...args) => execFileSync('git', args, { encoding: 'utf8' }).trim();

for (const [from, , как] of FILES) {
  if (как === 'обязателен' && !existsSync(from)) {
    console.log(`нет файла ${from} — сначала npm run site`);
    process.exit(1);
  }
}

/** Открыть собранный файл и проехать в нём. Бросает, если что-то не так. */
async function itDrives(path) {
  const browser = await chromium.launch();
  const page = await browser.newPage({ viewport: { width: 1280, height: 720 } });
  const errors = [];
  page.on('pageerror', (e) => errors.push(String(e).split('\n')[0]));
  try {
    await page.goto('file://' + process.cwd() + '/' + path);
    await page.waitForFunction(() => window.__ready === true, null, { timeout: 60000 });
    await page.click('button[data-drive="seat"]');
    await page.waitForFunction(() => window.__car() !== null, null, { timeout: 15000 });
    await page.keyboard.down('w');
    await page.waitForFunction(() => (window.__car()?.speed ?? 0) * 3.6 > 60, null, { timeout: 40000, polling: 40 });
    const fast = await page.evaluate(() => window.__car());
    await page.keyboard.up('w');
    await page.keyboard.down('s');
    await page.waitForFunction(() => Math.abs(window.__car()?.speed ?? 9) * 3.6 < 1.5, null, { timeout: 40000, polling: 40 });
    await page.keyboard.up('s');
    if (fast.lost) errors.push('колесо теряло опору');
    if (errors.length > 0) throw new Error(errors.join('; '));
    console.log(`проверено в собранном файле: разгон до ${(fast.speed * 3.6).toFixed(0)} км/ч и остановка тормозом`);
  } finally {
    await browser.close();
  }
}

try {
  await itDrives('build/pages/index.html');
} catch (error) {
  console.log('НЕ ВЫЛОЖЕНО: в собранном файле машина не поехала.');
  console.log('  ' + String(error instanceof Error ? error.message : error).split('\n')[0]);
  console.log('  Сайт остался прежним. Чинить, потом выкладывать снова.');
  process.exit(1);
}

// .nojekyll выключает сборщик блогов, который GitHub иначе прогоняет по файлам
const empty = execFileSync('git', ['hash-object', '-w', '--stdin'], { input: '', encoding: 'utf8' }).trim();
const entries = [`100644 blob ${empty}\t.nojekyll`];

/** Что сейчас лежит на сайте: из этого переносится то, что не пересобралось. */
let старое = '';
try {
  git('fetch', 'origin', BRANCH);
  старое = git('ls-tree', 'FETCH_HEAD');
} catch { старое = ''; }

for (const [from, to] of FILES) {
  if (existsSync(from)) {
    entries.push(`100644 blob ${git('hash-object', '-w', from)}\t${to}`);
    continue;
  }
  const строка = старое.split('\n').find((l) => l.endsWith(`\t${to}`));
  if (строка) {
    entries.push(строка);
    console.log(`${to} не пересобран — перенесён с сайта как был`);
  } else {
    console.log(`${to} не пересобран и на сайте его нет — пропускаю`);
  }
}

const tree = execFileSync('git', ['mktree'], { input: entries.join('\n') + '\n', encoding: 'utf8' }).trim();

let parent = null;
try {
  git('fetch', 'origin', BRANCH);
  parent = git('rev-parse', 'FETCH_HEAD');
} catch {
  parent = null;
}

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
