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

interface View {
  readonly label: string;
  readonly from: [number, number, number];
  readonly at: [number, number, number];
  readonly fog: number;
}

/** Ракурсы: и для кнопок на странице, и для снимков из терминала. */
export const VIEWS: Record<string, View> = {
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
}

export function show(surface: Surface, startView: string): Viewer {
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

  const applySurface = (next: Surface): void => {
    ground.geometry.dispose();
    (ground.material as THREE.Material[]).forEach((m) => m.dispose());

    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute('position', new THREE.BufferAttribute(next.positions, 3));
    geometry.setIndex(new THREE.BufferAttribute(next.indices, 1));
    const materials = next.groups.map((group, i) => {
      geometry.addGroup(group.start, group.count, i);
      return new THREE.MeshStandardMaterial({ color: COLORS[group.material], roughness: 0.95, metalness: 0 });
    });
    geometry.computeVertexNormals();
    ground.geometry = geometry;
    ground.material = materials;
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
  apply(VIEWS[startView] ?? VIEWS.road, true);

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
      const view = VIEWS[name];
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
