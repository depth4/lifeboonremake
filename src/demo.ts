/** Рукотворные данные для первого шага: одна дорога через плато. */

import type { Road } from './world/road.ts';
import { ROAD_TYPES } from './world/road.ts';

export const DEMO_ROADS: Road[] = [
  {
    type: ROAD_TYPES.street2,
    centerline: [
      { x: -105, z: -58 },
      { x: -38, z: -8 },
      { x: 8, z: 16 },
      { x: 44, z: 34 },
      { x: 100, z: 58 },
    ],
  },
];
