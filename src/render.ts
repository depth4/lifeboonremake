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

/** Ракурсы для снимков: имя -> откуда смотрим, куда смотрим, дальность тумана. */
const VIEWS: Record<string, { from: [number, number, number]; at: [number, number, number]; fog: number }> = {
  over: { from: [-210, 155, -205], at: [0, -2, 0], fog: 900 },
  road: { from: [-118, 52, -128], at: [15, 2, 8], fog: 480 },
  close: { from: [-24, 16, -46], at: [26, 1, 18], fog: 320 },
};

export function show(surface: Surface): void {
  const wanted = new URLSearchParams(location.search).get('view') ?? 'road';
  const view = VIEWS[wanted] ?? VIEWS.road;
  const renderer = new THREE.WebGLRenderer({ antialias: true });
  renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
  renderer.setSize(innerWidth, innerHeight);
  renderer.shadowMap.enabled = true;
  renderer.shadowMap.type = THREE.PCFSoftShadowMap;
  document.body.appendChild(renderer.domElement);

  const scene = new THREE.Scene();
  scene.background = new THREE.Color(0x9fc4dd);
  scene.fog = new THREE.Fog(0x9fc4dd, view.fog * 0.45, view.fog);

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
  const s = sun.shadow.camera;
  s.left = -170; s.right = 170; s.top = 170; s.bottom = -170; s.near = 1; s.far = 420;
  scene.add(sun);

  const camera = new THREE.PerspectiveCamera(48, innerWidth / innerHeight, 0.5, 1400);
  camera.position.set(...view.from);

  const controls = new OrbitControls(camera, renderer.domElement);
  controls.target.set(...view.at);
  controls.enableDamping = true;
  controls.update();

  addEventListener('resize', () => {
    camera.aspect = innerWidth / innerHeight;
    camera.updateProjectionMatrix();
    renderer.setSize(innerWidth, innerHeight);
  });

  renderer.setAnimationLoop(() => {
    controls.update();
    renderer.render(scene, camera);
  });
}
