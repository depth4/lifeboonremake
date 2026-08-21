/**
 * Рельеф: естественная высота земли в любой точке.
 * Единица измерения — метр. Ось Y смотрит вверх.
 * Про дороги этот файл не знает ничего.
 */

/** Мир — квадрат со стороной 2 × WORLD_HALF метров, центр в нуле. */
export const WORLD_HALF = 120;

/** Высота земли до того, как её тронули дороги. */
export function naturalHeight(x: number, z: number): number {
  const slope = x * 0.055;
  const hills = Math.sin(z / 31) * 2.6 + Math.cos(x / 26) * 1.9;
  const ripple = Math.sin((x + z) / 17) * 0.7;
  return slope + hills + ripple;
}
