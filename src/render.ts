/**
 * Показ мира на экране. Читает готовую поверхность и рисует её.
 * Ничем не владеет: если этот файл убрать, мир останется целым.
 */

import * as THREE from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import type { Material, Surface } from './surface.ts';

const COLORS: Record<Material, number> = {
  grass: 0x5f8a4a,
  asphalt: 0x40444a,
  sidewalk: 0x9a988f,
  marking: 0xe8e4d2,
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
  close: { label: 'вблизи', from: [-24, 16, -46], at: [26, 1, 18], fog: 320 },
};

export interface Viewer {
  setView(name: string): void;
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

  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.BufferAttribute(surface.positions, 3));
  geometry.setIndex(new THREE.BufferAttribute(surface.indices, 1));

  const materials: THREE.Material[] = [];
  surface.groups.forEach((group, i) => {
    geometry.addGroup(group.start, group.count, i);
    materials.push(new THREE.MeshStandardMaterial({ color: COLORS[group.material], roughness: 0.95, metalness: 0 }));
  });
  geometry.computeVertexNormals();

  const ground = new THREE.Mesh(geometry, materials);
  ground.castShadow = true;
  ground.receiveShadow = true;
  scene.add(ground);

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

  // плавный перелёт между ракурсами
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

  const clock = new THREE.Clock();
  renderer.setAnimationLoop(() => {
    if (flight) {
      flight.t = Math.min(1, flight.t + clock.getDelta() * 1.4);
      const e = flight.t < 0.5 ? 2 * flight.t * flight.t : 1 - Math.pow(-2 * flight.t + 2, 2) / 2;
      camera.position.lerpVectors(flight.from, flight.to, e);
      controls.target.lerpVectors(flight.look, flight.at, e);
      fog.far = fog.far + (flight.fog - fog.far) * e * 0.25;
      fog.near = fog.far * 0.42;
      if (flight.t >= 1) flight = null;
    } else {
      clock.getDelta();
    }
    controls.update();
    renderer.render(scene, camera);
  });

  return {
    setView(name: string): void {
      const view = VIEWS[name];
      if (view) apply(view, false);
    },
  };
}
