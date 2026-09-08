/**
 * Сводка по всем сценам для страницы сравнения — в JSON.
 * Цифры на странице должны быть посчитанными, а не переписанными руками.
 *
 * Запуск: npm run report > build/report.json
 */

import { SCENES } from '../src/scenes.ts';
import { buildWorld } from '../src/world/world.ts';
import { TERRAINS } from '../src/world/terrain.ts';
import { VARIANTS, buildSurface, pokeThrough } from '../src/surface/index.ts';
import { inspect } from './inspect.ts';
import { crossingBorders } from './edges.ts';

interface Row {
  scene: string;
  roads: number;
  junctions: number;
  triangles: number;
  holes: number;
  downFacing: number;
  flat: number;
  aspect: number;
  paved: number;
  grade: number;
  poke: number;
  tangled: number;
  ms: number;
}

const out: Record<string, Row[]> = {};

for (const variant of Object.keys(VARIANTS)) {
  out[variant] = [];
  for (const scene of Object.keys(SCENES)) {
    let row: Row | null = null;
    for (const terrain of Object.keys(TERRAINS)) {
      const started = performance.now();
      const world = buildWorld(SCENES[scene], terrain);
      const surface = buildSurface(world, variant);
      const ms = performance.now() - started;
      const r = inspect(world, surface);
      const poke = variant === 'B' ? pokeThrough(world).worst : 0;
      const tangled = variant === 'A' ? crossingBorders(world).count : 0;
      const next: Row = {
        scene,
        roads: world.shapes.length,
        junctions: world.junctions.length,
        triangles: r.triangles,
        holes: r.holes,
        downFacing: r.downFacing,
        flat: r.flat,
        aspect: Math.round(r.worstAspect),
        paved: r.paved,
        grade: r.grade,
        poke,
        tangled,
        ms: Math.round(ms),
      };
      // по каждой сцене берём ХУДШИЙ из трёх рельефов: врать в свою пользу нельзя
      row = row === null ? next : {
        ...next,
        triangles: Math.max(row.triangles, next.triangles),
        holes: Math.max(row.holes, next.holes),
        downFacing: Math.max(row.downFacing, next.downFacing),
        flat: Math.max(row.flat, next.flat),
        aspect: Math.max(row.aspect, next.aspect),
        paved: Math.max(row.paved, next.paved),
        grade: Math.max(row.grade, next.grade),
        poke: Math.max(row.poke, next.poke),
        tangled: Math.max(row.tangled, next.tangled),
        ms: Math.max(row.ms, next.ms),
      };
    }
    out[variant].push(row as Row);
  }
}

console.log(JSON.stringify(out, null, 1));
