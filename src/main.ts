/** Склейка: собрать мир, посчитать поверхность, показать, повесить кнопки. */

import type { Road } from './world/road.ts';
import { DEFAULT_SCENE, SCENES } from './scenes.ts';
import { roadWidth } from './world/road.ts';
import { MAX_GRADE, buildWorld, snapPoint } from './world/world.ts';
import { DEFAULT_TERRAIN, TERRAINS } from './world/terrain.ts';
import { DEFAULT_VARIANT, VARIANTS, buildGhost, buildSurface } from './surface/index.ts';
import { VIEWS, show, viewFromQuery } from './render.ts';
import { createBuilder } from './build.ts';

const query = new URLSearchParams(location.search);
const startView = query.get('view') ?? 'road';
const startScene = query.get('scene') ?? DEFAULT_SCENE;

/** На каком расстоянии инструмент начинает распознавать намерение, метры. */
const SNAP_RADIUS = 14;

let sceneName = SCENES[startScene] ? startScene : DEFAULT_SCENE;
const roads: Road[] = [...SCENES[sceneName]];
let terrainName = query.get('terrain') ?? DEFAULT_TERRAIN;
if (!TERRAINS[terrainName]) terrainName = DEFAULT_TERRAIN;

let variant = query.get('variant')?.toUpperCase() ?? DEFAULT_VARIANT;
if (!VARIANTS[variant]) variant = DEFAULT_VARIANT;

let world = buildWorld(roads, terrainName);
let surface = buildSurface(world, variant);
let rebuildMs = 0;
let lastGood: Road[] = [...roads];
let refusal = '';

// ?bare=1 — убрать всю обвязку: нужно, когда снимок идёт в сравнение
if (query.get('bare') === '1') {
  document.querySelector('.layer')?.remove();
  document.getElementById('news')?.remove();
}

/**
 * Отметка сборки. Ставится при сборке страницы, а не пишется руками:
 * иначе однажды она соврёт. Нужна ровно для одного вопроса — «я открыл
 * свежую версию или старую из памяти браузера?»
 */
const stamp = (import.meta.env.VITE_BUILD as string | undefined) ?? '';
const changes = ((import.meta.env.VITE_CHANGES as string | undefined) ?? '')
  .split('\n')
  .map((line) => line.trim())
  .filter((line) => line.length > 0);

const buildLine = document.getElementById('build');
if (buildLine && stamp !== '') {
  buildLine.textContent = stamp;
  buildLine.classList.add('fresh');
}

const news = document.getElementById('news');
const newsList = document.getElementById('news-list');
if (news && newsList && changes.length > 0 && query.get('bare') !== '1') {
  newsList.innerHTML = changes.map((line) => `<li>${line}</li>`).join('');
  const when = document.getElementById('news-when');
  if (when) when.textContent = `что нового · ${stamp}`;
  news.classList.add('open');
  document.getElementById('news-close')?.addEventListener('click', () => news.classList.remove('open'));
  // отметку сборки можно нажать, чтобы список вернулся
  buildLine?.addEventListener('click', () => news.classList.toggle('open'));
}

const viewer = show(surface, startView, viewFromQuery(query));
const canvas = document.querySelector('canvas');

/**
 * Пересобрать мир. Если постройка такая, что мир её принять не может,
 * откатываем последнее действие и говорим об этом. Кривой мир на экран
 * не попадает никогда — в этом и смысл отказа.
 */
function rebuild(): void {
  const started = performance.now();
  try {
    const next = buildWorld(roads, terrainName);
    const nextSurface = buildSurface(next, variant);
    world = next;
    surface = nextSurface;
    lastGood = [...roads];
    refusal = '';
  } catch (error) {
    refusal = String(error instanceof Error ? error.message : error).replace(/ \(.*\)$/, '');
    roads.splice(0, roads.length, ...lastGood);
    world = buildWorld(roads, terrainName);
    surface = buildSurface(world, variant);
  }
  rebuildMs = performance.now() - started;
  viewer.setSurface(surface);
  readout();
  hint();
}

function readout(): void {
  const facts = document.getElementById('facts');
  const name = document.getElementById('road-name');
  const length = world.shapes.reduce((sum, shape) => sum + (shape.stations.at(-1)?.s ?? 0), 0);
  const widest = roads.reduce((w, r) => Math.max(w, roadWidth(r.type)), 0);

  if (name) {
    name.textContent = roads.length === 0
      ? 'дорог нет'
      : `дорог: ${roads.length}, перекрёстков: ${world.junctions.length}`;
  }
  if (facts) {
    const rows: [string, string][] = [
      ['длина', `${Math.round(length)} м`],
      ['полос в сторону', String(builder.lanes())],
      ['ширина', `${widest.toFixed(2)} м`],
      ['уклон', `${(world.grade * 100).toFixed(1)}% из ${(MAX_GRADE * 100).toFixed(0)}%`],
      ['отрыв от земли', `${world.lift.toFixed(1)} м${world.lift > 6 ? ' — нужен мост' : ''}`],
      ['перекрёстков', String(world.junctions.length)],
      ['пересборка', `${rebuildMs.toFixed(0)} мс`],
      ['вариант', VARIANTS[variant].label],
    ];
    facts.innerHTML = rows.map(([k, v]) => `<div>${k} <b>${v}</b></div>`).join('');
  }
}

const builder = createBuilder({
  viewer,
  canvas: canvas ?? document.body,
  roads,
  onChanged: rebuild,
  onState: () => {
    hint();
    readout();
  },
  preview: (road) => {
    viewer.setGhost(road ? buildGhost(world, road) : null);
  },
  snap: (point) => {
    const hit = snapPoint(world, point.x, point.z, SNAP_RADIUS);
    return hit ? { point: hit.point, kind: hit.kind } : null;
  },
});

// --- кнопки ракурса ---
const views = document.getElementById('views');
if (views) {
  views.innerHTML = Object.entries(VIEWS)
    .map(([key, v]) => `<button type="button" data-view="${key}" aria-pressed="${key === startView}">${v.label}</button>`)
    .join('');
  views.addEventListener('click', (event) => {
    const button = (event.target as HTMLElement).closest<HTMLButtonElement>('button[data-view]');
    if (!button) return;
    viewer.setView(button.dataset.view ?? 'road');
    views.querySelectorAll('button').forEach((b) => b.setAttribute('aria-pressed', String(b === button)));
  });
}

// --- кнопки строительства ---
let building = false;
const tools = document.getElementById('tools');
if (tools) {
  tools.innerHTML =
    '<button type="button" data-tool="look" aria-pressed="true">смотреть</button>' +
    '<button type="button" data-tool="road" aria-pressed="false">дорога</button>' +
    '<button type="button" class="plain" data-tool="undo">убрать последнюю</button>';

  tools.addEventListener('click', (event) => {
    const button = (event.target as HTMLElement).closest<HTMLButtonElement>('button[data-tool]');
    if (!button) return;
    const tool = button.dataset.tool ?? 'look';

    if (tool === 'undo') {
      builder.undo();
      return;
    }
    building = tool === 'road';
    builder.setActive(building);
    tools.querySelectorAll<HTMLButtonElement>('button[data-tool]').forEach((b) => {
      if (b.dataset.tool !== 'undo') b.setAttribute('aria-pressed', String(b.dataset.tool === tool));
    });
  });
}

// --- кнопки варианта ---
const variants = document.getElementById('variants');
if (variants) {
  variants.innerHTML = Object.entries(VARIANTS)
    .map(([key, v]) => `<button type="button" data-variant="${key}" aria-pressed="${key === variant}" title="${v.label}">${key}</button>`)
    .join('');
  variants.addEventListener('click', (event) => {
    const button = (event.target as HTMLElement).closest<HTMLButtonElement>('button[data-variant]');
    if (!button) return;
    variant = button.dataset.variant ?? DEFAULT_VARIANT;
    lastGood = [...roads];
    rebuild();
    variants.querySelectorAll('button').forEach((b) => b.setAttribute('aria-pressed', String(b === button)));
  });
}

// --- кнопки сцены ---
const scenes = document.getElementById('scenes');
if (scenes) {
  scenes.innerHTML = Object.keys(SCENES)
    .map((key) => `<button type="button" data-scene="${key}" aria-pressed="${key === sceneName}">${key}</button>`)
    .join('');
  scenes.addEventListener('click', (event) => {
    const button = (event.target as HTMLElement).closest<HTMLButtonElement>('button[data-scene]');
    if (!button) return;
    sceneName = button.dataset.scene ?? DEFAULT_SCENE;
    roads.splice(0, roads.length, ...SCENES[sceneName]);
    lastGood = [...roads];
    rebuild();
    scenes.querySelectorAll('button').forEach((b) => b.setAttribute('aria-pressed', String(b === button)));
  });
}

// --- кнопки рельефа ---
const terrains = document.getElementById('terrains');
if (terrains) {
  terrains.innerHTML = Object.entries(TERRAINS)
    .map(([key, t]) => `<button type="button" data-terrain="${key}" aria-pressed="${key === terrainName}">${t.label}</button>`)
    .join('');
  terrains.addEventListener('click', (event) => {
    const button = (event.target as HTMLElement).closest<HTMLButtonElement>('button[data-terrain]');
    if (!button) return;
    terrainName = button.dataset.terrain ?? DEFAULT_TERRAIN;
    lastGood = [...roads];
    rebuild();
    terrains.querySelectorAll('button').forEach((b) => b.setAttribute('aria-pressed', String(b === button)));
  });
}

const HINTS: Record<string, string> = {
  off: 'перетаскивай — поворот    колесо — приближение',
  idle: 'клик по земле — начать дорогу    правая кнопка — поворот камеры',
  drawing: 'клик — участок прямой    зажми и потяни — участок изогнётся    Esc — закончить линию',
  width: 'веди мышь — число полос щёлкает    клик — готово',
};

function hint(): void {
  const node = document.getElementById('hint');
  if (!node) return;
  const snapped = builder.snapped();
  node.textContent = refusal !== ''
    ? refusal
    : snapped !== ''
      ? `привязка к ${snapped === 'узел' ? 'перекрёстку' : snapped === 'торец' ? 'концу дороги' : 'дороге'} — клик соединит`
      : (HINTS[builder.phase()] ?? HINTS.off);
  node.classList.toggle('refused', refusal !== '');
  node.classList.toggle('snapped', refusal === '' && snapped !== '');
}

readout();
hint();

// Где место (x, z) оказывается на экране — нужно проверке кликами:
// она должна попадать мышью в места мира, а не в пиксели наугад.
(window as unknown as { __project?: (x: number, z: number) => { x: number; y: number } }).__project =
  (x, z) => viewer.project(x, z);

requestAnimationFrame(() => requestAnimationFrame(() => {
  (window as unknown as { __ready?: boolean }).__ready = true;
}));
