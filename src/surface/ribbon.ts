/**
 * ВАРИАНТ Б — «лента и земля порознь».
 *
 * Так делают чаще всего, и это самый дешёвый способ. Земля — ровная сетка,
 * которую никто не режет. Дорога — отдельная лента поперечных сечений,
 * положенная сверху. По краю ленты пускается юбка вниз, чтобы в стык между
 * лентой и землёй не было видно неба.
 *
 * За что его любят:
 *   — пересборка мгновенная: сетка земли не меняется вообще, а лента считается
 *     по одной дороге за раз и ни от чего не зависит;
 *   — никакой геометрии областей, никаких библиотек, сто строк кода;
 *   — треугольников ровно столько, сколько задумано, и это число постоянно.
 *
 * Чем за это платят — ровно тем, о чём говорит правило 0:
 * это ДВЕ независимые поверхности, и «земля торчит сквозь дорогу» тут
 * выразимо. Земля под дорогой опущена на DIP, юбка свисает на SKIRT — обе
 * цифры подобраны так, чтобы обычно не торчало. «Обычно» — потому что сетка
 * земли натянута между своими узлами, а край дороги проходит между ними как
 * попало: на склоне натянутый треугольник вылезает поверх асфальта. Лечится
 * это только увеличением DIP, то есть дорога начинает висеть над ямой.
 *
 * И перекрёстка тут нет как понятия: две ленты просто лежат друг на друге.
 *
 * Этот файл существует, чтобы цену этого выбора было видно в цифрах, а не
 * на словах.
 */

import type { World } from '../world/world.ts';
import type { Surface } from './mesh.ts';
import { bands } from '../world/road.ts';
import { WORLD_HALF } from '../world/terrain.ts';
import { groundHeightAt, roadHeightAt } from '../world/world.ts';
import { GROUND, MeshBuilder, ROAD, SHELF, CURB_FOOT, CURB_TOP } from './mesh.ts';

/** Шаг сетки земли, метры. */
const GRID_STEP = 4;
/** На сколько земля под дорогой опущена, чтобы не лезть сквозь асфальт. */
const DIP = 0.35;
/** На сколько лента свисает по краю, чтобы в стык не было видно неба. */
const SKIRT = 0.9;

export function buildSurface(world: World): Surface {
  const mesh = new MeshBuilder();

  // --- 1. Земля: ровная сетка, которую никто не режет ---
  const steps = Math.round((WORLD_HALF * 2) / GRID_STEP);
  const at = (i: number, j: number): number => {
    const x = -WORLD_HALF + i * GRID_STEP;
    const z = -WORLD_HALF + j * GRID_STEP;
    // земля НЕ знает, где именно проходит край дороги: она знает только
    // расстояние до осевой линии. В этом вся суть отдельной поверхности.
    const near = world.near(x, z);
    const under = near !== null && near.distance < near.outerHalf;
    const y = under ? near.roadHeight - DIP : groundHeightAt(world, x, z);
    return mesh.vertex(x, y, z, GROUND);
  };
  const grid: number[][] = [];
  for (let i = 0; i <= steps; i++) {
    grid.push([]);
    for (let j = 0; j <= steps; j++) grid[i].push(at(i, j));
  }
  for (let i = 0; i < steps; i++) {
    for (let j = 0; j < steps; j++) {
      mesh.triUp('grass', grid[i][j], grid[i + 1][j], grid[i + 1][j + 1]);
      mesh.triUp('grass', grid[i][j], grid[i + 1][j + 1], grid[i][j + 1]);
    }
  }

  // --- 2. Лента дороги: поперечные сечения по станциям ---
  for (const shape of world.shapes) {
    const st = shape.stations;
    const strip = bands(shape.type).map((band) => ({ ...band }));

    /** Вершины одного сечения: смещение поперёк -> вершина. */
    const section = (i: number, offset: number, rise: number, level: number): number => {
      const s = st[i];
      const x = s.x + s.nx * offset, z = s.z + s.nz * offset;
      return mesh.vertex(x, shape.height[i] + rise, z, level);
    };

    for (let i = 0; i + 1 < st.length; i++) {
      for (const band of strip) {
        const material = band.kind === 'marking' ? 'marking' : 'asphalt';
        const a = section(i, band.from, band.rise, ROAD);
        const b = section(i, band.to, band.rise, ROAD);
        const c = section(i + 1, band.to, band.rise, ROAD);
        const d = section(i + 1, band.from, band.rise, ROAD);
        mesh.triUp(material, a, b, c);
        mesh.triUp(material, a, c, d);
      }

      for (const side of [1, -1]) {
        const inner = side * shape.halfWidth;
        const outer = side * shape.outerHalf;
        const curb = shape.type.curb;
        // тротуар
        const a = section(i, inner, curb, SHELF);
        const b = section(i, outer, curb, SHELF);
        const c = section(i + 1, outer, curb, SHELF);
        const d = section(i + 1, inner, curb, SHELF);
        mesh.triUp('sidewalk', a, b, c);
        mesh.triUp('sidewalk', a, c, d);
        // бордюр
        mesh.wall(
          'curb',
          section(i, inner, 0, CURB_FOOT),
          section(i + 1, inner, 0, CURB_FOOT),
          section(i, inner, curb, CURB_TOP),
          section(i + 1, inner, curb, CURB_TOP),
          { x: st[i].x, z: st[i].z },
        );
        // юбка: свисает вниз по внешнему краю, чтобы в стык не было видно неба
        mesh.wall(
          'sidewalk',
          section(i, outer, curb - SKIRT, CURB_FOOT),
          section(i + 1, outer, curb - SKIRT, CURB_FOOT),
          section(i, outer, curb, CURB_TOP),
          section(i + 1, outer, curb, CURB_TOP),
          { x: st[i].x, z: st[i].z },
        );
      }
    }
  }

  return mesh.build();
}

/**
 * Сколько земли торчит сквозь асфальт.
 *
 * Меряем честно по СЕТКЕ, а не по формуле: земля нарисована треугольниками,
 * натянутыми между узлами сетки, и торчит именно натянутое. Проверяем частой
 * решёткой точек внутри проезжей части.
 */
export function pokeThrough(world: World): { worst: number; share: number; probes: number } {
  const steps = Math.round((WORLD_HALF * 2) / GRID_STEP);
  const nodeHeight = (i: number, j: number): number => {
    const x = -WORLD_HALF + i * GRID_STEP;
    const z = -WORLD_HALF + j * GRID_STEP;
    const near = world.near(x, z);
    return near !== null && near.distance < near.outerHalf ? near.roadHeight - DIP : groundHeightAt(world, x, z);
  };

  /** Высота натянутого треугольника сетки в этой точке. */
  const meshHeight = (x: number, z: number): number => {
    const fi = (x + WORLD_HALF) / GRID_STEP, fj = (z + WORLD_HALF) / GRID_STEP;
    const i = Math.min(steps - 1, Math.max(0, Math.floor(fi)));
    const j = Math.min(steps - 1, Math.max(0, Math.floor(fj)));
    const u = fi - i, v = fj - j;
    const h00 = nodeHeight(i, j), h10 = nodeHeight(i + 1, j);
    const h11 = nodeHeight(i + 1, j + 1), h01 = nodeHeight(i, j + 1);
    // сетка режется по диагонали 00–11, как её и рисуют выше
    return u >= v
      ? h00 + (h10 - h00) * u + (h11 - h10) * v
      : h00 + (h11 - h01) * u + (h01 - h00) * v;
  };

  let worst = 0;
  let over = 0;
  let probes = 0;
  for (const shape of world.shapes) {
    for (const s of shape.stations) {
      for (let k = -10; k <= 10; k++) {
        const off = (shape.halfWidth * k) / 10;
        const x = s.x + s.nx * off, z = s.z + s.nz * off;
        const above = meshHeight(x, z) - roadHeightAt(world, x, z);
        probes++;
        if (above > 0) {
          over++;
          worst = Math.max(worst, above);
        }
      }
    }
  }
  return { worst, share: probes === 0 ? 0 : over / probes, probes };
}
