/** Склейка: собрать мир, посчитать поверхность, показать, повесить кнопки. */

import { DEMO_ROADS } from './demo.ts';
import { buildWorld } from './world/world.ts';
import { buildSurface } from './surface.ts';
import { roadWidth } from './world/road.ts';
import { VIEWS, show } from './render.ts';

const startView = new URLSearchParams(location.search).get('view') ?? 'road';

const world = buildWorld(DEMO_ROADS);
const surface = buildSurface(world);
const viewer = show(surface, startView);

const road = DEMO_ROADS[0];
const travelLanes = road.type.lanes.filter((lane) => lane.kind === 'travel').length;
const length = world.shapes[0].stations.at(-1)?.s ?? 0;

const name = document.getElementById('road-name');
if (name) name.textContent = road.type.name;

const facts = document.getElementById('facts');
if (facts) {
  const rows: [string, string][] = [
    ['полос', String(travelLanes)],
    ['ширина', `${roadWidth(road.type).toFixed(2)} м`],
    ['длина', `${Math.round(length)} м`],
    ['поверхность', `${surface.stats.triangles.toLocaleString('ru-RU')} треугольников, одна`],
  ];
  facts.innerHTML = rows.map(([k, v]) => `<div>${k} <b>${v}</b></div>`).join('');
}

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

requestAnimationFrame(() => requestAnimationFrame(() => {
  (window as unknown as { __ready?: boolean }).__ready = true;
}));
