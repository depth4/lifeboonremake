/**
 * Обстрел случайными постройками.
 *
 * Смысл: не надеяться, что игрок не наткнётся на поломку, а самим построить
 * тысячу нелепых дорожных сетей и посмотреть, где мир рвётся. Глаз так не может,
 * а это считается за минуту и без браузера.
 *
 * Запуск: npm run fuzz [сколько построек]
 */

import type { Point2, Road } from '../src/world/road.ts';
import { roadTypeForLanes } from '../src/world/road.ts';
import { buildWorld } from '../src/world/world.ts';
import { buildSurface } from '../src/surface/index.ts';
import { TERRAINS, WORLD_HALF } from '../src/world/terrain.ts';
import { inspect, problems } from './inspect.ts';

const TRIES = Number(process.argv[2] ?? 200);

/** Свой генератор случайных чисел: одно и то же зерно даёт один и тот же мир. */
function rng(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 4294967296;
  };
}

function layout(seed: number): { roads: Road[]; terrain: string } {
  const rand = rng(seed);
  const names = Object.keys(TERRAINS);
  const terrain = names[Math.floor(rand() * names.length)];
  const count = 1 + Math.floor(rand() * 4);
  const roads: Road[] = [];

  for (let r = 0; r < count; r++) {
    const points = 2 + Math.floor(rand() * 4);
    const centerline: Point2[] = [];
    for (let i = 0; i < points; i++) {
      centerline.push({
        x: (rand() * 2 - 1) * (WORLD_HALF - 10),
        z: (rand() * 2 - 1) * (WORLD_HALF - 10),
      });
    }
    roads.push({ type: roadTypeForLanes(1 + Math.floor(rand() * 4)), centerline });
  }
  return { roads, terrain };
}

interface Broken {
  seed: number;
  terrain: string;
  roads: number;
  reasons: string[];
}

const broken: Broken[] = [];
let rejected = 0;
let worstAspect = 0;
let worstAspectSeed = 0;
let maxTriangles = 0;
let slowest = 0;

for (let seed = 1; seed <= TRIES; seed++) {
  const { roads, terrain } = layout(seed);
  const started = performance.now();

  let report;
  try {
    const world = buildWorld(roads, terrain);
    if (world.rejected !== null || world.shapes.length === 0) {
      rejected++;
      continue;
    }
    const surface = buildSurface(world);
    report = inspect(world, surface);
  } catch (error) {
    const text = String(error);
    if (text.includes('накладываются')) {
      rejected++;
      continue;
    }
    broken.push({ seed, terrain, roads: roads.length, reasons: ['ПАДЕНИЕ: ' + text.split('\n')[0]] });
    continue;
  }
  slowest = Math.max(slowest, performance.now() - started);
  maxTriangles = Math.max(maxTriangles, report.triangles);
  if (report.worstAspect > worstAspect) {
    worstAspect = report.worstAspect;
    worstAspectSeed = seed;
  }

  const reasons = problems(report);
  if (reasons.length > 0) broken.push({ seed, terrain, roads: roads.length, reasons });
}

const crossing = broken.filter((b) => b.roads > 1).length;

console.log(`обстрел: ${TRIES} случайных построек`);
console.log(`  сломалось            ${broken.length} (${((broken.length / TRIES) * 100).toFixed(0)}%)`);
console.log(`  не построилось       ${rejected} (мир отказался их принять)`);
console.log(`    из них с несколькими дорогами  ${crossing}`);
console.log(`    из них с одной дорогой         ${broken.length - crossing}`);
console.log(`  худшая вытянутость треугольника  ${worstAspect.toFixed(0)} : 1   (зерно ${worstAspectSeed})`);
console.log(`  самая тяжёлая постройка          ${maxTriangles.toLocaleString('ru-RU')} треугольников`);
console.log(`  самая долгая сборка              ${slowest.toFixed(0)} мс`);

const kinds = new Map<string, number>();
for (const b of broken) for (const r of b.reasons) {
  const kind = r.replace(/^\d+/, 'N');
  kinds.set(kind, (kinds.get(kind) ?? 0) + 1);
}
if (kinds.size > 0) {
  console.log('\nчто именно ломается:');
  for (const [kind, n] of [...kinds].sort((a, b) => b[1] - a[1])) console.log(`  ${String(n).padStart(4)} × ${kind}`);
  console.log('\nпервые сломанные постройки (зерно можно повторить):');
  for (const b of broken.slice(0, 5)) console.log(`  зерно ${b.seed}, рельеф ${b.terrain}, дорог ${b.roads}: ${b.reasons[0]}`);
}

process.exit(broken.length > 0 ? 1 : 0);
