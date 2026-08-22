/** Рукотворные данные для первого запуска: две дороги с перекрёстком. */

import type { Road } from './world/road.ts';
import { roadTypeForLanes } from './world/road.ts';

export const DEMO_ROADS: Road[] = [
  {
    type: roadTypeForLanes(2),
    centerline: [
      { x: -100, z: -46 },
      { x: -40, z: -22 },
      { x: 20, z: 6 },
      { x: 100, z: 34 },
    ],
  },
  {
    type: roadTypeForLanes(1),
    centerline: [
      { x: -28, z: 96 },
      { x: -6, z: 20 },
      { x: 14, z: -44 },
      { x: 30, z: -96 },
    ],
  },
];
