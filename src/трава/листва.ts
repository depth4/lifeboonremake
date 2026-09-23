/**
 * ЛИСТВА. Каждый лист — прямоугольник (или ромб), и их тысячи на дерево.
 * Устроена как трава (`показ.ts`): лист не хранится, а вычисляется из своего
 * номера и дерева. Где стоит дерево и какой оно формы, решает `city/зелень.ts`;
 * здесь только листья поверх его кроны.
 *
 * - **лист ложится на крону ровно**, без комков и дыр: номер листа — точка
 *   последовательности R2 на поверхности кроны, как у травинки. Меньше
 *   листьев вдали — меньше первых номеров, и крона редеет равномерно;
 * - **одна отрисовка на все ближние деревья**: деревья лежат строками
 *   в маленькой текстуре, лист находит своё дерево по номеру;
 * - **ветер тот же, что у травы**: крона качается целиком (основной изгиб),
 *   каждый лист дрожит на своём черешке в своей фазе (изгиб деталей —
 *   так в Crysis). Порыв, прошедший по траве, в тот же миг проходит
 *   по кронам;
 * - **свет — как у объёма**: нормаль листа наполовину смотрит наружу от
 *   кроны, поэтому крона светится как шар, а не как рябь бумажек.
 */

import * as THREE from 'three';
import type { Дерево } from '../city/зелень.ts';

/** Сколько ближних деревьев одеваются листьями. Дальше — крона как была. */
const ДЕРЕВЬЕВ = 48;
/** Листьев у дерева вблизи. */
const ЛИСТЬЕВ = 5000;
/** Дальше этого листьев нет, м. */
const ДАЛЬ = 70;

export interface ФормаЛиста {
  readonly подпись: string;
  /** Точки листа: x поперёк (−1..1), y вдоль от черешка (0..1). */
  readonly точки: readonly (readonly [number, number])[];
  readonly тр: readonly number[];
}

export const ФОРМЫ: Record<string, ФормаЛиста> = {
  прямоугольник: {
    подпись: 'лист — прямоугольник',
    точки: [[-1, 0], [1, 0], [-1, 1], [1, 1]],
    тр: [0, 1, 3, 0, 3, 2],
  },
  ромб: {
    подпись: 'лист — ромб, тоже четыре точки',
    точки: [[0, 0], [1, 0.45], [0, 1], [-1, 0.45]],
    тр: [0, 1, 2, 0, 2, 3],
  },
};
export const ПОРЯДОК_ЛИСТВЫ = ['прямоугольник', 'ромб'] as const;

/** Общее с травой: время, ветер, шум. Один ветер на всё, что растёт. */
export interface ОбщийВетер {
  readonly uTime: { value: number };
  readonly uWind: { value: number };
  readonly uWindDir: { value: THREE.Vector2 };
  readonly uNoise: { value: THREE.Texture };
}

const ВЕРШИНА = /* glsl */`
uniform float uTime;
uniform vec2 uWindDir;
uniform float uWind;
uniform sampler2D uNoise;
uniform sampler2D uTrees;
uniform float uTreeCount;
uniform float uLeaves;
uniform vec3 uCam;
uniform vec3 uSunDir;
varying vec3 vLeaf;
varying float vTrans;

uint leafHash(uint x) { x ^= x >> 16; x *= 0x7feb352du; x ^= x >> 15; x *= 0x846ca68bu; x ^= x >> 16; return x; }
float leafRnd(inout uint s) { s = leafHash(s); return float(s >> 8) / 16777216.0; }
`;

const ТЕЛО = /* glsl */`
  uint idx = uint(gl_InstanceID);
  uint slot = idx / uint(uLeaves);
  uint j = idx - slot * uint(uLeaves);
  vec3 leafP = vec3(0.0, -1.0e4, 0.0);
  vec3 objectNormal = vec3(0.0, 1.0, 0.0);
  vLeaf = vec3(0.0);
  vTrans = 0.0;
  if (float(slot) < uTreeCount) {
    // дерево: x, низ кроны, z, ширина | крона, лист, курс, густота | цвет
    vec4 a = texelFetch(uTrees, ivec2(int(slot), 0), 0);
    vec4 b = texelFetch(uTrees, ivec2(int(slot), 1), 0);
    vec4 c = texelFetch(uTrees, ivec2(int(slot), 2), 0);
    float rank = (float(j) + 0.5) / uLeaves;
    if (rank < b.w) {
      uint treeSeed = leafHash(uint(a.x * 131.0 + a.z * 71.0 + 1.0e6));
      uint s = leafHash(j * 747796405u ^ treeSeed);
      float r1 = leafRnd(s), r2 = leafRnd(s), r3 = leafRnd(s), r4 = leafRnd(s), r5 = leafRnd(s);
      // две кроны, как у ствола в render.ts: большая и верхняя поменьше
      bool upper = r5 < 0.3;
      float w = a.w, h = b.x;
      vec3 centre = upper ? vec3(a.x, a.y + h * 0.8375, a.z) : vec3(a.x, a.y + h * 0.5, a.z);
      vec3 radii = upper ? vec3(w * 0.36, h * 0.3875, w * 0.36) : vec3(w * 0.5, h * 0.5, w * 0.5);
      // R2, как у травы: любой начальный кусок номеров ложится по кроне
      // ровно, поэтому дальнее дерево редеет равномерно, а не лысеет снизу
      float u = float(j * 3242174889u + treeSeed) * (1.0 / 4294967296.0);
      float v = float(j * 2447445414u + leafHash(treeSeed)) * (1.0 / 4294967296.0);
      float y = 1.0 - 2.0 * u;
      float rr = sqrt(max(0.0, 1.0 - y * y));
      float phi = v * 6.2831853 + b.z;
      vec3 dir = vec3(rr * cos(phi), y, rr * sin(phi));
      // листья слоем в глубину кроны, а не корочкой: внутренние темнее
      float depth = 0.68 + 0.38 * sqrt(r1);
      vec3 onCrown = centre + dir * radii * depth;

      // основной изгиб: крона качается целиком, тем сильнее, чем выше
      float gust = texture(uNoise, a.xz * 0.03 - uWindDir * uTime * 0.075).r;
      float lift = clamp((onCrown.y - a.y + h * 0.3) / (h * 1.3), 0.0, 1.0);
      float sway = uWind * (0.12 + 0.5 * gust * gust) * lift * lift * h * 0.12
        + sin(uTime * (1.1 + 0.3 * r2) + a.x * 0.37) * 0.02 * uWind * lift * h;
      onCrown.xz += uWindDir * sway;

      // лист: смотрит наружу, повёрнут вокруг себя как попало
      vec3 n0 = normalize(dir + (vec3(r2, r3, r4) - 0.5) * 1.4);
      vec3 side = normalize(cross(n0, abs(n0.y) > 0.9 ? vec3(1.0, 0.0, 0.0) : vec3(0.0, 1.0, 0.0)));
      vec3 along = cross(side, n0);
      float spin = r1 * 6.2831853;
      vec3 ax = side * cos(spin) + along * sin(spin);
      vec3 ay = -side * sin(spin) + along * cos(spin);
      // дрожь: лист качается на черешке, в своей фазе и быстро
      float flap = uWind * (0.25 + 0.9 * gust) * sin(uTime * (7.0 + 5.0 * r3) + r4 * 30.0);
      ay = normalize(ay * cos(flap) + n0 * sin(flap));
      vec3 nrm = normalize(cross(ax, ay));

      // вдали листьев меньше, и каждый крупнее: крона остаётся сплошной
      float grow = inversesqrt(max(b.w, 0.05));
      // лист продолговатый: длина 20–32 см, ширина вдвое меньше
      float L = (0.2 + 0.12 * r2) * min(grow, 2.5);
      leafP = onCrown + ax * position.x * L * 0.28 + ay * position.y * L;

      // свет объёма: наполовину от кроны, наполовину от самого листа
      objectNormal = normalize(mix(nrm * sign(dot(nrm, dir) + 1e-3), dir, 0.62));
      vec3 base = c.rgb;
      float bright = 0.78 + 0.44 * r3;
      // изнанка светлее: дрожащая крона переливается
      bright *= mix(1.0, 1.25, step(0.0, -dot(nrm, uCam - leafP)));
      vec3 col = base * bright;
      col = mix(col, vec3(0.42, 0.36, 0.08), step(0.975, r4) * 0.8);
      // внутри кроны и на дальней её стороне темнее: туда не доходит небо
      float facing = smoothstep(-0.6, 0.6, dot(dir, normalize(uCam - centre)));
      col *= mix(0.45, 1.0, 0.5 * facing + 0.5 * (depth - 0.68) / 0.38);
      vLeaf = col;
      vTrans = 0.6 * pow(max(dot(normalize(leafP - uCam), uSunDir), 0.0), 4.0);
    }
  }
`;

export interface ЦенаЛиствы {
  readonly форма: string;
  readonly деревьев: number;
  readonly листьев: number;
  readonly вершин: number;
}

export interface Листва {
  деревья(список: readonly { дерево: Дерево; низ: number; цвет: THREE.Color }[]): void;
  форма(имя: string | null): void;
  котораяФорма(): string | null;
  кадр(камера: THREE.Camera): void;
  цена(): ЦенаЛиствы;
}

export function создатьЛиству(сцена: THREE.Scene, солнце: THREE.DirectionalLight, ветер: ОбщийВетер): Листва {
  const данные = new Float32Array(ДЕРЕВЬЕВ * 3 * 4);
  const текстура = new THREE.DataTexture(данные, ДЕРЕВЬЕВ, 3, THREE.RGBAFormat, THREE.FloatType);
  текстура.magFilter = текстура.minFilter = THREE.NearestFilter;
  const uniforms = {
    ...ветер,
    uTrees: { value: текстура as THREE.Texture },
    uTreeCount: { value: 0 },
    uLeaves: { value: ЛИСТЬЕВ },
    uCam: { value: new THREE.Vector3() },
    uSunDir: { value: new THREE.Vector3(0, 1, 0) },
    uSunColor: { value: new THREE.Color() },
  };
  const материал = new THREE.MeshLambertMaterial({ color: 0xffffff, side: THREE.DoubleSide });
  материал.onBeforeCompile = (shader) => {
    Object.assign(shader.uniforms, uniforms);
    shader.vertexShader = ВЕРШИНА + shader.vertexShader
      .replace('#include <beginnormal_vertex>', ТЕЛО)
      .replace('#include <begin_vertex>', 'vec3 transformed = leafP;');
    shader.fragmentShader = 'varying vec3 vLeaf;\nvarying float vTrans;\nuniform vec3 uSunColor;\n' + shader.fragmentShader
      .replace('#include <color_fragment>', 'diffuseColor.rgb *= vLeaf;')
      .replace('#include <normal_fragment_begin>',
        'float faceDirection = 1.0;\nvec3 normal = normalize( vNormal );\nvec3 nonPerturbedNormal = normal;')
      .replace('#include <envmap_fragment>', 'outgoingLight += diffuseColor.rgb * uSunColor * vTrans;');
  };
  материал.customProgramCacheKey = () => 'листва';

  let имя: string | null = null;
  let меш: THREE.Mesh | null = null;
  let все: readonly { дерево: Дерево; низ: number; цвет: THREE.Color }[] = [];
  let цена: ЦенаЛиствы = { форма: 'нет', деревьев: 0, листьев: 0, вершин: 0 };

  const задать = (новое: string | null): void => {
    if (меш !== null) { сцена.remove(меш); меш.geometry.dispose(); меш = null; }
    имя = новое !== null && ФОРМЫ[новое] ? новое : null;
    if (имя === null) return;
    const ф = ФОРМЫ[имя];
    const g = new THREE.InstancedBufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(ф.точки.flatMap(([x, y]) => [x, y, 0]), 3));
    // нормаль-пустышка: иначе three включит плоское освещение (см. показ.ts)
    g.setAttribute('normal', new THREE.Float32BufferAttribute(new Float32Array(ф.точки.length * 3), 3));
    g.setIndex([...ф.тр]);
    меш = new THREE.Mesh(g, материал);
    меш.frustumCulled = false;
    меш.receiveShadow = true;
    меш.name = 'листва';
    сцена.add(меш);
  };

  return {
    деревья(список) { все = список; },
    форма(новое) { задать(новое); },
    котораяФорма: () => имя,
    цена: () => цена,
    кадр(камера) {
      uniforms.uCam.value.copy(камера.position);
      uniforms.uSunDir.value.copy(солнце.position).sub(солнце.target.position).normalize();
      uniforms.uSunColor.value.copy(солнце.color).multiplyScalar(солнце.intensity);
      if (меш === null) { цена = { форма: 'нет', деревьев: 0, листьев: 0, вершин: 0 }; return; }
      // ближние деревья — в текстуру; остальным хватает кроны, какая была
      const cx = камера.position.x, cz = камера.position.z;
      const ближние = все
        .map((т) => ({ т, d: Math.hypot(т.дерево.x - cx, т.дерево.z - cz) }))
        .filter((о) => о.d < ДАЛЬ)
        .sort((p, q) => p.d - q.d)
        .slice(0, ДЕРЕВЬЕВ);
      let листьев = 0;
      ближние.forEach(({ т, d }, i) => {
        const д = т.дерево;
        const густота = Math.min(1, (14 / Math.max(d, 1)) ** 2) * (1 - Math.max(0, (d - ДАЛЬ * 0.7) / (ДАЛЬ * 0.3)));
        const низКроны = т.низ + д.ствол;
        данные.set([д.x, низКроны, д.z, д.ширина], (0 * ДЕРЕВЬЕВ + i) * 4);
        данные.set([д.крона, д.лист, д.курс, Math.max(0.03, густота)], (1 * ДЕРЕВЬЕВ + i) * 4);
        данные.set([т.цвет.r, т.цвет.g, т.цвет.b, 1], (2 * ДЕРЕВЬЕВ + i) * 4);
        листьев += Math.round(ЛИСТЬЕВ * Math.max(0.03, густота));
      });
      текстура.needsUpdate = true;
      uniforms.uTreeCount.value = ближние.length;
      const g = меш.geometry as THREE.InstancedBufferGeometry;
      g.instanceCount = ближние.length * ЛИСТЬЕВ;
      цена = {
        форма: ФОРМЫ[имя!].подпись, деревьев: ближние.length, листьев,
        вершин: ближние.length * ЛИСТЬЕВ * ФОРМЫ[имя!].точки.length,
      };
    },
  };
}
