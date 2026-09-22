/**
 * НАБРОСОК, не часть проекта. Три стиля картинки поверх того же города,
 * чтобы Алекс выбрал глазами: `?стиль=свет`, `?стиль=пиксели`, `?стиль=камера`.
 * Геометрия не меняется ни на треугольник — меняется только свет и проход после кадра.
 */
import * as THREE from 'three';
import { EffectComposer } from 'three/examples/jsm/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/examples/jsm/postprocessing/RenderPass.js';
import { ShaderPass } from 'three/examples/jsm/postprocessing/ShaderPass.js';
import { OutputPass } from 'three/examples/jsm/postprocessing/OutputPass.js';
import { UnrealBloomPass } from 'three/examples/jsm/postprocessing/UnrealBloomPass.js';
import { GTAOPass } from 'three/examples/jsm/postprocessing/GTAOPass.js';
import { RenderPixelatedPass } from 'three/examples/jsm/postprocessing/RenderPixelatedPass.js';
import { Sky } from 'three/examples/jsm/objects/Sky.js';

const VERT = /* glsl */`varying vec2 vUv; void main(){ vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position,1.0); }`;

/** Цветокоррекция в экранном пространстве: насыщенность, контраст, тон, виньетка. */
const GRADE = {
  uniforms: {
    tDiffuse: { value: null },
    sat: { value: 1.15 }, contrast: { value: 1.1 },
    tint: { value: new THREE.Vector3(1.04, 1.0, 0.94) },
    vig: { value: 0.35 },
  },
  vertexShader: VERT,
  fragmentShader: /* glsl */`
    uniform sampler2D tDiffuse; uniform float sat, contrast, vig; uniform vec3 tint; varying vec2 vUv;
    void main(){
      vec3 c = texture2D(tDiffuse, vUv).rgb;
      float l = dot(c, vec3(0.2126,0.7152,0.0722));
      c = mix(vec3(l), c, sat);
      c = (c - 0.5) * contrast + 0.5;
      c *= tint;
      vec2 d = vUv - 0.5; c *= 1.0 - vig * dot(d, d) * 2.2;
      gl_FragColor = vec4(clamp(c, 0.0, 1.0), 1.0);
    }`,
};

/** Мало цветов и упорядоченный шум (дизеринг) по крупным пикселям. */
const DITHER = {
  uniforms: {
    tDiffuse: { value: null }, pixel: { value: 4.0 }, levels: { value: 11.0 },
  },
  vertexShader: VERT,
  fragmentShader: /* glsl */`
    uniform sampler2D tDiffuse; uniform float pixel, levels; varying vec2 vUv;
    float bayer(vec2 p){
      int x = int(mod(p.x, 4.0)); int y = int(mod(p.y, 4.0));
      int m[16] = int[16](0,8,2,10, 12,4,14,6, 3,11,1,9, 15,7,13,5);
      return float(m[y*4+x]) / 16.0;
    }
    void main(){
      vec3 c = texture2D(tDiffuse, vUv).rgb;
      vec2 p = floor(gl_FragCoord.xy / pixel);
      float t = bayer(p) - 0.5;
      c = floor(c * levels + t + 0.5) / levels;
      vec2 d = vUv - 0.5; c *= 1.0 - 0.55 * dot(d, d) * 2.0;
      gl_FragColor = vec4(c, 1.0);
    }`,
};

/** Нагрудная камера: рыбий глаз, радуга по краям, зерно, пересвет, зеленоватый тон. */
const BODYCAM = {
  uniforms: { tDiffuse: { value: null }, time: { value: 0 }, aspect: { value: 16 / 9 } },
  vertexShader: VERT,
  fragmentShader: /* glsl */`
    uniform sampler2D tDiffuse; uniform float time, aspect; varying vec2 vUv;
    float hash(vec2 p){ return fract(sin(dot(p, vec2(12.9898,78.233))) * 43758.5453); }
    vec2 warp(vec2 uv, float k){
      vec2 p = uv * 2.0 - 1.0; p.x *= aspect;
      float r2 = dot(p, p) / (aspect*aspect);
      p *= 0.93 * (1.0 + k * r2);
      p.x /= aspect; return p * 0.5 + 0.5;
    }
    void main(){
      vec2 ur = warp(vUv, 0.20), ug = warp(vUv, 0.18), ub = warp(vUv, 0.16);
      vec3 c = vec3(texture2D(tDiffuse, ur).r, texture2D(tDiffuse, ug).g, texture2D(tDiffuse, ub).b);
      if (ug.x < 0.0 || ug.x > 1.0 || ug.y < 0.0 || ug.y > 1.0) c = vec3(0.0);
      float l = dot(c, vec3(0.2126,0.7152,0.0722));
      c = mix(vec3(l), c, 0.62);
      c = pow(c, vec3(1.05)) * 1.02;
      c *= vec3(0.93, 1.03, 0.95);
      c += (hash(vUv * 900.0 + time) - 0.5) * 0.09;
      c = floor(c * 48.0) / 48.0;
      vec2 d = vUv - 0.5; c *= 1.0 - 1.1 * pow(dot(d, d) * 2.0, 1.4);
      gl_FragColor = vec4(clamp(c, 0.0, 1.0), 1.0);
    }`,
};

/** Направить солнце и тень туда, куда смотрит кадр: иначе тень есть только у центра мира. */
function солнцеНад(sun: THREE.DirectionalLight, scene: THREE.Scene, куда: THREE.Vector3, откуда: THREE.Vector3, сила: number, цвет: number): void {
  sun.color.set(цвет);
  sun.intensity = сила;
  sun.target.position.copy(куда);
  scene.add(sun.target);
  sun.position.copy(куда).addScaledVector(откуда.clone().normalize(), 300);
  const b = sun.shadow.camera;
  b.left = -160; b.right = 160; b.top = 160; b.bottom = -160; b.near = 1; b.far = 700;
  b.updateProjectionMatrix();
  sun.shadow.mapSize.set(4096, 4096);
  sun.shadow.bias = -0.0004;
  sun.shadow.normalBias = 0.6;
  sun.shadow.map?.dispose();
  (sun.shadow as { map: unknown }).map = null;
}

/** Сумерки: треть окон горит тёплым, остальные темнеют. Окна — самая большая пачка без освещения. */
function зажечьОкна(scene: THREE.Scene): boolean {
  let окна: THREE.InstancedMesh | null = null;
  scene.traverse((o) => {
    const im = o as THREE.InstancedMesh;
    if (im.isInstancedMesh && (im.material as THREE.Material).type === 'MeshBasicMaterial' && im.count > 1000
      && (окна === null || im.count > окна.count)) окна = im;
  });
  if (окна === null) return false;
  const ок = окна as THREE.InstancedMesh;
  const тёплый = new THREE.Color(0xffc46e), тёмный = new THREE.Color(0x1b2233);
  for (let i = 0; i < ок.count; i++) {
    const r = Math.sin(i * 12.9898) * 43758.5453; const t = r - Math.floor(r);
    ок.setColorAt(i, t < 0.33 ? тёплый : тёмный);
  }
  if (ок.instanceColor) ок.instanceColor.needsUpdate = true;
  return true;
}

export function подключитьСтиль(
  имя: string | null,
  renderer: THREE.WebGLRenderer,
  scene: THREE.Scene,
  camera: THREE.PerspectiveCamera,
  sun: THREE.DirectionalLight,
  fog: THREE.Fog,
): (() => void) | null {
  if (!имя) return null;
  const at = new URLSearchParams(location.search).get('at')?.split(',').map(Number) ?? [0, 0, 0];
  const куда = new THREE.Vector3(at[0], at[1], at[2]);
  const hemi = scene.children.find((o) => (o as THREE.HemisphereLight).isHemisphereLight) as THREE.HemisphereLight | undefined;
  const composer = new EffectComposer(renderer);
  const w = innerWidth, h = innerHeight;

  if (имя === 'свет') {
    // закатное солнце вдоль улицы: длинные тени, тёплый свет, холодная тень
    const откуда = new THREE.Vector3(0.8, 0.28, 0.75);
    солнцеНад(sun, scene, куда, откуда, 4.2, 0xffc48a);
    if (hemi) { hemi.color.set(0x9dbde8); hemi.groundColor.set(0x8a7058); hemi.intensity = 1.9; }
    const sky = new Sky();
    sky.scale.setScalar(1000);
    const u = sky.material.uniforms;
    u.turbidity.value = 6; u.rayleigh.value = 1.6; u.mieCoefficient.value = 0.006; u.mieDirectionalG.value = 0.86;
    u.sunPosition.value.copy(откуда).normalize();
    scene.add(sky);
    fog.color.set(0xe3c3a3); fog.near = 90; fog.far = 700;
    renderer.toneMapping = THREE.ACESFilmicToneMapping;
    renderer.toneMappingExposure = 0.9;
    composer.addPass(new RenderPass(scene, camera));
    const ao = new GTAOPass(scene, camera, w, h);
    ao.updateGtaoMaterial({ radius: 2.5, distanceExponent: 1.5, thickness: 2, scale: 1.0, samples: 16 });
    ao.blendIntensity = 1.0;
    composer.addPass(ao);
    composer.addPass(new UnrealBloomPass(new THREE.Vector2(w, h), 0.35, 0.6, 0.85));
    composer.addPass(new OutputPass());
    composer.addPass(new ShaderPass(GRADE));
  } else if (имя === 'пиксели') {
    // сумерки, плотный туман, крупный пиксель, мало цветов
    солнцеНад(sun, scene, куда, new THREE.Vector3(-0.6, 0.3, 0.8), 2.6, 0xff9a6a);
    if (hemi) { hemi.color.set(0x7080b8); hemi.groundColor.set(0x3a3430); hemi.intensity = 1.9; }
    scene.background = new THREE.Color(0x4e5a88);
    fog.color.set(0x4e5a88); fog.near = 30; fog.far = 230;
    renderer.toneMapping = THREE.NoToneMapping;
    const px = 4;
    const pass = new RenderPixelatedPass(px, scene, camera, { normalEdgeStrength: 0.35, depthEdgeStrength: 0.5 });
    composer.addPass(pass);
    composer.addPass(new OutputPass());
    const d = new ShaderPass(DITHER);
    d.uniforms.pixel.value = px * renderer.getPixelRatio();
    composer.addPass(d);
    let окнаГорят = false;
    return () => {
      if (!окнаГорят) окнаГорят = зажечьОкна(scene);
      composer.render();
    };
  } else if (имя === 'камера') {
    // пасмурный день, камера на груди, широкий угол, лёгкий завал горизонта
    солнцеНад(sun, scene, куда, new THREE.Vector3(-0.4, 0.8, 0.5), 1.5, 0xf2f0ea);
    if (hemi) { hemi.color.set(0xd6dde4); hemi.groundColor.set(0x4a4a42); hemi.intensity = 1.6; }
    scene.background = new THREE.Color(0xdfe4e8);
    fog.color.set(0xcfd5d8); fog.near = 60; fog.far = 420;
    renderer.toneMapping = THREE.ACESFilmicToneMapping;
    renderer.toneMappingExposure = 1.0;
    camera.fov = 78; camera.updateProjectionMatrix();
    composer.addPass(new RenderPass(scene, camera));
    composer.addPass(new OutputPass());
    const cam = new ShaderPass(BODYCAM);
    cam.uniforms.aspect.value = w / h;
    composer.addPass(cam);
    const tag = document.createElement('div');
    tag.textContent = 'CAM 07   2026-09-22   21:47:13   ● REC';
    tag.style.cssText = 'position:fixed;top:34px;right:120px;z-index:99;font:600 26px/1 monospace;color:#f4f4f0;letter-spacing:1px;text-shadow:0 0 3px #000,0 0 1px #000;opacity:.92';
    document.body.append(tag);
    const clock = new THREE.Clock();
    return () => {
      cam.uniforms.time.value = clock.getElapsedTime();
      camera.rotation.z = -0.035;
      composer.render();
    };
  } else {
    return null;
  }
  return () => composer.render();
}
