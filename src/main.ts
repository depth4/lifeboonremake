/** Склейка: собрать мир, посчитать поверхность, показать. */

import { DEMO_ROADS } from './demo.ts';
import { buildWorld } from './world/world.ts';
import { buildSurface } from './surface.ts';
import { show } from './render.ts';

const world = buildWorld(DEMO_ROADS);
const surface = buildSurface(world);
show(surface);

const hud = document.getElementById('hud');
if (hud) {
  hud.innerHTML =
    `<b>${DEMO_ROADS[0].type.name}</b> · одна поверхность: ` +
    `${surface.stats.vertices.toLocaleString('ru-RU')} вершин, ` +
    `${surface.stats.triangles.toLocaleString('ru-RU')} треугольников`;
}

requestAnimationFrame(() => requestAnimationFrame(() => {
  (window as unknown as { __ready?: boolean }).__ready = true;
}));
