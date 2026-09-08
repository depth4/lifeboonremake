/**
 * Сборщик поверхности. Здесь выбирается вариант архитектуры.
 * Варианты живут рядом и собираются из одного и того же мира, поэтому
 * их можно сравнивать на одинаковых сценах одними и теми же цифрами.
 */

import type { World } from '../world/world.ts';
import type { Surface } from './mesh.ts';
import { buildSurface as carve } from './carve.ts';
import { buildSurface as ribbon } from './ribbon.ts';

export type { Material, Surface, SurfaceGroup } from './mesh.ts';
export { SEALED } from './mesh.ts';
export { buildGhost } from './ghost.ts';
export { pokeThrough } from './ribbon.ts';

/** Варианты архитектуры. Собираются из одного и того же мира — значит сравнимы. */
export const VARIANTS: Record<string, { label: string; build: (world: World) => Surface }> = {
  A: { label: 'A — одна поверхность', build: carve },
  B: { label: 'Б — лента и земля порознь', build: ribbon },
};

export const DEFAULT_VARIANT = 'A';

export function buildSurface(world: World, variant: string = DEFAULT_VARIANT): Surface {
  return (VARIANTS[variant] ?? VARIANTS[DEFAULT_VARIANT]).build(world);
}
