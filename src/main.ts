/** Склейка: собрать мир, посчитать поверхность, показать, повесить кнопки. */

import type { Road } from './world/road.ts';
import { DEFAULT_SCENE, SCENES } from './scenes.ts';
import { roadWidth } from './world/road.ts';
import { MAX_GRADE, buildWorld, snapPoint } from './world/world.ts';
import { DEFAULT_TERRAIN, TERRAINS } from './world/terrain.ts';
import { DEFAULT_VARIANT, VARIANTS, buildGhost, buildSurface } from './surface/index.ts';
import { VIEWS, show, viewFromQuery } from './render.ts';
import { createBuilder } from './build.ts';
import { GroundIndex } from './car/ground.ts';
import { VIPER } from './car/passport.ts';
import { P_ZERO } from './car/tyre.ts';
import { type Car, createCar, forwardSpeed, step } from './car/car.ts';
import { SCHEMES, createDriver } from './car/controls.ts';

const query = new URLSearchParams(location.search);
const startView = query.get('view') ?? 'road';
const startScene = query.get('scene') ?? DEFAULT_SCENE;

/** На каком расстоянии инструмент начинает распознавать намерение, метры. */
const SNAP_RADIUS = 14;

let sceneName = SCENES[startScene] ? startScene : DEFAULT_SCENE;
const roads: Road[] = [...SCENES[sceneName]];
let terrainName = query.get('terrain') ?? DEFAULT_TERRAIN;
if (!TERRAINS[terrainName]) terrainName = DEFAULT_TERRAIN;

let variant = query.get('variant')?.toUpperCase() ?? DEFAULT_VARIANT;
if (!VARIANTS[variant]) variant = DEFAULT_VARIANT;

let world = buildWorld(roads, terrainName);
let surface = buildSurface(world, variant);
let rebuildMs = 0;
let lastGood: Road[] = [...roads];
let refusal = '';

// ?bare=1 — убрать всю обвязку: нужно, когда снимок идёт в сравнение
if (query.get('bare') === '1') {
  document.querySelector('.layer')?.remove();
  document.getElementById('news')?.remove();
}

/**
 * Отметка сборки. Ставится при сборке страницы, а не пишется руками:
 * иначе однажды она соврёт. Нужна ровно для одного вопроса — «я открыл
 * свежую версию или старую из памяти браузера?»
 */
const stamp = (import.meta.env.VITE_BUILD as string | undefined) ?? '';
const changes = ((import.meta.env.VITE_CHANGES as string | undefined) ?? '')
  .split('\n')
  .map((line) => line.trim())
  .filter((line) => line.length > 0);

const buildLine = document.getElementById('build');
if (buildLine && stamp !== '') {
  buildLine.textContent = stamp;
  buildLine.classList.add('fresh');
}

const news = document.getElementById('news');
const newsList = document.getElementById('news-list');
if (news && newsList && changes.length > 0 && query.get('bare') !== '1') {
  newsList.innerHTML = changes.map((line) => `<li>${line}</li>`).join('');
  const when = document.getElementById('news-when');
  if (when) when.textContent = `что нового · ${stamp}`;
  news.classList.add('open');
  document.getElementById('news-close')?.addEventListener('click', () => news.classList.remove('open'));
  // отметку сборки можно нажать, чтобы список вернулся
  buildLine?.addEventListener('click', () => news.classList.toggle('open'));
}

const viewer = show(surface, startView, viewFromQuery(query));
const canvas = document.querySelector('canvas');

/**
 * Пересобрать мир. Если постройка такая, что мир её принять не может,
 * откатываем последнее действие и говорим об этом. Кривой мир на экран
 * не попадает никогда — в этом и смысл отказа.
 */
function rebuild(): void {
  const started = performance.now();
  try {
    const next = buildWorld(roads, terrainName);
    const nextSurface = buildSurface(next, variant);
    world = next;
    surface = nextSurface;
    lastGood = [...roads];
    refusal = '';
  } catch (error) {
    refusal = String(error instanceof Error ? error.message : error).replace(/ \(.*\)$/, '');
    roads.splice(0, roads.length, ...lastGood);
    world = buildWorld(roads, terrainName);
    surface = buildSurface(world, variant);
  }
  rebuildMs = performance.now() - started;
  ground = new GroundIndex(surface);
  viewer.setSurface(surface);
  readout();
  hint();
}

function readout(): void {
  const facts = document.getElementById('facts');
  const name = document.getElementById('road-name');
  const length = world.shapes.reduce((sum, shape) => sum + (shape.stations.at(-1)?.s ?? 0), 0);
  const widest = roads.reduce((w, r) => Math.max(w, roadWidth(r.type)), 0);

  if (name) {
    name.textContent = roads.length === 0
      ? 'дорог нет'
      : `дорог: ${roads.length}, перекрёстков: ${world.junctions.length}`;
  }
  if (facts) {
    const rows: [string, string][] = [
      ['длина', `${Math.round(length)} м`],
      ['полос в сторону', String(builder.lanes())],
      ['ширина', `${widest.toFixed(2)} м`],
      ['уклон', `${(world.grade * 100).toFixed(1)}% из ${(MAX_GRADE * 100).toFixed(0)}%`],
      ['отрыв от земли', `${world.lift.toFixed(1)} м${world.lift > 6 ? ' — нужен мост' : ''}`],
      ['перекрёстков', String(world.junctions.length)],
      ['пересборка', `${rebuildMs.toFixed(0)} мс`],
      ['вариант', VARIANTS[variant].label],
    ];
    facts.innerHTML = rows.map(([k, v]) => `<div>${k} <b>${v}</b></div>`).join('');
  }
}

const builder = createBuilder({
  viewer,
  canvas: canvas ?? document.body,
  roads,
  onChanged: rebuild,
  onState: () => {
    hint();
    readout();
  },
  preview: (road) => {
    viewer.setGhost(road ? buildGhost(world, road) : null);
  },
  snap: (point) => {
    const hit = snapPoint(world, point.x, point.z, SNAP_RADIUS);
    return hit ? { point: hit.point, kind: hit.kind } : null;
  },
});

// --- кнопки ракурса ---
const views = document.getElementById('views');
if (views) {
  views.innerHTML = Object.entries(VIEWS)
    .map(([key, v]) => `<button type="button" data-view="${key}" aria-pressed="${key === startView}">${v.label}</button>`)
    .join('');
  views.addEventListener('click', (event) => {
    const button = (event.target as HTMLElement).closest<HTMLButtonElement>('button[data-view]');
    if (!button) return;
    viewer.setView(button.dataset.view ?? 'road');
    views.querySelectorAll('button').forEach((b) => b.setAttribute('aria-pressed', String(b === button)));
  });
}

// --- кнопки строительства ---
let building = false;
const tools = document.getElementById('tools');
if (tools) {
  tools.innerHTML =
    '<button type="button" data-tool="look" aria-pressed="true">смотреть</button>' +
    '<button type="button" data-tool="road" aria-pressed="false">дорога</button>' +
    '<button type="button" class="plain" data-tool="undo">убрать последнюю</button>';

  tools.addEventListener('click', (event) => {
    const button = (event.target as HTMLElement).closest<HTMLButtonElement>('button[data-tool]');
    if (!button) return;
    const tool = button.dataset.tool ?? 'look';

    if (tool === 'undo') {
      builder.undo();
      return;
    }
    building = tool === 'road';
    builder.setActive(building);
    tools.querySelectorAll<HTMLButtonElement>('button[data-tool]').forEach((b) => {
      if (b.dataset.tool !== 'undo') b.setAttribute('aria-pressed', String(b.dataset.tool === tool));
    });
  });
}

// --- кнопка «сетка»: показать, из чего мир сделан на самом деле ---
const wireBox = document.getElementById('wire');
if (wireBox) {
  wireBox.innerHTML =
    '<button type="button" data-wire="off">скрыть</button>' +
    '<button type="button" data-wire="on">показать</button>';
  const paint = (): void => {
    wireBox.querySelectorAll<HTMLButtonElement>('button[data-wire]').forEach((b) => {
      b.setAttribute('aria-pressed', String((b.dataset.wire === 'on') === viewer.wire()));
    });
  };
  paint();
  wireBox.addEventListener('click', (event) => {
    const button = (event.target as HTMLElement).closest<HTMLButtonElement>('button[data-wire]');
    if (!button) return;
    viewer.setWire(button.dataset.wire === 'on');
    paint();
  });
}

// --- кнопки варианта ---
const variants = document.getElementById('variants');
if (variants) {
  variants.innerHTML = Object.entries(VARIANTS)
    .map(([key, v]) => `<button type="button" data-variant="${key}" aria-pressed="${key === variant}" title="${v.label}">${key}</button>`)
    .join('');
  variants.addEventListener('click', (event) => {
    const button = (event.target as HTMLElement).closest<HTMLButtonElement>('button[data-variant]');
    if (!button) return;
    variant = button.dataset.variant ?? DEFAULT_VARIANT;
    lastGood = [...roads];
    rebuild();
    variants.querySelectorAll('button').forEach((b) => b.setAttribute('aria-pressed', String(b === button)));
  });
}

// --- кнопки сцены ---
const scenes = document.getElementById('scenes');
if (scenes) {
  scenes.innerHTML = Object.keys(SCENES)
    .map((key) => `<button type="button" data-scene="${key}" aria-pressed="${key === sceneName}">${key}</button>`)
    .join('');
  scenes.addEventListener('click', (event) => {
    const button = (event.target as HTMLElement).closest<HTMLButtonElement>('button[data-scene]');
    if (!button) return;
    sceneName = button.dataset.scene ?? DEFAULT_SCENE;
    roads.splice(0, roads.length, ...SCENES[sceneName]);
    lastGood = [...roads];
    rebuild();
    scenes.querySelectorAll('button').forEach((b) => b.setAttribute('aria-pressed', String(b === button)));
  });
}

// --- кнопки рельефа ---
const terrains = document.getElementById('terrains');
if (terrains) {
  terrains.innerHTML = Object.entries(TERRAINS)
    .map(([key, t]) => `<button type="button" data-terrain="${key}" aria-pressed="${key === terrainName}">${t.label}</button>`)
    .join('');
  terrains.addEventListener('click', (event) => {
    const button = (event.target as HTMLElement).closest<HTMLButtonElement>('button[data-terrain]');
    if (!button) return;
    terrainName = button.dataset.terrain ?? DEFAULT_TERRAIN;
    lastGood = [...roads];
    rebuild();
    terrains.querySelectorAll('button').forEach((b) => b.setAttribute('aria-pressed', String(b === button)));
  });
}

const HINTS: Record<string, string> = {
  off: 'перетаскивай — поворот    колесо — приближение',
  idle: 'клик по земле — начать дорогу    правая кнопка — поворот камеры',
  drawing: 'клик — участок прямой    зажми и потяни — участок изогнётся    Esc — закончить линию',
  width: 'веди мышь — число полос щёлкает    клик — готово',
};

function hint(): void {
  const node = document.getElementById('hint');
  if (!node) return;
  const snapped = builder.snapped();
  node.textContent = refusal !== ''
    ? refusal
    : snapped !== ''
      ? `привязка к ${snapped === 'узел' ? 'перекрёстку' : snapped === 'торец' ? 'концу дороги' : 'дороге'} — клик соединит`
      : (HINTS[builder.phase()] ?? HINTS.off);
  node.classList.toggle('refused', refusal !== '');
  node.classList.toggle('snapped', refusal === '' && snapped !== '');
}

readout();
hint();

// Где место (x, z) оказывается на экране — нужно проверке кликами:
// она должна попадать мышью в места мира, а не в пиксели наугад.
(window as unknown as { __project?: (x: number, z: number) => { x: number; y: number } }).__project =
  (x, z) => viewer.project(x, z);

requestAnimationFrame(() => requestAnimationFrame(() => {
  (window as unknown as { __ready?: boolean }).__ready = true;
}));


// ─────────────────────────── ЗА РУЛЁМ ───────────────────────────
// Склейка: мир даёт опору, водитель — четыре числа, машина — новое состояние,
// показ — картинку. Ни одна из четырёх частей не знает про три остальные.

/** Опора под колесом. Те же треугольники, что нарисованы на экране. */
let ground = new GroundIndex(surface);
let car: Car | null = null;
/** Машина остаётся в мире, когда из неё вышли: просто перестаёт считаться. */
let driving = false;
const spinAngle = [0, 0, 0, 0];
const driver = createDriver(canvas ?? document.body);
const dash = document.getElementById('dash');

/**
 * Поставить машину на первую дорогу сцены, носом вдоль неё, на трети пути —
 * чтобы перекрёсток был впереди, а не за спиной и не под колёсами.
 */
function spawnCar(): Car {
  const shape = world.shapes[0];
  const st = shape?.stations ?? [];
  if (st.length < 2) return createCar(VIPER, 0, 0, 0);
  const i = Math.min(Math.floor(st.length * 0.32), st.length - 2);
  const yaw = Math.atan2(st[i + 1].z - st[i].z, st[i + 1].x - st[i].x);
  spinAngle.fill(0);
  return createCar(VIPER, st[i].x, st[i].z, yaw);
}

function seat(on: boolean): void {
  if (on && car === null) car = spawnCar();
  driving = on;
  viewer.setChase(on);
  if (dash) dash.hidden = !on;
  if (on && building) {
    building = false;
    builder.setActive(false);
    tools?.querySelectorAll<HTMLButtonElement>('button[data-tool]').forEach((b) => {
      b.setAttribute('aria-pressed', String(b.dataset.tool === 'look'));
    });
  }
  drivePanel();
}

const el = (id: string): HTMLElement | null => document.getElementById(id);

function drivePanel(): void {
  const panel = el('drive');
  if (!panel) return;
  panel.innerHTML =
    `<button type="button" data-drive="seat" aria-pressed="${driving}">за руль</button>` +
    `<button type="button" class="plain" data-drive="scheme">${SCHEMES.find((s) => s.id === driver.scheme)?.label}</button>` +
    `<button type="button" class="plain" data-drive="centre" aria-pressed="${driver.selfCentre}">возврат руля</button>` +
    (car === null ? '' : '<button type="button" class="plain" data-drive="park">убрать машину</button>');
  const tip = el('d-tip');
  if (tip) {
    const hint = SCHEMES.find((s) => s.id === driver.scheme)?.hint ?? '';
    tip.textContent = driver.pad()
      ? 'геймпад подключён: стики и курки главнее мыши'
      : `${hint}. X — ручник, R — отпустить руль, [ и ] — чувствительность руля`;
  }
}

el('drive')?.addEventListener('click', (event) => {
  const button = (event.target as HTMLElement).closest<HTMLButtonElement>('button[data-drive]');
  if (!button) return;
  const what = button.dataset.drive;
  if (what === 'seat') seat(!driving);
  else if (what === 'park') { car = null; driving = false; viewer.setCar(null); viewer.setChase(false); if (dash) dash.hidden = true; drivePanel(); }
  else if (what === 'scheme') {
    const i = SCHEMES.findIndex((s) => s.id === driver.scheme);
    driver.scheme = SCHEMES[(i + 1) % SCHEMES.length].id;
    drivePanel();
  } else if (what === 'centre') {
    driver.selfCentre = !driver.selfCentre;
    drivePanel();
  }
});
drivePanel();

/** Шаг физики. Не связан с кадрами: на слабой машине счёт тот же. */
const PHYSICS_STEP = 1 / 300;
let bank = 0;
/** Сколько секунд насчитала физика. Не то же, что время на часах. */
let simTime = 0;

let lastControls = { steer: 0, throttle: 0, brake: 0, handbrake: false };

viewer.onFrame((dt) => {
  if (car === null) return;
  const speed = forwardSpeed(car);
  const controls = driving
    ? driver.read(dt, speed)
    : { steer: 0, throttle: 0, brake: 1, handbrake: true };
  lastControls = controls;

  bank = driving ? Math.min(bank + dt, 0.3) : 0;
  while (bank >= PHYSICS_STEP) {
    step(car, VIPER, P_ZERO, (x, z) => ground.sample(x, z), controls, PHYSICS_STEP);
    bank -= PHYSICS_STEP;
    simTime += PHYSICS_STEP;
  }
  car.wheels.forEach((w, i) => { spinAngle[i] += w.spin * dt; });

  viewer.setCar({
    x: car.x, y: car.bodyY, z: car.z,
    yaw: car.yaw, pitch: car.pitch, roll: car.roll, speed,
    wheels: car.wheels.map((w, i) => ({
      x: w.x, y: w.y, z: w.z, steer: w.steer, spin: spinAngle[i],
      radius: w.radius, width: i < 2 ? VIPER.wheelFront.width : VIPER.wheelRear.width,
    })),
  });

  // приборка
  const speedo = el('d-speed');
  if (speedo) speedo.textContent = String(Math.round(Math.abs(speed) * 3.6));
  const rev = el('d-rev');
  if (rev) {
    rev.style.width = `${(car.rpm / VIPER.cutoffRpm) * 100}%`;
    rev.classList.toggle('red', car.rpm > VIPER.cutoffRpm * 0.92);
  }
  const gear = el('d-gear');
  if (gear) gear.textContent = car.reverse ? 'R' : Math.abs(speed) < 0.3 ? 'N' : String(car.gear + 1);
  const rpm = el('d-rpm');
  if (rpm) rpm.textContent = `${Math.round(car.rpm)} об/мин`;
  const mat = el('d-mat');
  if (mat) mat.textContent = car.wheels[2].material;
  const gas = el('d-gas');
  if (gas) gas.style.height = `${controls.throttle * 100}%`;
  const brake = el('d-brake');
  if (brake) brake.style.height = `${controls.brake * 100}%`;
  const sens = el('d-sens');
  if (sens) sens.textContent = `руль ${driver.sensitivity} px`;
  const wheelMark = el('d-wheel');
  if (wheelMark) wheelMark.setAttribute('transform', `rotate(${(-car.steer / VIPER.steerLock) * 240})`);
  const grips = el('d-grips');
  if (grips) {
    if (grips.children.length !== 4) grips.innerHTML = '<i></i><i></i><i></i><i></i>';
    car.wheels.forEach((w, i) => {
      const box = grips.children[i] as HTMLElement;
      const use = Math.min(1.6, w.use);
      // до предела зелёный, за пределом красный: видно, какое колесо поехало
      box.style.background = use < 1
        ? `rgba(127, 196, 107, ${0.2 + use * 0.65})`
        : `rgba(224, 72, 63, ${0.35 + Math.min(1, use - 1) * 0.6})`;
    });
  }
});

/**
 * Снимок состояния машины для проверок из терминала — как `__project` рядом.
 * Нужен потому, что время на часах и время, насчитанное физикой, — разные
 * вещи: в безголовом браузере кадры идут медленнее, и мерить разгон
 * секундомером снаружи бессмысленно.
 */
(window as unknown as { __car?: () => unknown }).__car = () => (car === null ? null : {
  x: car.x, z: car.z, yaw: car.yaw, speed: forwardSpeed(car),
  gear: car.gear, reverse: car.reverse, rpm: car.rpm, sim: simTime,
  materials: car.wheels.map((w) => w.material),
  loads: car.wheels.map((w) => Math.round(w.load)),
  use: car.wheels.map((w) => Number(w.use.toFixed(2))),
  slip: car.wheels.map((w) => Number(w.slip.toFixed(3))),
  throttle: Number(lastControls.throttle.toFixed(3)),
  gearShown: car.gear,
  lost: car.wheels.some((w) => w.y < -100),
});
