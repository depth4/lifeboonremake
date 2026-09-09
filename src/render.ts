/**
 * Показ мира на экране. Читает готовую поверхность и рисует её.
 * Ничем не владеет: если этот файл убрать, мир останется целым.
 */

import * as THREE from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import type { Material, Surface } from './surface/index.ts';
import type { Point2 } from './world/road.ts';

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

/** Что показу нужно знать о машине. Ни грамма физики — только поза. */
export interface CarView {
  readonly x: number;
  readonly y: number;
  readonly z: number;
  readonly yaw: number;
  readonly pitch: number;
  readonly roll: number;
  /** Скорость вдоль носа, м/с — камере, чтобы отъезжать на быстром ходу. */
  readonly speed: number;
  readonly wheels: readonly {
    readonly x: number; readonly y: number; readonly z: number;
    readonly steer: number; readonly spin: number;
    readonly radius: number; readonly width: number;
  }[];
}

/**
 * Кузов: боковой силуэт, выдавленный на ширину машины. Так низкая длинная
 * машина читается с любого ракурса, а коробка — нет.
 */
function buildBody(length: number, width: number): THREE.BufferGeometry {
  const nose = length / 2;
  // Силуэт сбоку в метрах над землёй: длинный капот, кабина сдвинута назад,
  // короткий хвост. Обход против часовой стрелки, начиная с носа снизу.
  const points: [number, number][] = [
    [nose - 0.08, 0.16], [nose, 0.34], [nose - 0.55, 0.56], [nose - 1.35, 0.66],
    [nose - 2.05, 0.80], [nose - 2.45, 1.19], [nose - 3.10, 1.21], [nose - 3.55, 0.86],
    [-nose + 0.35, 0.76], [-nose, 0.60], [-nose - 0.02, 0.30], [-nose + 0.35, 0.14],
  ];
  const side = new THREE.Shape();
  side.moveTo(points[0][0], points[0][1]);
  for (const [x, y] of points.slice(1)) side.lineTo(x, y);
  side.closePath();

  // Кузов рисуется чуть уже настоящего: иначе колёса тонут в нём, а колея —
  // величина физическая, её подгонять под картинку нельзя.
  const depth = width - 0.24;
  const geometry = new THREE.ExtrudeGeometry(side, {
    depth, bevelEnabled: true, bevelSize: 0.08, bevelThickness: 0.07, bevelSegments: 2,
  });
  geometry.translate(0, 0, -depth / 2);
  geometry.computeVertexNormals();
  return geometry;
}

/** Простой силуэт городской машины — не Viper: трафик должен отличаться. */
function buildSedan(length: number, width: number): THREE.BufferGeometry {
  const nose = length / 2;
  const points: [number, number][] = [
    [nose - 0.05, 0.22], [nose, 0.42], [nose - 0.75, 0.62], [nose - 1.25, 0.78],
    [nose - 1.75, 1.28], [nose - 2.85, 1.30], [nose - 3.35, 0.80],
    [-nose + 0.25, 0.72], [-nose, 0.5], [-nose - 0.02, 0.26], [-nose + 0.3, 0.16],
  ];
  const side = new THREE.Shape();
  side.moveTo(points[0][0], points[0][1]);
  for (const [x, y] of points.slice(1)) side.lineTo(x, y);
  side.closePath();
  const depth = width - 0.2;
  const geometry = new THREE.ExtrudeGeometry(side, {
    depth, bevelEnabled: true, bevelSize: 0.07, bevelThickness: 0.06, bevelSegments: 2,
  });
  geometry.translate(0, 0, -depth / 2);
  geometry.computeVertexNormals();
  return geometry;
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
  /** Поставить машину в мир. null — убрать. */
  setCar(view: CarView | null): void;
  /** Камера за машиной вместо облёта. */
  setChase(on: boolean): void;
  /** Откуда смотреть за рулём: сзади или с места водителя. */
  setEye(from: 'сзади' | 'из салона'): void;
  /** Позвать это каждый кадр: сюда main двигает физику. */
  onFrame(cb: (dt: number) => void): void;
  /** Трафик: положения чужих машин. Пустой список — убрать всех. */
  setTraffic(cars: readonly { x: number; y: number; z: number; yaw: number; colour: number }[]): void;
  /** Светофоры: где стоят и каким цветом горят. */
  setSignals(lamps: readonly { x: number; y: number; z: number; yaw: number; colour: number }[]): void;
  /** Пешеходы. */
  setWalkers(people: readonly { x: number; y: number; z: number; yaw: number; colour: number }[]): void;
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

  // ── машина: собирается один раз, дальше только двигается
  const carGroup = new THREE.Group();
  carGroup.visible = false;
  const body = new THREE.Mesh(
    new THREE.BufferGeometry(),
    new THREE.MeshStandardMaterial({ color: 0xb3121d, roughness: 0.35, metalness: 0.25 }),
  );
  body.castShadow = true;
  carGroup.add(body);
  // остекление: тёмная лента чуть шире кузова на высоте кабины
  const glass = new THREE.Mesh(
    new THREE.BoxGeometry(1.32, 0.42, 1.76),
    new THREE.MeshStandardMaterial({ color: 0x1b2226, roughness: 0.16, metalness: 0.35 }),
  );
  glass.position.set(-0.42, 0.94, 0);
  body.add(glass);
  /**
   * Салон: торпедо и руль. Нужны не для красоты — без них вид «из салона»
   * читается как летящая камера, и по рулю не видно, что делают колёса.
   * Руль поворачивается на настоящий угол, помноженный на передаточное
   * число рулевой: 25.9° на колёсах это 432° на руле.
   */
  const interior = new THREE.Group();
  interior.visible = false;
  const dash = new THREE.Mesh(
    new THREE.BoxGeometry(0.7, 0.3, 1.55),
    new THREE.MeshStandardMaterial({ color: 0x1a1d21, roughness: 0.9 }),
  );
  dash.position.set(0.78, 0.8, 0);
  interior.add(dash);
  const hoodTop = new THREE.Mesh(
    new THREE.BoxGeometry(1.5, 0.06, 1.6),
    new THREE.MeshStandardMaterial({ color: 0x8e1420, roughness: 0.4, metalness: 0.2 }),
  );
  hoodTop.position.set(1.6, 0.74, 0);
  interior.add(hoodTop);
  const rim = new THREE.Mesh(
    new THREE.TorusGeometry(0.155, 0.019, 8, 24),
    new THREE.MeshStandardMaterial({ color: 0x14161a, roughness: 0.7 }),
  );
  const spoke = new THREE.Mesh(
    new THREE.BoxGeometry(0.3, 0.02, 0.035),
    new THREE.MeshStandardMaterial({ color: 0x22262b, roughness: 0.8 }),
  );
  const steering = new THREE.Group();
  steering.add(rim, spoke);
  steering.position.set(0.34, 0.83, -0.38);
  steering.rotation.set(0, Math.PI / 2, -Math.PI / 9);
  interior.add(steering);
  body.add(interior);

  const wheelParts: { hub: THREE.Group; tyre: THREE.Mesh }[] = [];
  scene.add(carGroup);
  let bodyBuilt = 0;

  const wheelMaterial = new THREE.MeshStandardMaterial({ color: 0x15171a, roughness: 0.85 });
  const rimMaterial = new THREE.MeshStandardMaterial({ color: 0x9aa0a6, roughness: 0.35, metalness: 0.7 });

  // ── трафик: все чужие машины одной пачкой, иначе на тридцати штуках
  // видеокарта задыхается от отдельных вызовов
  let trafficBody: THREE.InstancedMesh | null = null;
  let trafficWheels: THREE.InstancedMesh | null = null;
  let signalPoles: THREE.InstancedMesh | null = null;
  let signalHeads: THREE.InstancedMesh | null = null;
  let walkerMesh: THREE.InstancedMesh | null = null;

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

  let onFrameCb: ((dt: number) => void) | null = null;
  let chase = false;
  let eye: 'сзади' | 'из салона' = 'сзади';
  const chaseEye = new THREE.Vector3();
  const chaseAim = new THREE.Vector3();
  let chaseReady = false;

  const clock = new THREE.Clock();
  renderer.setAnimationLoop(() => {
    const dt = Math.min(0.1, clock.getDelta());
    if (onFrameCb) onFrameCb(dt);
    if (chase && carGroup.visible && eye === 'из салона') {
      /**
       * Из салона. Точка взгляда берётся ИЗ САМОГО КУЗОВА: он уже наклонён
       * подвеской, значит голова водителя качается вместе с машиной сама,
       * без единого отдельного коэффициента «тряски».
       */
      carGroup.updateMatrixWorld(true);
      const head = body.localToWorld(new THREE.Vector3(-0.52, 1.16, -0.38));
      const look = body.localToWorld(new THREE.Vector3(24, 1.06, -0.38));
      camera.position.copy(head);
      camera.up.copy(body.localToWorld(new THREE.Vector3(-0.52, 2.16, -0.38)).sub(head).normalize());
      camera.lookAt(look);
      renderer.render(scene, camera);
      return;
    }
    if (chase && carGroup.visible) {
      const ahead = new THREE.Vector3(Math.cos(carGroup.userData.yaw as number), 0, Math.sin(carGroup.userData.yaw as number));
      const speed = (carGroup.userData.speed as number) ?? 0;
      // на скорости камера отъезжает назад: так виден запас дороги впереди
      const back = 7.2 + Math.min(4, Math.abs(speed) * 0.11);
      const eye = carGroup.position.clone().addScaledVector(ahead, -back).add(new THREE.Vector3(0, 2.85, 0));
      const aim = carGroup.position.clone().addScaledVector(ahead, 7).add(new THREE.Vector3(0, 0.9, 0));
      if (!chaseReady) { chaseEye.copy(eye); chaseAim.copy(aim); chaseReady = true; }
      const k = 1 - Math.exp(-dt * 7);
      chaseEye.lerp(eye, k);
      chaseAim.lerp(aim, k);
      camera.position.copy(chaseEye);
      camera.lookAt(chaseAim);
      renderer.render(scene, camera);
      return;
    }
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
    setCar(view) {
      if (view === null) { carGroup.visible = false; return; }
      if (bodyBuilt !== view.wheels.length || wheelParts.length === 0) {
        body.geometry.dispose();
        body.geometry = buildBody(4.463, 1.941);
        for (const w of view.wheels) {
          const hub = new THREE.Group();
          const tyreGeometry = new THREE.CylinderGeometry(w.radius, w.radius, w.width, 22);
          tyreGeometry.rotateX(Math.PI / 2);
          const tyre = new THREE.Mesh(tyreGeometry, wheelMaterial);
          tyre.castShadow = true;
          const rimGeometry = new THREE.CylinderGeometry(w.radius * 0.62, w.radius * 0.62, w.width * 1.02, 16);
          rimGeometry.rotateX(Math.PI / 2);
          tyre.add(new THREE.Mesh(rimGeometry, rimMaterial));
          hub.add(tyre);
          scene.add(hub);
          wheelParts.push({ hub, tyre });
        }
        bodyBuilt = view.wheels.length;
      }
      carGroup.visible = true;
      carGroup.position.set(view.x, view.y, view.z);
      carGroup.rotation.set(0, -view.yaw, 0);
      body.rotation.set(view.roll, 0, view.pitch);
      carGroup.userData.yaw = view.yaw;
      carGroup.userData.speed = view.speed;
      // руль в салоне крутится на настоящий угол колёс × передаточное рулевой
      steering.rotation.z = -Math.PI / 9 - (view.wheels[0]?.steer ?? 0) * 16.7;
      view.wheels.forEach((w, i) => {
        const part = wheelParts[i];
        if (!part) return;
        part.hub.visible = true;
        part.hub.position.set(w.x, w.y + w.radius, w.z);
        part.hub.rotation.set(0, -(view.yaw + w.steer), 0);
        part.tyre.rotation.z = -w.spin;
      });
    },
    setTraffic(cars) {
      if (trafficBody !== null && trafficBody.count !== cars.length) {
        scene.remove(trafficBody, trafficWheels as THREE.Object3D);
        trafficBody.dispose();
        trafficWheels?.dispose();
        trafficBody = null;
        trafficWheels = null;
      }
      if (cars.length === 0) return;
      if (trafficBody === null) {
        trafficBody = new THREE.InstancedMesh(
          buildSedan(4.4, 1.82),
          new THREE.MeshStandardMaterial({ roughness: 0.45, metalness: 0.2 }),
          cars.length,
        );
        trafficBody.castShadow = true;
        const wheel = new THREE.CylinderGeometry(0.33, 0.33, 0.23, 14);
        wheel.rotateX(Math.PI / 2);
        trafficWheels = new THREE.InstancedMesh(wheel, wheelMaterial, cars.length * 4);
        scene.add(trafficBody, trafficWheels);
      }
      const m = new THREE.Matrix4();
      const tint = new THREE.Color();
      const corners: [number, number][] = [[1.35, 0.78], [1.35, -0.78], [-1.35, 0.78], [-1.35, -0.78]];
      cars.forEach((c, i) => {
        m.makeRotationY(-c.yaw);
        m.setPosition(c.x, c.y, c.z);
        (trafficBody as THREE.InstancedMesh).setMatrixAt(i, m);
        (trafficBody as THREE.InstancedMesh).setColorAt(i, tint.setHex(c.colour));
        const cos = Math.cos(c.yaw), sin = Math.sin(c.yaw);
        corners.forEach(([ahead, left], k) => {
          const wm = new THREE.Matrix4().makeRotationY(-c.yaw);
          wm.setPosition(c.x + ahead * cos - left * sin, c.y + 0.33, c.z + ahead * sin + left * cos);
          (trafficWheels as THREE.InstancedMesh).setMatrixAt(i * 4 + k, wm);
        });
      });
      trafficBody.instanceMatrix.needsUpdate = true;
      if (trafficBody.instanceColor) trafficBody.instanceColor.needsUpdate = true;
      (trafficWheels as THREE.InstancedMesh).instanceMatrix.needsUpdate = true;
    },
    setSignals(lamps) {
      if (signalPoles !== null && signalPoles.count !== lamps.length) {
        scene.remove(signalPoles, signalHeads as THREE.Object3D);
        signalPoles.dispose(); signalHeads?.dispose();
        signalPoles = null; signalHeads = null;
      }
      if (lamps.length === 0) return;
      if (signalPoles === null) {
        const pole = new THREE.CylinderGeometry(0.09, 0.11, 3.2, 8);
        pole.translate(0, 1.6, 0);
        signalPoles = new THREE.InstancedMesh(
          pole, new THREE.MeshStandardMaterial({ color: 0x3a4046, roughness: 0.7 }), lamps.length,
        );
        signalPoles.castShadow = true;
        // голова светофора светится сама: иначе красный в тени не отличить
        const head = new THREE.BoxGeometry(0.34, 0.9, 0.28);
        head.translate(0, 3.4, 0);
        signalHeads = new THREE.InstancedMesh(
          head, new THREE.MeshStandardMaterial({ roughness: 0.45, emissiveIntensity: 1 }), lamps.length,
        );
        scene.add(signalPoles, signalHeads);
      }
      const m = new THREE.Matrix4();
      const tint = new THREE.Color();
      lamps.forEach((l, i) => {
        m.makeRotationY(-l.yaw);
        m.setPosition(l.x, l.y, l.z);
        (signalPoles as THREE.InstancedMesh).setMatrixAt(i, m);
        (signalHeads as THREE.InstancedMesh).setMatrixAt(i, m);
        (signalHeads as THREE.InstancedMesh).setColorAt(i, tint.setHex(l.colour));
      });
      signalPoles.instanceMatrix.needsUpdate = true;
      (signalHeads as THREE.InstancedMesh).instanceMatrix.needsUpdate = true;
      if (signalHeads?.instanceColor) signalHeads.instanceColor.needsUpdate = true;
    },
    setWalkers(people) {
      if (walkerMesh !== null && walkerMesh.count !== people.length) {
        scene.remove(walkerMesh); walkerMesh.dispose(); walkerMesh = null;
      }
      if (people.length === 0) return;
      if (walkerMesh === null) {
        // человек — капсула: с любого ракурса читается как человек, а не как ящик
        const body = new THREE.CapsuleGeometry(0.22, 1.25, 4, 8);
        body.translate(0, 0.87, 0);
        walkerMesh = new THREE.InstancedMesh(
          body, new THREE.MeshStandardMaterial({ roughness: 0.85 }), people.length,
        );
        walkerMesh.castShadow = true;
        scene.add(walkerMesh);
      }
      const m = new THREE.Matrix4();
      const tint = new THREE.Color();
      people.forEach((p, i) => {
        m.makeRotationY(-p.yaw);
        m.setPosition(p.x, p.y, p.z);
        (walkerMesh as THREE.InstancedMesh).setMatrixAt(i, m);
        (walkerMesh as THREE.InstancedMesh).setColorAt(i, tint.setHex(p.colour));
      });
      walkerMesh.instanceMatrix.needsUpdate = true;
      if (walkerMesh.instanceColor) walkerMesh.instanceColor.needsUpdate = true;
    },
    setEye(from) {
      eye = from;
      // изнутри кузов не рисуем: иначе видно его изнанку. Салон — наоборот.
      body.visible = true;
      (body.material as THREE.Material).visible = from === 'сзади';
      glass.visible = from === 'сзади';
      interior.visible = from === 'из салона';
      chaseReady = false;
      camera.up.set(0, 1, 0);
    },
    setChase(on) {
      chase = on;
      chaseReady = false;
      controls.enabled = !on;
      if (!on) {
        (body.material as THREE.Material).visible = true;
        glass.visible = true;
        interior.visible = false;
        camera.up.set(0, 1, 0);
      }
      // вышел из машины — камера смотрит на машину, а не туда, где была раньше
      if (!on && carGroup.visible) {
        const ahead = new THREE.Vector3(Math.cos(carGroup.userData.yaw as number), 0, Math.sin(carGroup.userData.yaw as number));
        const side = new THREE.Vector3(-ahead.z, 0, ahead.x);
        controls.target.copy(carGroup.position).add(new THREE.Vector3(0, 0.7, 0));
        camera.position.copy(carGroup.position)
          .addScaledVector(ahead, -6.5).addScaledVector(side, 5.5).add(new THREE.Vector3(0, 3.2, 0));
        controls.update();
      }
    },
    onFrame(cb) {
      onFrameCb = cb;
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
