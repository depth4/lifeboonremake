/**
 * Ветки и main: чтобы работа не терялась между чатами.
 *
 *   node tools/ветки.mjs           — отчёт: что лежит в ветках и не дошло до main
 *                                    (крючок SessionStart — начало каждого чата)
 *   node tools/ветки.mjs догнать   — отправить эту ветку на GitHub и перемотать
 *                                    на неё main (крючок Stop — конец каждого хода)
 *
 * Зачем: с 14 по 22 сентября неделя работы пролежала в ветке, о которой
 * следующий чат не знал, и то же самое построили заново. Новый чат начинается
 * с main, а main двигали руками — «в конце чата влей в main» (решение 039).
 * Правило держалось на памяти, main простоял на 14 сентября десять дней,
 * и каждый новый чат начинал со снимка недельной давности.
 *
 * Теперь main двигает не память, а крючок конца хода. Двигает только ВПЕРЁД:
 * push без --force, и GitHub сам отказывает, если main не лежит внутри ветки.
 * Потерять чужую работу крючок не может даже по ошибке — такое действие ему
 * невыразимо. Если две ветки разошлись (два чата работали одновременно),
 * свести их может только чат с проверками: крючок останавливает ход и говорит
 * «влей origin/main сюда», а отчёт начала чата показывает это следующему.
 */

import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';

const git = (...a) => execFileSync('git', a, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 60000 }).trim();
const сколько = (от, до) => Number(git('rev-list', '--count', `${от}..${до}`));
const есть = (ref) => { try { git('rev-parse', '--verify', '--quiet', ref); return true; } catch { return false; } };

/**
 * Облачный чат получает мелкий клон: без глубины счёт коммитов врёт,
 * а общий предок двух веток может оказаться «за краем» истории.
 */
function скачать() {
  try {
    git('fetch', '--quiet', '--prune', 'origin');
    if (git('rev-parse', '--is-shallow-repository') === 'true') git('fetch', '--quiet', '--unshallow', 'origin');
    return true;
  } catch {
    return false;
  }
}

/** Двигает ли main крючок — видно по тому, стоит ли крючок в настройках самого main. */
function mainДвижетсяСам() {
  try { return git('show', 'origin/main:.claude/settings.json').includes('ветки.mjs догнать'); } catch { return false; }
}

function отчёт() {
  const свежий = скачать();
  const здесь = git('rev-parse', '--abbrev-ref', 'HEAD');
  const все = git('for-each-ref', '--format=%(refname:short)', 'refs/remotes/origin')
    .split('\n').filter((b) => b.startsWith('origin/') && b !== 'origin/HEAD');
  /** gh-pages — сам сайт, archive/* — сложено нарочно: ни то, ни другое в main не идёт. */
  const архив = все.filter((b) => b.startsWith('origin/archive/'));
  const ветки = все.filter((b) => b !== 'origin/main' && b !== 'origin/gh-pages' && !архив.includes(b));

  const строки = [`ВЕТКИ — отчёт начала чата (tools/ветки.mjs). Эта ветка: ${здесь}`];
  if (!свежий) строки.push('  ! git fetch не удался — отчёт по тому, что уже скачано');

  const впереди = сколько('origin/main', 'HEAD'), позади = сколько('HEAD', 'origin/main');
  if (позади > 0) строки.push(`  ! main впереди этой ветки на ${позади} — сначала влей origin/main сюда`);
  if (впереди > 0) строки.push(mainДвижетсяСам()
    ? `  · эта ветка впереди main на ${впереди} — main догонит её в конце хода`
    : `  ! эта ветка впереди main на ${впереди}, а main сам НЕ двигается — работа живёт только в этой ветке`);
  if (впереди === 0 && позади === 0) строки.push('  · эта ветка совпадает с main');

  const нигде = [], толькоЗдесь = [], вМейн = [];
  for (const b of ветки) {
    if (b === `origin/${здесь}`) continue;
    if (сколько('origin/main', b) === 0) { вМейн.push(b.slice(7)); continue; }
    if (архив.some((а) => сколько(а, b) === 0)) continue;
    if (сколько('HEAD', b) === 0) { толькоЗдесь.push(b.slice(7)); continue; }
    нигде.push(b);
  }
  /** Ветка, целиком лежащая внутри другой невлитой, — не отдельная работа: смотреть надо ту. */
  const внутри = (b) => нигде.find((c) => c !== b && сколько(c, b) === 0);
  const описать = (b) => {
    const [дата, заголовок] = git('log', '-1', '--format=%cs%x09%s', b).split('\t');
    const в = внутри(b);
    return в
      ? `    ${b.slice(7)} — целиком входит в ${в.slice(7)}`
      : `    ${b.slice(7)} — ${сколько('origin/main', b)} коммитов, последний ${дата}: «${заголовок}»`;
  };

  if (нигде.length > 0) {
    строки.push(`  ! НЕ ВЛИТО НИ В main, НИ СЮДА — чья-то работа, о которой этот чат не знает:`);
    строки.push(...нигде.map(описать));
    строки.push('    Прежде чем строить своё — посмотреть, что там; не строить то же второй раз.');
  }
  if (толькоЗдесь.length > 0) строки.push(`  · есть в этой ветке, но ещё не в main: ${толькоЗдесь.join(', ')}`);
  if (вМейн.length > 0) строки.push(`  · влиты в main целиком, можно удалить: ${вМейн.join(', ')}`);
  console.log(строки.join('\n'));
}

/**
 * Код выхода 2 — крючок Stop не даёт ходу закончиться и отдаёт Клоду текст
 * из stderr. Только один раз подряд: если Клод уже продолжил из-за крючка
 * (stop_hook_active), второй раз ход не держим — иначе вечный круг, когда
 * свести ветки нельзя (нет сети, конфликт, который решает Алекс).
 */
function догнать() {
  let уже = false;
  if (!process.stdin.isTTY) {
    try { уже = JSON.parse(readFileSync(0, 'utf8') || '{}').stop_hook_active === true; } catch { /* не из крючка */ }
  }
  const стоп = (текст) => {
    if (уже) return;
    process.stderr.write(`ветки.mjs догнать: ${текст}\n`);
    process.exit(2);
  };

  const ветка = git('rev-parse', '--abbrev-ref', 'HEAD');
  if (!ветка.startsWith('claude/')) return;
  if (!скачать()) return стоп('git fetch не удался — main не догнан, работа может жить только в контейнере');

  if (!есть(`origin/${ветка}`) || сколько(`origin/${ветка}`, 'HEAD') > 0) {
    try { git('push', '--quiet', '-u', 'origin', ветка); } catch (e) {
      return стоп(`push ветки ${ветка} не прошёл — ${e.message.split('\n')[0]}`);
    }
  }
  if (сколько('HEAD', 'origin/main') > 0) {
    return стоп(`в main есть ${сколько('HEAD', 'origin/main')} коммитов, которых нет в ${ветка} `
      + '(другой чат работал одновременно). Влей origin/main сюда, прогони проверки и push — '
      + 'main догонит в конце хода. Если слияние спорное по смыслу — это вопрос Алексу.');
  }
  if (сколько('origin/main', 'HEAD') > 0) {
    try { git('push', '--quiet', 'origin', 'HEAD:refs/heads/main'); } catch (e) {
      return стоп(`main не перемотан — ${e.message.split('\n')[0]}`);
    }
  }
}

try {
  if (process.argv[2] === 'догнать') догнать(); else отчёт();
} catch (e) {
  console.log(`ветки: не собралось — ${e.message.split('\n')[0]}`);
}
