/** Склейка: собрать мир, посчитать поверхность, показать, повесить кнопки. */

import type { Road } from './world/road.ts';
import { DEMO_ROADS } from './demo.ts';
import { roadWidth } from './world/road.ts';
import { buildWorld } from './world/world.ts';
import { buildRoadRibbon, buildSurface } from './surface.ts';
import { VIEWS, show } from './render.ts';
import { createBuilder } from './build.ts';

const startView = new URLSearchParams(location.search).get('view') ?? 'road';

const roads: Road[] = [...DEMO_ROADS];

let world = buildWorld(roads);
let surface = buildSurface(world);
let rebuildMs = 0;

const viewer = show(surface, startView);
const canvas = document.querySelector('canvas');

function rebuild(): void {
  const started = performance.now();
  world = buildWorld(roads);
  surface = buildSurface(world);
  rebuildMs = performance.now() - started;
  viewer.setSurface(surface);
  readout();
}

function readout(): void {
  const facts = document.getElementById('facts');
  const name = document.getElementById('road-name');
  const length = world.shapes.reduce((sum, shape) => sum + (shape.stations.at(-1)?.s ?? 0), 0);
  const widest = roads.reduce((w, r) => Math.max(w, roadWidth(r.type)), 0);

  if (name) name.textContent = roads.length === 0 ? 'дорог нет' : `дорог: ${roads.length}`;
  if (facts) {
    const rows: [string, string][] = [
      ['длина', `${Math.round(length)} м`],
      ['полос в сторону', String(builder.lanes())],
      ['ширина', `${widest.toFixed(2)} м`],
      ['треугольников', surface.stats.triangles.toLocaleString('ru-RU')],
      ['пересборка', `${rebuildMs.toFixed(0)} мс`],
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
    viewer.setGhost(road ? buildRoadRibbon(buildWorld([road]).shapes[0]) : null);
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

const HINTS: Record<string, string> = {
  off: 'перетаскивай — поворот    колесо — приближение',
  idle: 'клик по земле — начать дорогу    правая кнопка — поворот камеры',
  drawing: 'клик — участок прямой    зажми и потяни — участок изогнётся    Esc — закончить линию',
  width: 'веди мышь — число полос щёлкает    клик — готово',
};

function hint(): void {
  const node = document.getElementById('hint');
  if (node) node.textContent = HINTS[builder.phase()] ?? HINTS.off;
}

readout();
hint();

requestAnimationFrame(() => requestAnimationFrame(() => {
  (window as unknown as { __ready?: boolean }).__ready = true;
}));
