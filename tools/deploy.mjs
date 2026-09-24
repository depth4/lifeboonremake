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
 * Запуск: npm run deploy (мир собирает сам; страницу сравнения — `npm run page`)
 */

import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { chromium } from 'playwright';

const BRANCH = 'gh-pages';
const FILES = [
  ['build/pages/index.html', 'index.html'],
  ['build/pages/report.html', 'report.html'],
];

const git = (...args) => execFileSync('git', args, { encoding: 'utf8' }).trim();

/**
 * МИР СОБИРАЕТСЯ ЗДЕСЬ, а не берётся готовым с диска.
 *
 * 24.09 выкладка взяла `build/pages/index.html`, собранный накануне из 56b5311,
 * и выложила его с подписью «из e2944fe». Собрать и выложить были двумя
 * командами, и вторая верила тому, что лежит на диске: сборку забыли —
 * на сайт уехал вчерашний мир, а подпись соврала. Алекс открыл сайт и не
 * увидел ничего нового. Теперь выложить можно только то, что собрано
 * этой же командой из этого же коммита.
 *
 * Незакоммиченные правки попали бы в сборку, а подпись назвала бы коммит,
 * в котором их нет. Поэтому с ними выкладка отказывает.
 */
const грязь = git('status', '--porcelain');
if (грязь !== '') {
  console.log('НЕ ВЫЛОЖЕНО: есть незакоммиченные правки — сборка подписалась бы чужим номером.');
  console.log(грязь.split('\n').slice(0, 5).map((с) => '  ' + с).join('\n'));
  process.exit(1);
}
execFileSync('node', ['tools/site.mjs'], { stdio: 'inherit' });

for (const [from] of FILES) {
  if (!existsSync(from)) {
    console.log(`нет файла ${from} — сначала npm run page`);
    process.exit(1);
  }
}

/** Открыть собранный файл и проехать в нём. Бросает, если что-то не так. */
async function itDrives(path) {
  const browser = await chromium.launch();
  const page = await browser.newPage({ viewport: { width: 1280, height: 720 } });
  const errors = [];
  page.on('pageerror', (e) => errors.push(String(e).split('\n')[0]));
  page.on('console', (m) => {
    if (m.type() === 'error' && /WebGLProgram|Shader Error/.test(m.text())) errors.push('шейдер не собрался: ' + m.text().split('\n')[0]);
  });
  try {
    /**
     * Сначала страница как её увидит человек — с травой: шейдер собрался,
     * травинки растут. Трава, которая не собралась, не бросает исключения,
     * а просто не рисуется — такое нельзя выложить (23.09).
     */
    await page.goto('file://' + process.cwd() + '/' + path + '?scene=город&view=двор', { timeout: 120000 });
    await page.waitForFunction(() => window.__ready === true, null, { timeout: 120000 });
    await page.waitForFunction(() => (window.__стоимостьКадра?.().трава?.живых ?? 0) > 1000
      && (window.__стоимостьКадра?.().деревья?.листьев ?? 0) > 1000, null, { timeout: 120000 });
    if (errors.length > 0) throw new Error(errors.join('; '));
    const { трава, деревья } = await page.evaluate(() => window.__стоимостьКадра());
    console.log(`проверено в собранном файле: трава растёт — ${трава.живых} травинок в кадре; `
      + `деревьев ${деревья.деревьев}, листьев ${деревья.листьев}`);
    /**
     * Потом машина — без травы и листвы: разгон меряет физику, а кадр с ними на
     * программном отрисовщике длится секунды, и 60 км/ч не успели бы
     * набраться за время ожидания. Мир от травы не меняется (решение 093).
     */
    await page.goto('file://' + process.cwd() + '/' + path + '?трава=нет&листва=нет');
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
  console.log('НЕ ВЫЛОЖЕНО: в собранном файле не выросла трава или не поехала машина.');
  console.log('  ' + String(error instanceof Error ? error.message : error).split('\n')[0]);
  console.log('  Сайт остался прежним. Чинить, потом выкладывать снова.');
  process.exit(1);
}

// .nojekyll выключает сборщик блогов, который GitHub иначе прогоняет по файлам
const empty = execFileSync('git', ['hash-object', '-w', '--stdin'], { input: '', encoding: 'utf8' }).trim();
const entries = [`100644 blob ${empty}\t.nojekyll`];
for (const [from, to] of FILES) entries.push(`100644 blob ${git('hash-object', '-w', from)}\t${to}`);

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
