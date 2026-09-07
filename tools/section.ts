/** Поперечный разрез: что было у земли и что стало. Цифрами, без картинок. */
import { SCENES } from '../src/scenes.ts';
import { buildWorld, shelfHeight, roadHeightAt, nearestRoad } from '../src/world/world.ts';
import { TERRAINS } from '../src/world/terrain.ts';

const scene = process.argv[2] ?? 'крест';
const terrain = process.argv[3] ?? 'mountain';
const along = Number(process.argv[4] ?? -38);
const world = buildWorld(SCENES[scene], terrain);
const nat = TERRAINS[terrain].height;

console.log(`разрез поперёк дороги при x=${along}, рельеф «${TERRAINS[terrain].label}»`);
console.log('   z   было  стало  разница   что');
for (let z = -46; z <= 46; z += 2) {
  const near = nearestRoad(world, along, z);
  const d = near ? near.distance : Infinity;
  const outward = near ? Math.max(0, d - near.outerHalf) : Infinity;
  const on = near !== null && d <= near.outerHalf;
  const h = on && d <= near.halfWidth ? roadHeightAt(world, along, z) : shelfHeight(world, along, z, outward);
  const was = nat(along, z);
  const what = near === null ? '' : d <= near.halfWidth ? 'дорога' : on ? 'тротуар' : `земля (+${outward.toFixed(1)} м наружу)`;
  console.log(
    `${String(z).padStart(5)} ${was.toFixed(2).padStart(6)} ${h.toFixed(2).padStart(6)} ${(h - was).toFixed(2).padStart(7)}   ${what}`,
  );
}
