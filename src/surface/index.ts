/**
 * Сборщик поверхности. Здесь выбирается вариант архитектуры.
 * Варианты живут рядом и собираются из одного и того же мира, поэтому
 * их можно сравнивать на одинаковых сценах одними и теми же цифрами.
 */

export type { Material, Surface, SurfaceGroup } from './mesh.ts';
export { buildSurface } from './carve.ts';
export { buildGhost } from './ghost.ts';
