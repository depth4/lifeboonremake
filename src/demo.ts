/** Рукотворные данные для первого шага: одна дорога через плато. */

import type { Road } from './world/road.ts';
import { ROAD_TYPES } from './world/road.ts';

export const DEMO_ROADS: Road[] = [
  {
    type: ROAD_TYPES.street2,
    centerline: [
      { x: -105, z: -70 },
      { x: -40, z: -30 },
      { x: 10, z: 15 },
      { x: 55, z: 20 },
      { x: 105, z: 62 },
    ],
  },
];
