/**
 * Показ мира на экране. Читает готовую поверхность и рисует её.
 * Ничем не владеет: если этот файл убрать, мир останется целым.
 */

import * as THREE from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import type { Material, Surface } from './surface/index.ts';
import type { Point2 } from './world/road.ts';
import type { Point3, Traffic, Turn } from './world/lanes.ts';

const COLORS: Record<Material, number> = {
  grass: 0x5f8a4a,
  asphalt: 0x3c4046,
  // тротуар светлее асфальта, бордюр темнее тротуара: настоящий бордюр
  // читается тёмной линией, потому что его вертикальная грань в тени
  sidewalk: 0xbbb6a9,
  curb: 0x807c72,
  marking: 0xf0ecdc,
};

/** Земля на крутом откосе — не трава, а обнажённый грунт. */
const SOIL = 0x7a6a4e;
/** Насколько цвет гуляет от места к месту, доля. */
const VARIATION: Record<Material, number> = {
  grass: 0.3, asphalt: 0.1, sidewalk: 0.11, curb: 0.05, marking: 0,
};

/**
 * Пятнистость: одно и то же место всегда даёт одно и то же число.
 * Не случайность, а функция от координат — иначе мир мерцал бы при пересборке.
 */
function blotch(x: number, z: number): number {
  const wave = (fx: number, fz: number, p: number): number =>
    Math.sin(x * fx + Math.cos(z * fz + p) * 2.3) * Math.cos(z * fz * 1.31 - Math.sin(x * fx * 0.7) * 1.7);
  return (wave(0.083, 0.071, 0) * 0.6 + wave(0.31, 0.27, 1.9) * 0.28 + wave(1.05, 0.93, 4.1) * 0.12);
}

/**
 * Цвет каждой вершины: порода + пятнистость места + крутизна склона.
 *
 * Считается ЗДЕСЬ, а не в мире: мир знает, что где лежит, а как оно выглядит —
 * дело показа. Уберите этот файл — мир останется целым.
 */
function shade(surface: Surface, normals: Float32Array): Float32Array {
  const colors = new Float32Array(surface.positions.length);
  const P = surface.positions;
  const I = surface.indices;
  const soil = new THREE.Color(SOIL);
  const tone = new THREE.Color();

  for (const group of surface.groups) {
    const base = new THREE.Color(COLORS[group.material]);
    const swing = VARIATION[group.material];
    for (let k = group.start; k < group.start + group.count; k++) {
      const v = I[k];
      if (colors[v * 3] !== 0 || colors[v * 3 + 1] !== 0 || colors[v * 3 + 2] !== 0) continue;
      tone.copy(base);
      if (group.material === 'grass') {
        // чем круче склон, тем меньше на нём держится трава
        const steep = Math.min(1, Math.max(0, (1 - normals[v * 3 + 1]) * 2.6));
        tone.lerp(soil, steep * 0.72);
      }
      const spot = 1 + blotch(P[v * 3], P[v * 3 + 2]) * swing;
      colors[v * 3] = tone.r * spot;
      colors[v * 3 + 1] = tone.g * spot;
      colors[v * 3 + 2] = tone.b * spot;
    }
  }
  return colors;
}

/**
 * Цвет связи — по тому, какой это поворот. Цвет здесь, а не в мире: мир знает,
 * куда можно ехать, а как это выглядит — дело показа.
 */
const TURN_COLOR: Record<Turn, [number, number, number]> = {
  'прямо':    [0.36, 0.85, 0.44],
  'налево':   [1.00, 0.68, 0.20],
  'направо':  [0.30, 0.70, 1.00],
  'разворот': [0.74, 0.55, 1.00],
};
/** Цвет самой полосы: холодный светлый, чтобы не путался с белой разметкой. */
const LANE_COLOR: [number, number, number] = [0.62, 0.93, 0.96];
/** Цвет места, где связи мешают друг другу. */
const CONFLICT_COLOR: [number, number, number] = [1.0, 0.32, 0.26];
/** На сколько линии движения подняты над асфальтом, чтобы не спорить с ним. */
const LIFT = 0.22;
/** Ширина ленты полосы и ленты связи, метры. */
const LANE_BAND = 0.42;
const LINK_BAND = 0.34;
/** Стрелка на конце: длина и половина ширины, метры. */
const HEAD = 1.9;
const HEAD_HALF = 0.85;
/** Половина размера ромбика помехи, метры. */
const SPOT = 0.55;

/** Копилка треугольников: точки и цвета, больше ничего не нужно. */
class Ribbons {
  readonly xyz: number[] = [];
  readonly rgb: number[] = [];

  private point(x: number, y: number, z: number, c: [number, number, number]): void {
    this.xyz.push(x, y + LIFT, z);
    this.rgb.push(c[0], c[1], c[2]);
  }

  quad(
    a: Point3, b: Point3,
    an: { x: number; z: number }, bn: { x: number; z: number },
    half: number, c: [number, number, number],
  ): void {
    const p = [
      { x: a.x - an.x * half, y: a.y, z: a.z - an.z * half },
      { x: a.x + an.x * half, y: a.y, z: a.z + an.z * half },
      { x: b.x + bn.x * half, y: b.y, z: b.z + bn.z * half },
      { x: b.x - bn.x * half, y: b.y, z: b.z - bn.z * half },
    ];
    for (const i of [0, 1, 2, 0, 2, 3]) this.point(p[i].x, p[i].y, p[i].z, c);
  }

  triangle(a: Point3, b: Point3, d: Point3, c: [number, number, number]): void {
    this.point(a.x, a.y, a.z, c);
    this.point(b.x, b.y, b.z, c);
    this.point(d.x, d.y, d.z, c);
  }
}

/** Направления поперёк пути в каждой его точке: усреднённые, чтобы лента не рвалась. */
function normalsAlong(path: readonly Point3[]): { x: number; z: number }[] {
  const out: { x: number; z: number }[] = [];
  for (let i = 0; i < path.length; i++) {
    const a = path[Math.max(0, i - 1)];
    const b = path[Math.min(path.length - 1, i + 1)];
    const dx = b.x - a.x, dz = b.z - a.z;
    const len = Math.hypot(dx, dz) || 1;
    out.push({ x: -dz / len, z: dx / len });
  }
  return out;
}

/** Лента вдоль пути и стрелка на её конце. */
function ribbon(into: Ribbons, path: readonly Point3[], half: number, c: [number, number, number]): void {
  if (path.length < 2) return;
  const n = normalsAlong(path);
  for (let i = 1; i < path.length; i++) into.quad(path[i - 1], path[i], n[i - 1], n[i], half, c);

  const tip = path[path.length - 1];
  const prev = path[path.length - 2];
  const dx = tip.x - prev.x, dz = tip.z - prev.z;
  const len = Math.hypot(dx, dz) || 1;
  const ux = dx / len, uz = dz / len;
  const base = { x: tip.x - ux * HEAD, y: tip.y, z: tip.z - uz * HEAD };
  into.triangle(
    tip,
    { x: base.x - uz * HEAD_HALF, y: base.y, z: base.z + ux * HEAD_HALF },
    { x: base.x + uz * HEAD_HALF, y: base.y, z: base.z - ux * HEAD_HALF },
    c,
  );
}

/**
 * Превращает сеть движения в треугольники для показа.
 *
 * Ничего не выдумывает: берёт ровно те пути, по которым машина и поедет.
 * Если на картинке стрелка ведёт не туда — значит не туда ведёт и связь,
 * и это настоящая поломка, а не ошибка рисования. Так и нашлась перепутанная
 * обрезка встречных полос: в цифрах её видно не было, на картинке — сразу.
 */
function trafficMesh(traffic: Traffic): { positions: Float32Array; colors: Float32Array } {
  const r = new Ribbons();
  for (const lane of traffic.lanes) ribbon(r, lane.path, LANE_BAND / 2, LANE_COLOR);
  for (const link of traffic.links) ribbon(r, link.path, LINK_BAND / 2, TURN_COLOR[link.turn]);

  // Ромбик там, где две связи мешают друг другу. Это места будущих
  // «уступи дорогу»: их никто не расставлял, они вычислены.
  for (const spot of traffic.conflicts) {
    const p = (dx: number, dz: number): Point3 => ({ x: spot.x + dx, y: spot.y, z: spot.z + dz });
    r.triangle(p(0, -SPOT), p(SPOT, 0), p(0, SPOT), CONFLICT_COLOR);
    r.triangle(p(0, -SPOT), p(0, SPOT), p(-SPOT, 0), CONFLICT_COLOR);
  }

  return { positions: new Float32Array(r.xyz), colors: new Float32Array(r.rgb) };
}

export interface View {
  readonly label: string;
  readonly from: [number, number, number];
  readonly at: [number, number, number];
  readonly fog: number;
}

/** Ракурсы: и для кнопок на странице, и для снимков из терминала. */
export const VIEWS: Record<string, View> = {
  plan: { label: 'план', from: [0, 275, 0.2], at: [0, 0, 0], fog: 900 },
  over: { label: 'сверху', from: [-210, 155, -205], at: [0, -2, 0], fog: 900 },
  road: { label: 'вдоль', from: [-118, 52, -128], at: [15, 2, 8], fog: 480 },
  close: { label: 'вблизи', from: [-52, 14, -34], at: [-4, 4, 4], fog: 320 },
  curb: { label: 'с дороги', from: [-48.1, 1.1, -12.7], at: [-8.8, 2.5, 10.0], fog: 200 },
};

export interface Viewer {
  setView(name: string): void;
  setSurface(surface: Surface): void;
  setGhost(mesh: { positions: Float32Array; indices: Uint32Array } | null): void;
  setBuilding(on: boolean): void;
  /** Куда на земле указывает курсор. null — мимо земли. */
  pick(event: PointerEvent | MouseEvent): Point2 | null;
  /** Обратное: где место мира оказывается на экране. */
  project(x: number, z: number): { x: number; y: number };
  /** Показать рёбра треугольников: видно, из чего на самом деле сделан мир. */
  setWire(on: boolean): void;
  wire(): boolean;
  /** Показать сеть движения: полосы и стрелки «откуда куда можно». */
  setTraffic(traffic: Traffic | null): void;
}

/** Ракурс, заданный числами в адресе: ?from=x,y,z&at=x,y,z — чтобы навестись куда угодно. */
export function viewFromQuery(query: URLSearchParams): View | null {
  const triple = (name: string): [number, number, number] | null => {
    const raw = query.get(name);
    if (!raw) return null;
    const parts = raw.split(',').map(Number);
    return parts.length === 3 && parts.every((n) => Number.isFinite(n)) ? [parts[0], parts[1], parts[2]] : null;
  };
  const from = triple('from');
  const at = triple('at');
  if (!from || !at) return null;
  return { label: 'наводка', from, at, fog: Number(query.get('fog') ?? 400) };
}

/** Показывать ли рёбра треугольников сразу: ?wire=1. Дальше — кнопкой. */
const START_WIRE = new URLSearchParams(location.search).get('wire') === '1';

export function show(surface: Surface, startView: string, custom: View | null = null): Viewer {
  const renderer = new THREE.WebGLRenderer({ antialias: true });
  renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
  renderer.setSize(innerWidth, innerHeight);
  renderer.shadowMap.enabled = true;
  renderer.shadowMap.type = THREE.PCFSoftShadowMap;
  document.body.prepend(renderer.domElement);

  const scene = new THREE.Scene();
  scene.background = new THREE.Color(0x9fc4dd);
  const fog = new THREE.Fog(0x9fc4dd, 200, 480);
  scene.fog = fog;

  const ground = new THREE.Mesh(new THREE.BufferGeometry(), [] as THREE.Material[]);
  ground.castShadow = true;
  ground.receiveShadow = true;
  scene.add(ground);

  // Сетка рёбер поверх поверхности: та же геометрия, просто видно швы
  const wire = new THREE.LineSegments(
    new THREE.BufferGeometry(),
    new THREE.LineBasicMaterial({ color: 0x14181a, transparent: true, opacity: 0.55 }),
  );
  wire.visible = START_WIRE;
  scene.add(wire);
  let wireOn = START_WIRE;

  // Сеть движения поверх асфальта. Отдельным объектом, а не частью поверхности:
  // это не покрытие, а правила, и класть их в замкнутую поверхность нельзя —
  // тогда проверка целости считала бы стрелку дыркой.
  const paths = new THREE.Mesh(
    new THREE.BufferGeometry(),
    new THREE.MeshBasicMaterial({ vertexColors: true, side: THREE.DoubleSide, depthWrite: false }),
  );
  paths.visible = false;
  paths.renderOrder = 3;
  scene.add(paths);

  let lastGeometry: THREE.BufferGeometry | null = null;

  const applySurface = (next: Surface): void => {
    ground.geometry.dispose();
    (ground.material as THREE.Material[]).forEach((m) => m.dispose());

    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute('position', new THREE.BufferAttribute(next.positions, 3));
    geometry.setIndex(new THREE.BufferAttribute(next.indices, 1));
    geometry.computeVertexNormals();
    const normals = geometry.getAttribute('normal').array as Float32Array;
    geometry.setAttribute('color', new THREE.BufferAttribute(shade(next, normals), 3));

    const materials = next.groups.map((group, i) => {
      geometry.addGroup(group.start, group.count, i);
      return new THREE.MeshStandardMaterial({
        vertexColors: true,
        roughness: group.material === 'marking' ? 0.7 : 0.96,
        metalness: 0,
        // краска лежит на асфальте: пусть всегда ложится поверх него, а не
        // спорит с ним за пиксель
        polygonOffset: group.material === 'marking',
        polygonOffsetFactor: -2,
        polygonOffsetUnits: -2,
      });
    });
    ground.geometry = geometry;
    ground.material = materials;

    wire.geometry.dispose();
    wire.geometry = wireOn ? new THREE.WireframeGeometry(geometry) : new THREE.BufferGeometry();
    lastGeometry = geometry;
  };
  applySurface(surface);

  const ghost = new THREE.Mesh(
    new THREE.BufferGeometry(),
    new THREE.MeshBasicMaterial({ color: 0xffe98a, transparent: true, opacity: 0.62, depthWrite: false }),
  );
  ghost.visible = false;
  ghost.renderOrder = 2;
  ghost.position.y = 0.12;
  scene.add(ghost);

  scene.add(new THREE.HemisphereLight(0xbdd7ee, 0x51603f, 1.05));
  const sun = new THREE.DirectionalLight(0xfff3dd, 2.1);
  sun.position.set(-90, 110, -60);
  sun.castShadow = true;
  sun.shadow.mapSize.set(2048, 2048);
  const shadowBox = sun.shadow.camera;
  shadowBox.left = -170; shadowBox.right = 170; shadowBox.top = 170; shadowBox.bottom = -170;
  shadowBox.near = 1; shadowBox.far = 420;
  scene.add(sun);

  const camera = new THREE.PerspectiveCamera(48, innerWidth / innerHeight, 0.5, 1400);
  const controls = new OrbitControls(camera, renderer.domElement);
  controls.enableDamping = true;
  controls.maxPolarAngle = Math.PI * 0.495;

  const LOOKING = { LEFT: THREE.MOUSE.ROTATE, MIDDLE: THREE.MOUSE.DOLLY, RIGHT: THREE.MOUSE.PAN };
  const BUILDING = { LEFT: null, MIDDLE: THREE.MOUSE.DOLLY, RIGHT: THREE.MOUSE.ROTATE };
  controls.mouseButtons = { ...LOOKING };

  let flight: { from: THREE.Vector3; to: THREE.Vector3; look: THREE.Vector3; at: THREE.Vector3; fog: number; t: number } | null = null;

  const apply = (view: View, instant: boolean): void => {
    const to = new THREE.Vector3(...view.from);
    const at = new THREE.Vector3(...view.at);
    if (instant) {
      camera.position.copy(to);
      controls.target.copy(at);
      fog.far = view.fog;
      fog.near = view.fog * 0.42;
      controls.update();
      return;
    }
    flight = { from: camera.position.clone(), to, look: controls.target.clone(), at, fog: view.fog, t: 0 };
  };
  apply(custom ?? VIEWS[startView] ?? VIEWS.road, true);

  addEventListener('resize', () => {
    camera.aspect = innerWidth / innerHeight;
    camera.updateProjectionMatrix();
    renderer.setSize(innerWidth, innerHeight);
  });
  renderer.domElement.addEventListener('contextmenu', (e) => e.preventDefault());

  const raycaster = new THREE.Raycaster();
  const pointer = new THREE.Vector2();

  const clock = new THREE.Clock();
  renderer.setAnimationLoop(() => {
    const dt = clock.getDelta();
    if (flight) {
      flight.t = Math.min(1, flight.t + dt * 1.4);
      const e = flight.t < 0.5 ? 2 * flight.t * flight.t : 1 - Math.pow(-2 * flight.t + 2, 2) / 2;
      camera.position.lerpVectors(flight.from, flight.to, e);
      controls.target.lerpVectors(flight.look, flight.at, e);
      fog.far += (flight.fog - fog.far) * e * 0.25;
      fog.near = fog.far * 0.42;
      if (flight.t >= 1) flight = null;
    }
    controls.update();
    renderer.render(scene, camera);
  });

  return {
    setView(name) {
      const view = name === 'наводка' && custom ? custom : VIEWS[name];
      if (view) apply(view, false);
    },
    setSurface(next) {
      applySurface(next);
    },
    setGhost(mesh) {
      ghost.geometry.dispose();
      if (!mesh || mesh.indices.length === 0) {
        ghost.geometry = new THREE.BufferGeometry();
        ghost.visible = false;
        return;
      }
      const geometry = new THREE.BufferGeometry();
      geometry.setAttribute('position', new THREE.BufferAttribute(mesh.positions, 3));
      geometry.setIndex(new THREE.BufferAttribute(mesh.indices, 1));
      ghost.geometry = geometry;
      ghost.visible = true;
    },
    setBuilding(on) {
      controls.mouseButtons = on ? { ...BUILDING } : { ...LOOKING };
      renderer.domElement.style.cursor = on ? 'crosshair' : '';
      if (!on) {
        ghost.visible = false;
      }
    },
    setWire(on) {
      wireOn = on;
      wire.visible = on;
      wire.geometry.dispose();
      wire.geometry = on && lastGeometry ? new THREE.WireframeGeometry(lastGeometry) : new THREE.BufferGeometry();
    },
    wire() {
      return wireOn;
    },
    setTraffic(traffic) {
      paths.geometry.dispose();
      if (!traffic || traffic.lanes.length === 0) {
        paths.geometry = new THREE.BufferGeometry();
        paths.visible = false;
        return;
      }
      const { positions, colors } = trafficMesh(traffic);
      const geometry = new THREE.BufferGeometry();
      geometry.setAttribute('position', new THREE.BufferAttribute(positions, 3));
      geometry.setAttribute('color', new THREE.BufferAttribute(colors, 3));
      paths.geometry = geometry;
      paths.visible = true;
    },
    project(x, z) {
      const hit = new THREE.Raycaster();
      hit.set(new THREE.Vector3(x, 400, z), new THREE.Vector3(0, -1, 0));
      const ground = hit.intersectObject(scene.children[0] as THREE.Object3D, false)[0];
      const point = new THREE.Vector3(x, ground ? ground.point.y : 0, z).project(camera);
      const rect = renderer.domElement.getBoundingClientRect();
      return {
        x: rect.left + ((point.x + 1) / 2) * rect.width,
        y: rect.top + ((1 - point.y) / 2) * rect.height,
      };
    },
    pick(event) {
      const rect = renderer.domElement.getBoundingClientRect();
      pointer.x = ((event.clientX - rect.left) / rect.width) * 2 - 1;
      pointer.y = -((event.clientY - rect.top) / rect.height) * 2 + 1;
      raycaster.setFromCamera(pointer, camera);
      const hit = raycaster.intersectObject(ground, false)[0];
      return hit ? { x: hit.point.x, z: hit.point.z } : null;
    },
  };
}
