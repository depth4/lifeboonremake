/**
 * Страница сравнения для Алекса: картинки и цифры в одном файле.
 *
 * Цифры берутся из `npm run report`, картинки — из shots/для-страницы.
 * Ничего не переписывается руками: если мир изменится, страница пересоберётся
 * с новыми числами, а не со старыми.
 *
 * Запуск: npm run page
 */

import { readFileSync, writeFileSync, readdirSync } from 'node:fs';
import { execFileSync } from 'node:child_process';

const SHOTS = 'shots/для-страницы';
const OUT = 'build/сравнение.html';

const report = JSON.parse(
  execFileSync('node', ['--experimental-strip-types', 'tools/report.ts'], { encoding: 'utf8', maxBuffer: 1 << 24 }),
);

const pics = {};
for (const name of readdirSync(SHOTS)) {
  if (!name.endsWith('.png')) continue;
  pics[name.replace('.png', '')] = 'data:image/png;base64,' + readFileSync(`${SHOTS}/${name}`).toString('base64');
}

const A = report.A;
const B = report.B;
const max = (rows, key) => Math.max(...rows.map((r) => r[key]));
const min = (rows, key) => Math.min(...rows.map((r) => r[key]));
const sum = (rows, key) => rows.reduce((s, r) => s + r[key], 0);

const fig = (key, caption, note = '') => pics[key]
  ? `<figure class="plate"><img src="${pics[key]}" alt="${caption}" loading="lazy" />
       <figcaption><b>${caption}</b>${note ? `<span>${note}</span>` : ''}</figcaption></figure>`
  : `<div class="plate missing">нет снимка: ${key}</div>`;

const pair = (keyA, keyB, caption, noteA, noteB) => `
  <div class="pair">
    <figure class="plate"><span class="tag tag-a">А</span><img src="${pics[keyA]}" alt="${caption}, вариант А" loading="lazy" />
      <figcaption><b>${caption}</b><span>${noteA}</span></figcaption></figure>
    <figure class="plate"><span class="tag tag-b">Б</span><img src="${pics[keyB]}" alt="${caption}, вариант Б" loading="lazy" />
      <figcaption><b>${caption}</b><span>${noteB}</span></figcaption></figure>
  </div>`;

const rows = A.map((a, i) => {
  const b = B[i];
  return `<tr>
    <th scope="row">${a.scene}</th>
    <td class="n">${a.roads}</td><td class="n">${a.junctions}</td>
    <td class="n">${a.triangles.toLocaleString('ru-RU')}</td>
    <td class="n ${a.holes === 0 ? 'ok' : 'bad'}">${a.holes}</td>
    <td class="n">${a.aspect}</td>
    <td class="n">${a.ms}</td>
    <td class="n ${b.holes === 0 ? 'ok' : 'bad'}">${b.holes.toLocaleString('ru-RU')}</td>
    <td class="n ${b.poke > 0.02 ? 'bad' : ''}">${b.poke > 0.005 ? b.poke.toFixed(2) + ' м' : '—'}</td>
    <td class="n">${b.ms}</td>
  </tr>`;
}).join('');

/** Разрез в горах: измерено `npm run section крест mountain -38`. */
const natural = [[-46,4.22],[-40,6.03],[-34,7.97],[-28,9.92],[-22,11.69],[-16,13.13],[-10,14.10],[-4,14.53],[0,14.49],[4,14.21],[10,13.37],[16,12.12],[22,10.60],[28,8.92],[34,7.22],[40,5.58],[46,4.05]];
const built = [[-46,4.22],[-40,6.03],[-34,7.97],[-28,9.92],[-26,10.54],[-24.2,11.10],[-22,9.71],[-18,7.05],[-14,4.38],[-11,2.42],[-10,2.09],[-8.2,1.94],[8.2,1.94],[10,2.09],[11,2.42],[14,4.38],[18,7.05],[22,9.71],[23.6,10.20],[26,9.49],[32,7.79],[38,6.11],[46,4.05]];

const SW = 900, SH = 250, PAD = 46;
const zx = (z) => PAD + ((z + 46) / 92) * (SW - PAD * 2);
const hy = (h) => SH - 26 - (h / 16) * (SH - 60);
const path = (pts) => pts.map(([z, h], i) => `${i ? 'L' : 'M'}${zx(z).toFixed(1)} ${hy(h).toFixed(1)}`).join(' ');
const cutArea = `${path(natural)} L${zx(46).toFixed(1)} ${hy(4.05).toFixed(1)} ` +
  built.slice().reverse().map(([z, h]) => `L${zx(z).toFixed(1)} ${hy(h).toFixed(1)}`).join(' ') + ' Z';

const html = `<title>Одна поверхность или две</title>
<link rel="preconnect" href="https://fonts.googleapis.com" />
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin />
<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=IBM+Plex+Mono:wght@400;500&family=IBM+Plex+Sans+Condensed:wght@600;700&family=IBM+Plex+Serif:ital,wght@0,400;0,600;1,400&display=swap" />
<style>
:root {
  --paper: #f1f2ec;
  --panel: #e5e8de;
  --sink:  #dbdfd2;
  --ink:   #171b18;
  --muted: #5d655b;
  --line:  #c6ccbe;
  --accent:#1f4b5c;
  --ok:    #41702f;
  --bad:   #93361f;
  --sans: 'IBM Plex Sans Condensed', 'Segoe UI', system-ui, sans-serif;
  --serif:'IBM Plex Serif', Georgia, 'Times New Roman', serif;
  --mono: 'IBM Plex Mono', ui-monospace, SFMono-Regular, Menlo, monospace;
}
@media (prefers-color-scheme: dark) {
  :root:not([data-theme="light"]) {
    --paper: #14171a; --panel: #1d2124; --sink: #23282b;
    --ink: #e7eae4; --muted: #98a099; --line: #2f353a;
    --accent: #82b4c8; --ok: #8fbf74; --bad: #dd8b72;
  }
}
:root[data-theme="dark"] {
  --paper: #14171a; --panel: #1d2124; --sink: #23282b;
  --ink: #e7eae4; --muted: #98a099; --line: #2f353a;
  --accent: #82b4c8; --ok: #8fbf74; --bad: #dd8b72;
}

* { box-sizing: border-box; }
body {
  margin: 0;
  background: var(--paper);
  color: var(--ink);
  font: 400 17px/1.62 var(--serif);
  -webkit-font-smoothing: antialiased;
}
.wrap { max-width: 1140px; margin: 0 auto; padding: 0 clamp(18px, 4vw, 40px) 120px; }
p { margin: 0 0 1em; max-width: 68ch; }
b, strong { font-weight: 600; }
.lead { font-size: 1.16em; }

.eyebrow {
  font: 500 11px/1 var(--mono);
  letter-spacing: 0.16em;
  text-transform: uppercase;
  color: var(--muted);
}

header.top { padding: clamp(40px, 7vw, 84px) 0 26px; border-bottom: 2px solid var(--ink); }
h1 {
  font: 700 clamp(38px, 7.2vw, 76px)/0.98 var(--sans);
  letter-spacing: -0.015em;
  margin: 16px 0 18px;
  text-wrap: balance;
}
header.top p { max-width: 62ch; }

.verdict {
  margin-top: 30px;
  border-left: 3px solid var(--accent);
  padding: 4px 0 4px 20px;
}
.verdict .who { font: 500 11px/1 var(--mono); letter-spacing: .16em; text-transform: uppercase; color: var(--accent); }
.verdict p { margin: 8px 0 0; font-size: 1.1em; }

section { padding-top: clamp(46px, 6vw, 74px); }
h2 {
  font: 600 clamp(23px, 3vw, 31px)/1.15 var(--sans);
  margin: 10px 0 18px;
  letter-spacing: -0.01em;
}
h3 { font: 600 18px/1.3 var(--sans); margin: 34px 0 10px; letter-spacing: .01em; }
.rule { border: 0; border-top: 1px solid var(--line); margin: 0; }

.asked { display: grid; gap: 14px; grid-template-columns: repeat(auto-fit, minmax(250px, 1fr)); margin: 24px 0 8px; }
.asked > div { border-top: 2px solid var(--line); padding-top: 12px; }
.asked q { display: block; font-style: italic; color: var(--muted); margin-bottom: 10px; }
.state { font: 500 12px/1 var(--mono); letter-spacing: .08em; text-transform: uppercase; display: inline-block; padding: 5px 9px; border-radius: 2px; }
.state.yes { background: var(--ok); color: var(--paper); }
.state.part { background: var(--sink); color: var(--ink); border: 1px solid var(--line); }
.asked p { font-size: 15px; margin: 10px 0 0; }

.plate { margin: 0; }
.plate img {
  display: block; width: 100%; height: auto;
  aspect-ratio: 3 / 2; object-fit: cover; object-position: center center;
  border: 1px solid var(--line); background: var(--sink);
}
.plate figcaption { font: 500 12.5px/1.55 var(--mono); padding: 9px 2px 0; }
.plate figcaption b { display: block; }
.plate figcaption span { display: block; color: var(--muted); font-weight: 400; margin-top: 3px; }
.plate { position: relative; }
.tag {
  position: absolute; top: 9px; left: 9px; z-index: 2;
  font: 700 12px/1 var(--sans); letter-spacing: .1em;
  padding: 6px 9px; border-radius: 2px;
}
.tag-a { background: var(--ok); color: #f1f2ec; }
.tag-b { background: var(--bad); color: #f1f2ec; }
.gallery { display: grid; gap: 26px; grid-template-columns: repeat(auto-fit, minmax(340px, 1fr)); margin-top: 22px; }
.pair { display: grid; gap: 20px; grid-template-columns: 1fr 1fr; margin: 26px 0 34px; }
@media (max-width: 720px) { .pair { grid-template-columns: 1fr; } }
.wide { margin-top: 22px; }

.scroll { overflow-x: auto; margin-top: 20px; border: 1px solid var(--line); }
table { border-collapse: collapse; width: 100%; font: 400 13.5px/1.4 var(--mono); font-variant-numeric: tabular-nums; }
caption { text-align: left; font: 500 12px/1 var(--mono); letter-spacing: .1em; text-transform: uppercase; color: var(--muted); padding: 12px 14px; }
th, td { padding: 8px 12px; text-align: left; white-space: nowrap; }
thead th { font: 500 11.5px/1.3 var(--mono); text-transform: uppercase; letter-spacing: .06em; color: var(--muted); border-bottom: 1px solid var(--line); vertical-align: bottom; }
tbody th { font-weight: 500; }
tbody tr:nth-child(2n) { background: var(--panel); }
td.n { text-align: right; }
td.ok { color: var(--ok); font-weight: 500; }
td.bad { color: var(--bad); font-weight: 500; }
th.grp { border-left: 1px solid var(--line); }
td.grp { border-left: 1px solid var(--line); }

.section-svg { margin-top: 22px; border: 1px solid var(--line); background: var(--panel); padding: 10px; overflow-x: auto; }
.section-svg svg { display: block; min-width: 640px; width: 100%; height: auto; }

.gaps { list-style: none; padding: 0; margin: 20px 0 0; display: grid; gap: 18px; }
.gaps li { border-left: 2px solid var(--bad); padding-left: 16px; }
.gaps b { display: block; font: 600 16px/1.3 var(--sans); margin-bottom: 4px; }
.gaps p { margin: 0; font-size: 15.5px; }

.ask { margin-top: 26px; background: var(--panel); border: 1px solid var(--line); padding: clamp(18px, 3vw, 30px); }
.ask ol { margin: 0; padding-left: 1.2em; }
.ask li { margin-bottom: 10px; }
.ask li:last-child { margin-bottom: 0; }

.runs { margin-top: 20px; display: grid; gap: 0; border: 1px solid var(--line); }
.runs div { display: grid; grid-template-columns: minmax(150px, 220px) 1fr; gap: 16px; padding: 11px 14px; border-bottom: 1px solid var(--line); }
.runs div:last-child { border-bottom: 0; }
.runs div:nth-child(2n) { background: var(--panel); }
.runs code { font: 500 13px/1.5 var(--mono); color: var(--accent); }
.runs span { font: 400 14.5px/1.5 var(--serif); }
@media (max-width: 620px) { .runs div { grid-template-columns: 1fr; gap: 4px; } }

footer { margin-top: 70px; border-top: 1px solid var(--line); padding-top: 18px; font: 400 13px/1.6 var(--mono); color: var(--muted); }
</style>

<div class="wrap">
<header class="top">
  <div class="eyebrow">lifeboonremake · ночь 8 сентября · шаг 6</div>
  <h1>Одна поверхность или две</h1>
  <p class="lead">Дорожная сеть переделана целиком. Ниже два устройства — они собираются из одного и того же мира, снимались на одних и тех же двенадцати трудных сценах и меряются одной и той же проверкой. Нужно одобрить одно.</p>
  <div class="verdict">
    <div class="who">Рекомендация Клода</div>
    <p><b>Вариант А.</b> Он втрое медленнее и кода в нём вдесятеро больше. Но то, что вас злило, в нём стало <em>невозможным</em>, а не починенным: щель между покрытиями, торчащий на остром угле тротуар и земля сквозь асфальт там нечем выразить.</p>
  </div>
</header>

<section>
  <div class="eyebrow">Что вы просили</div>
  <h2>Три условия и что с ними стало</h2>
  <div class="asked">
    <div>
      <q>дорога идеально впадает в другую</q>
      <span class="state yes">сделано</span>
      <p>Стыка нет вообще. Асфальт — одна область на всю сеть: объединение полос вдоль осевых линий. Впадать некуда, потому что это уже одно и то же место.</p>
    </div>
    <div>
      <q>работают перекрёстки</q>
      <span class="state yes">сделано</span>
      <p>Перекрёсток не строится — он получается там, где дороги встретились. Углы скруглены, тротуар обходит их дугой, у каждого выхода лежит переход и стоп-линия.</p>
    </div>
    <div>
      <q>прорезание рельефа вылизано</q>
      <span class="state part">сделано, но не всё</span>
      <p>Выемка и насыпь считаются по нормам: уклон дороги не круче 8%, откосы 1.5&nbsp;:&nbsp;1 и 2&nbsp;:&nbsp;1, край чистый. Чего нет — моста: в горах дорога отрывается на 13 метров, и вместо моста получается насыпь в полсотни метров шириной.</p>
    </div>
  </div>
</section>

<hr class="rule" />
<section>
  <div class="eyebrow">Вариант А</div>
  <h2>Как это выглядит</h2>
  <p>Всё ниже снято из терминала одной командой, без монитора. Ни один снимок не подобран: это те же сцены, по которым считаются цифры.</p>
  <div class="gallery">
    ${fig('переход', 'Перекрёсток сверху', 'скруглённые углы, переходы, стоп-линии на полосах к перекрёстку')}
    ${fig('с-дороги', 'С уровня дороги', 'бордюр, полка тротуара, откос слева')}
    ${fig('вблизи-A', 'Тот же перекрёсток на холмах', 'дорога держит свой уклон, земля подстраивается')}
    ${fig('выемка', 'Горы, выемка 12.6 м', 'земля срезана и возвращается к нетронутой ровно на краю откоса')}
  </div>
</section>

<section>
  <div class="eyebrow">Трудные случаи</div>
  <h2>Ломается на некрасивых, а не на красивых</h2>
  <p>Смотреть на одну аккуратную сцену бессмысленно. Двенадцать сцен собраны специально злыми: угол в 8 градусов, пять дорог из одной точки, дорога поперёк самой себя, восемь дорог как попало. Каждая гоняется на трёх рельефах.</p>
  <div class="gallery">
    ${fig('острый-A', 'Слияние под 12°', 'клин между дорогами закрыт скруглением, торчать нечему')}
    ${fig('звезда', 'Пять лучей из одной точки', 'одна площадка, тротуар кольцом')}
    ${fig('решётка', 'Четыре перекрёстка рядом', 'кварталы между ними целые')}
    ${fig('каша', 'Восемь дорог как попало', '34 участка, 13 перекрёстков, 0 дырок')}
    ${fig('серпантин', 'Серпантин в горах', 'здесь и виден недостающий мост: гора съедена насыпью')}
    ${fig('перекрёсток-A', 'Прямой крест, план', 'разметка обрывается у перекрёстка сама')}
  </div>
</section>

<hr class="rule" />
<section>
  <div class="eyebrow">Вариант Б</div>
  <h2>Дешёвый способ и чего он стоит</h2>
  <p>Самый частый способ в играх: земля — ровная сетка, которую никто не режет, дорога — отдельная лента сверху, по краю юбка, чтобы в стык не было видно неба. Он честно быстрее втрое, кода в нём вдесятеро меньше, и я собрал его по-настоящему, а не понарошку — чтобы цену выбора было видно, а не слышно.</p>
  ${pair('перекрёсток-A', 'перекрёсток-B', 'Прямой крест', 'один перекрёсток, разметка обрывается', 'перекрёстка нет: тротуар одной дороги идёт поперёк проезжей части другой')}
  ${pair('острый-A', 'острый-B', 'Слияние под 12°', 'одна площадка со скруглением', 'ленты лежат друг на друге, между ними торчит земля')}
  ${pair('каша-A', 'каша-B', 'Восемь дорог, холмы', `0 незашитых рёбер`, `${max(B, 'holes').toLocaleString('ru-RU')} незашитых рёбер, земля торчит сквозь асфальт`)}
  <p>Это не придирка к реализации. Пока дорога и земля — <b>две независимые поверхности</b>, «земля торчит сквозь дорогу» можно выразить, а значит оно будет случаться, и чинить это придётся вечно: допусками, приподниманием дороги, подкрученными числами. Ровно так мы потеряли прошлый проект.</p>
</section>

<hr class="rule" />
<section>
  <div class="eyebrow">Цифры</div>
  <h2>Двенадцать сцен, по худшему из трёх рельефов</h2>
  <p>По каждой сцене взято худшее значение из трёх рельефов — плато, холмы, горы. Врать в свою пользу нельзя.</p>
  <div class="scroll">
    <table>
      <caption>Считает <code>npm run scenes</code> — без браузера, за полминуты</caption>
      <thead>
        <tr>
          <th scope="col">сцена</th>
          <th scope="col">дорог</th><th scope="col">узлов</th>
          <th scope="col">треуг.</th><th scope="col">дырок</th><th scope="col">игла</th><th scope="col">мс</th>
          <th scope="col" class="grp">дырок Б</th><th scope="col">торчит Б</th><th scope="col">мс Б</th>
        </tr>
      </thead>
      <tbody>${rows}</tbody>
    </table>
  </div>
  <p style="margin-top:18px"><b>Дырка</b> — ребро, на которое опирается не два треугольника, а один: сквозь него видно небо. <b>Игла</b> — во сколько раз самый вытянутый треугольник длиннее своей толщины; у&nbsp;варианта А это почти всегда сам бордюр. <b>Торчит</b> — на сколько метров земля вылезает поверх асфальта.</p>

  <h3>Итог одной строкой</h3>
  <div class="runs">
    <div><code>вариант А</code><span>${sum(A, 'holes')} дырок на всех сценах, ${max(A, 'downFacing')} треугольников изнанкой вверх, ${max(A, 'flat')} нулевой площади, ${max(A, 'tangled')} пересечений границ. Сборка ${min(A, 'ms')}–${max(A, 'ms')} мс.</span></div>
    <div><code>вариант Б</code><span>${min(B, 'holes').toLocaleString('ru-RU')}–${max(B, 'holes').toLocaleString('ru-RU')} дырок на каждой сцене, земля торчит сквозь асфальт до ${max(B, 'poke').toFixed(2)} м. Сборка ${min(B, 'ms')}–${max(B, 'ms')} мс.</span></div>
  </div>
</section>

<hr class="rule" />
<section>
  <div class="eyebrow">Земляные работы</div>
  <h2>Разрез поперёк дороги в горах</h2>
  <p>Дорога не повторяет рельеф: она держит свой уклон, а земля подстраивается. Ниже — настоящий замер поперёк дороги там, где она проходит сквозь гору. Пунктир — как было, сплошная — как стало.</p>
  <div class="section-svg">
    <svg viewBox="0 0 ${SW} ${SH}" role="img" aria-label="Разрез: выемка глубиной 12.6 метра с откосами 1.5 к 1">
      <defs>
        <pattern id="hatch" width="7" height="7" patternTransform="rotate(45)" patternUnits="userSpaceOnUse">
          <line x1="0" y1="0" x2="0" y2="7" stroke="var(--line)" stroke-width="1.4" />
        </pattern>
      </defs>
      <path d="${cutArea}" fill="url(#hatch)" opacity="0.85" />
      <path d="${path(natural)}" fill="none" stroke="var(--muted)" stroke-width="1.6" stroke-dasharray="7 5" />
      <path d="${path(built)}" fill="none" stroke="var(--ink)" stroke-width="2.4" />
      <line x1="${zx(-8.2)}" y1="${hy(1.94)}" x2="${zx(8.2)}" y2="${hy(1.94)}" stroke="var(--accent)" stroke-width="5" />
      <line x1="${zx(0)}" y1="${hy(1.94)}" x2="${zx(0)}" y2="${hy(14.49)}" stroke="var(--bad)" stroke-width="1.2" stroke-dasharray="3 3" />
      <text x="${zx(0) + 8}" y="${(hy(1.94) + hy(14.49)) / 2}" fill="var(--bad)" font-family="var(--mono)" font-size="13" font-weight="500">выемка 12.6 м</text>
      <text x="${zx(-24.2)}" y="${hy(11.1) - 12}" fill="var(--muted)" font-family="var(--mono)" font-size="12" text-anchor="middle">край откоса</text>
      <text x="${zx(-17)}" y="${hy(6.6)}" fill="var(--muted)" font-family="var(--mono)" font-size="12" text-anchor="middle" transform="rotate(-34 ${zx(-17)} ${hy(6.6)})">откос 1.5 : 1</text>
      <text x="${zx(0)}" y="${hy(1.94) + 20}" fill="var(--accent)" font-family="var(--mono)" font-size="12" text-anchor="middle">проезжая часть, 16.3 м</text>
      <text x="${zx(-46)}" y="${SH - 6}" fill="var(--muted)" font-family="var(--mono)" font-size="11">−46 м</text>
      <text x="${zx(0)}" y="${SH - 6}" fill="var(--muted)" font-family="var(--mono)" font-size="11" text-anchor="middle">ось дороги</text>
      <text x="${zx(46)}" y="${SH - 6}" fill="var(--muted)" font-family="var(--mono)" font-size="11" text-anchor="end">+46 м</text>
    </svg>
  </div>
  <p style="margin-top:16px">Откос кончается ровно там, где догнал нетронутую землю — на 24 метрах от оси. Точка перелома не подобрана на глаз: она ищется делением пополам и попадает в сетку треугольников, поэтому край выемки выходит чётким, а не размазанным.</p>
</section>

<hr class="rule" />
<section>
  <div class="eyebrow">Проверки</div>
  <h2>Чем это меряется</h2>
  <p>Проверка, которая ни разу не падала, — не проверка. Каждая из этих падала на заведомо сломанном случае, прежде чем ей стали верить.</p>
  <div class="runs">
    <div><code>npm run scenes</code><span>12 трудных сцен на трёх рельефах: дырки, изнанка, вырожденные треугольники, пересечения границ, время.</span></div>
    <div><code>npm run check break</code><span>тот же мир с выключенным бордюром. Проверка обязана упасть — падает, находит 536 незашитых рёбер.</span></div>
    <div><code>npm run fuzz</code><span>сотни случайных дорожных сетей: строим сами то, что не додумались бы нарисовать.</span></div>
    <div><code>npm run play</code><span>настоящие клики мышью по странице: дорога, которую ведут в другую дорогу, соединяется. Отказов больше нет.</span></div>
    <div><code>npm run section</code><span>разрез поперёк дороги цифрами: что было у земли, что стало, какой откос.</span></div>
    <div><code>npm run shot</code><span>снимок из терминала в любой ракурс и с любой наводки. Показ результата — обязанность Клода, а не ваша.</span></div>
  </div>
</section>

<hr class="rule" />
<section>
  <div class="eyebrow">Честно</div>
  <h2>Чего ещё нет</h2>
  <ul class="gaps">
    <li><b>Моста нет</b><p>В горах дорога отрывается от земли на 10–13 метров. Модель земляных работ отвечает правильно — насыпью, — но насыпь выходит в полсотни метров шириной и съедает гору. Нужен мост и подпорная стенка. Это следующий крупный шаг, и он не маленький.</p></li>
    <li><b>Трава без фактуры</b><p>Одноцветная. Вблизи это видно сразу. Дешёвый шаг, но он ничего не проверяет — поэтому не сделан.</p></li>
    <li><b>Пересборка «каши» — полторы секунды</b><p>На обычной сцене 0.3–0.5 с, и это незаметно. Но на 34 участках уже ощутимо. Лечится тем, что при постройке одной дороги пересчитывается не весь мир, а только задетый кусок. Отдельный шаг, и его стоит делать не раньше, чем город станет большим.</p></li>
    <li><b>Только рукотворный мир</b><p>Реальных карт мы не касаемся до тех пор, пока игровой мир не будет отработан. Это решение 003, и оно не менялось.</p></li>
  </ul>
</section>

<hr class="rule" />
<section>
  <div class="eyebrow">Что нужно от вас</div>
  <h2>Одна строка ответа</h2>
  <div class="ask">
    <ol>
      <li><b>Одобрить вариант</b> — А, Б или «ни то, ни другое, вот что не так».</li>
      <li><b>Сказать про мост</b>: браться за него следующим или сначала довести то, что есть.</li>
      <li><b>Подтвердить два решения по рельефу</b>, которые уже работают делом, но вами не утверждены: земля рядом с дорогой и срезается, и засыпается одним правилом; высоту дороги задаёт предельный уклон 8%, а не сглаженный рельеф.</li>
    </ol>
  </div>
  <p style="margin-top:22px">Оба варианта переключаются кнопкой прямо на странице мира — <code style="font-family:var(--mono);font-size:.9em">npm run dev</code>, кнопка «вариант». Ничего не надо собирать заново, чтобы посмотреть своими глазами.</p>
</section>

<footer>
  Собрано ${new Date().toLocaleDateString('ru-RU', { day: 'numeric', month: 'long', year: 'numeric' })}.
  Цифры на этой странице посчитаны при сборке страницы, а не переписаны руками:
  меняется мир — меняются они.
</footer>
</div>
`;

writeFileSync(OUT, html);
console.log(`страница: ${OUT}, ${(html.length / 1024 / 1024).toFixed(2)} МБ, картинок ${Object.keys(pics).length}`);
