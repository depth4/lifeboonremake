/**
 * КАК РИСУЮТСЯ ДЕРЕВЬЯ И КУСТЫ. Скелет растит `дерево.ts`; здесь из него
 * делаются кора и листья, и больше ничего не решается.
 *
 * - **Кора** — ветки кольцами (7 граней у ствола, 3 у прутьев). Один вызов
 *   отрисовки на вид и вариант; вдали прутья не рисуются.
 * - **Листья** — одной отрисовкой на ВСЕ деревья. Лист не хранится поштучно
 *   на дереве: у каждого вида свой список листьев в текстуре, дерево берёт
 *   из него первые N, где N падает с расстоянием, а лист растёт — как у
 *   травы. Список заранее перемешан, поэтому первые N ложатся по всей кроне,
 *   а не на первые ветки.
 * - **Ветер** — одна функция `treeSway` для коры и листа: лист качается
 *   ровно с точкой ветки, на которой сидит, и на ветру от неё не отрывается.
 *   Ветер, время и шум те же, что у травы.
 */

import * as THREE from 'three';
import { type Вид, ВИДЫ, type Скелет, вырастить } from './дерево.ts';
import type { ОбщийВетер } from './показ.ts';

/** Сколько разных деревьев на вид. */
export const ВАРИАНТОВ = 2;
/** Ближе этого — прутья в коре, м. */
const БЛИЖНИЕ = 45;
/** До этого расстояния листьев полный набор, дальше редеют по квадрату. */
const ПОЛНО = 22;
/** Сколько деревьев одевается листьями. */
const МАКС = 1024;
/** Ширина текстуры листьев. */
const ШИР = 2048;

export interface ФормаЛиста {
  readonly подпись: string;
  /** Точки листа: x поперёк (−1..1), y от черешка к кончику (0..1). */
  readonly точки: readonly (readonly [number, number])[];
  readonly тр: readonly number[];
}
export const ФОРМЫ: Record<string, ФормаЛиста> = {
  прямоугольник: { подпись: 'лист — прямоугольник', точки: [[-1, 0], [1, 0], [-1, 1], [1, 1]], тр: [0, 1, 3, 0, 3, 2] },
  ромб: { подпись: 'лист — ромб', точки: [[0, 0], [1, 0.45], [0, 1], [-1, 0.45]], тр: [0, 1, 2, 0, 2, 3] },
};
export const ПОРЯДОК_ЛИСТВЫ = ['прямоугольник', 'ромб'] as const;

/** Одно дерево в мире: где, какое и как повёрнуто. */
export interface Посадка {
  readonly x: number;
  readonly z: number;
  readonly низ: number;
  readonly вид: Вид;
  readonly вариант: number;
  readonly курс: number;
  /** Во сколько раз больше своего шаблона. */
  readonly масштаб: number;
}

/**
 * Качание — одно на кору и листья (`treeSway`). `k` = (вес от земли, вес внутри ветки,
 * фаза ветки). Основной изгиб — всё дерево по ветру, тем сильнее, чем выше;
 * поверх — каждая ветка сама по себе, не в ногу с соседями.
 */
const КАЧНУТЬ = /* glsl */`
vec3 treeSway(vec2 treeXZ, float H, vec3 k) {
  float gust = texture(uNoise, treeXZ * 0.03 - uWindDir * uTime * 0.075).r;
  float lean = uWind * (0.15 + 0.7 * gust * gust) * k.x * k.x * H * 0.03;
  float sway = sin(uTime * (1.2 + 0.25 * fract(k.z * 1.7)) + treeXZ.x * 0.3 + treeXZ.y * 0.2) * uWind * k.x * k.x * H * 0.008;
  float branch = uWind * k.y * k.y * (0.06 + 0.16 * gust) * sin(uTime * (2.3 + fract(k.z * 3.1)) + k.z * 7.0);
  vec3 side = vec3(-uWindDir.y, 0.0, uWindDir.x);
  return vec3(uWindDir.x, 0.0, uWindDir.y) * (lean + sway) + (side + vec3(0.0, 0.35, 0.0)) * branch;
}
`;

const ОБЩЕЕ = /* glsl */`
uniform float uTime;
uniform vec2 uWindDir;
uniform float uWind;
uniform sampler2D uNoise;
${КАЧНУТЬ}
`;

/* ─────────────────────────── кора ─────────────────────────── */

/**
 * Кора из скелета. `даль` — без последнего уровня веток: прутья вдали тоньше
 * пикселя, а вершин в них больше, чем во всём остальном дереве.
 */
function кора(с: Скелет, даль: boolean): THREE.BufferGeometry {
  const п = ВИДЫ[с.вид];
  const pos: number[] = [], nor: number[] = [], col: number[] = [], кач: number[] = [], idx: number[] = [];
  const граней = [7, 5, 4, 3];
  const цвет = new THREE.Color();
  const тёмный = new THREE.Color().setHSL(0.08, 0.1, 0.12, THREE.SRGBColorSpace);
  for (const в of с.ветки) {
    if (даль && в.уровень >= п.уровней) continue;
    if (даль && в.уровень >= 2 && п.стволов > 1) continue;
    const n = граней[в.уровень] ?? 3;
    const т = в.точки;
    let бок: THREE.Vector3 | null = null;
    const начало = pos.length / 3;
    for (let i = 0; i < т.length; i++) {
      const a = т[Math.max(0, i - 1)], b = т[Math.min(т.length - 1, i + 1)];
      const ось = new THREE.Vector3(b.x - a.x, b.y - a.y, b.z - a.z).normalize();
      // бок переносится вдоль ветки, а не берётся заново: кольца не перекручиваются
      if (бок === null) бок = new THREE.Vector3().crossVectors(ось, Math.abs(ось.y) < 0.9 ? new THREE.Vector3(0, 1, 0) : new THREE.Vector3(1, 0, 0)).normalize();
      else бок.addScaledVector(ось, -бок.dot(ось)).normalize();
      const бок2 = new THREE.Vector3().crossVectors(ось, бок);
      const т0 = т[i];
      for (let k = 0; k < n; k++) {
        const a2 = (k / n) * Math.PI * 2;
        const nx = бок.x * Math.cos(a2) + бок2.x * Math.sin(a2);
        const ny = бок.y * Math.cos(a2) + бок2.y * Math.sin(a2);
        const nz = бок.z * Math.cos(a2) + бок2.z * Math.sin(a2);
        pos.push(т0.x + nx * т0.радиус, т0.y + ny * т0.радиус, т0.z + nz * т0.радиус);
        nor.push(nx, ny, nz);
        цвет.setHSL(п.кора[0], п.кора[1], п.кора[2], THREE.SRGBColorSpace);
        if (п.полосатая) {
          // берёза: белая с чёрными штрихами поперёк ствола
          const h = Math.sin(т0.y * 9.1 + k * 1.7 + в.уровень * 3.3) * Math.sin(т0.y * 3.7 + k * 0.9);
          if (h > 0.55 || в.уровень >= 2) цвет.lerp(тёмный, в.уровень >= 2 ? 0.55 : 0.85);
          if (т0.y < 0.6) цвет.lerp(тёмный, 0.7);
        }
        col.push(цвет.r, цвет.g, цвет.b);
        кач.push(т0.вес, т0.своя, т0.фаза, с.высота);
      }
      if (i > 0) {
        const p0 = начало + (i - 1) * n, p1 = начало + i * n;
        for (let k = 0; k < n; k++) {
          const k1 = (k + 1) % n;
          idx.push(p0 + k, p0 + k1, p1 + k1, p0 + k, p1 + k1, p1 + k);
        }
      }
    }
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute('normal', new THREE.Float32BufferAttribute(nor, 3));
  g.setAttribute('color', new THREE.Float32BufferAttribute(col, 3));
  g.setAttribute('kach', new THREE.Float32BufferAttribute(кач, 4));
  g.setIndex(idx);
  g.computeBoundingSphere();
  return g;
}

function материалКоры(ветер: ОбщийВетер): THREE.MeshLambertMaterial {
  const м = new THREE.MeshLambertMaterial({ vertexColors: true });
  м.onBeforeCompile = (shader) => {
    Object.assign(shader.uniforms, ветер);
    shader.vertexShader = ОБЩЕЕ + 'attribute vec4 kach;\n' + shader.vertexShader.replace('#include <project_vertex>', /* glsl */`
      vec4 mvPosition = vec4( transformed, 1.0 );
      #ifdef USE_INSTANCING
        mvPosition = instanceMatrix * mvPosition;
        float treeScale = length(instanceMatrix[1].xyz);
        mvPosition.xyz += treeSway(instanceMatrix[3].xz, kach.w * treeScale, kach.xyz);
      #endif
      mvPosition = modelViewMatrix * mvPosition;
      gl_Position = projectionMatrix * mvPosition;
    `);
  };
  м.customProgramCacheKey = () => 'кора';
  return м;
}

/* ─────────────────────────── листья ─────────────────────────── */

const ЛИСТ_ВЕРШИНА = /* glsl */`
${ОБЩЕЕ}
uniform sampler2D uLeafData;
uniform sampler2D uTreeData;
uniform sampler2D uTreeSum;
uniform float uTreeCount;
uniform vec3 uCam;
uniform vec3 uSunDir;
varying vec3 vLeaf;
varying float vTrans;

uint leafHash(uint x) { x ^= x >> 16; x *= 0x7feb352du; x ^= x >> 15; x *= 0x846ca68bu; x ^= x >> 16; return x; }
vec4 leafTexel(int i) { return texelFetch(uLeafData, ivec2(i % ${ШИР}, i / ${ШИР}), 0); }
`;

const ЛИСТ_ТЕЛО = /* glsl */`
  // чьё это лист: двоичный поиск по накопленным числам листьев деревьев
  int inst = gl_InstanceID;
  int lo = 0, hi = int(uTreeCount) - 1;
  for (int step = 0; step < 11; step++) {
    if (lo >= hi) break;
    int mid = (lo + hi + 1) / 2;
    if (int(texelFetch(uTreeSum, ivec2(mid, 0), 0).r) <= inst) lo = mid; else hi = mid - 1;
  }
  vec4 t0 = texelFetch(uTreeData, ivec2(lo, 0), 0);   // x, низ, z, курс
  vec4 t1 = texelFetch(uTreeData, ivec2(lo, 1), 0);   // масштаб, начало, рост листа, высота шаблона
  vec4 t2 = texelFetch(uTreeData, ivec2(lo, 2), 0);   // цвет листа
  int j = inst - int(texelFetch(uTreeSum, ivec2(lo, 0), 0).r);
  int L = (int(t1.y) + j) * 3;
  vec4 a = leafTexel(L), b = leafTexel(L + 1), c = leafTexel(L + 2);

  float cs = cos(t0.w), sn = sin(t0.w), S = t1.x;
  vec3 anchor = vec3(cs * a.x - sn * a.z, a.y, sn * a.x + cs * a.z) * S + vec3(t0.x, t0.y, t0.z);
  vec3 dir = normalize(vec3(cs * b.x - sn * b.z, b.y, sn * b.x + cs * b.z));
  float H = t1.w * S;
  anchor += treeSway(t0.xz, H, vec3(b.w, c.x, c.y));

  uint s = leafHash(uint(L) * 747796405u + 12345u);
  float r1 = float(s & 1023u) / 1023.0, r2 = float((s >> 10) & 1023u) / 1023.0, r3 = float((s >> 20) & 1023u) / 1023.0;
  // лист качается на черешке, в своей фазе
  vec3 side = normalize(cross(dir, abs(dir.y) > 0.95 ? vec3(1.0, 0.0, 0.0) : vec3(0.0, 1.0, 0.0)));
  float flap = uWind * (0.3 + 0.8 * r2) * sin(uTime * (6.0 + 5.0 * r1) + r3 * 30.0);
  side = normalize(side * cos(flap) + cross(dir, side) * sin(flap));
  vec3 face = normalize(cross(side, dir));

  float len = a.w * S * t1.z;
  vec3 leafP = anchor + dir * position.y * len + side * position.x * len * 0.32;

  // свет объёма: наполовину от листа, наполовину от середины кроны
  vec3 centre = vec3(t0.x, t0.y + H * 0.62, t0.z);
  vec3 out3 = normalize(anchor - centre);
  float facing = dot(face, uCam - leafP) < 0.0 ? -1.0 : 1.0;
  vec3 objectNormal = normalize(mix(face * facing, out3, 0.55));
  float bright = (0.8 + 0.4 * r1) * (facing < 0.0 ? 1.18 : 1.0);
  vec3 col = t2.rgb * bright;
  col = mix(col, vec3(0.5, 0.42, 0.1), step(0.985, r3) * 0.8);
  // внутрь кроны и на дальнюю её сторону света меньше
  float toCam = dot(out3, normalize(uCam - centre));
  col *= mix(0.68, 1.05, smoothstep(-0.8, 0.7, toCam));
  vLeaf = col;
  vTrans = 0.55 * pow(max(dot(normalize(leafP - uCam), uSunDir), 0.0), 4.0);
`;

export interface ЦенаДеревьев {
  readonly деревьев: number;
  readonly листьев: number;
  readonly вершинКоры: number;
  readonly вызовов: number;
  readonly форма: string;
}

export interface Деревья {
  поставить(посадки: readonly Посадка[]): void;
  форма(имя: string | null): void;
  котораяФорма(): string | null;
  кадр(камера: THREE.Camera): void;
  цена(): ЦенаДеревьев;
}

export function создатьДеревья(сцена: THREE.Scene, солнце: THREE.DirectionalLight, ветер: ОбщийВетер): Деревья {
  /** Шаблоны: вид × вариант → скелет, кора вблизи и вдали, где его листья в текстуре. */
  const шаблоны = new Map<string, { с: Скелет; вблизи: THREE.BufferGeometry; вдали: THREE.BufferGeometry; начало: number; листьев: number; цвет: THREE.Color }>();
  const листья: number[] = [];
  for (const вид of Object.keys(ВИДЫ) as Вид[]) {
    for (let в = 0; в < ВАРИАНТОВ; в++) {
      const с = вырастить(вид, в + 1);
      // перемешать: первые N листьев должны лечь по всей кроне
      const порядок = с.листья.map((_, i) => i);
      let h = 2166136261 ^ (в * 131 + вид.length);
      for (let i = порядок.length - 1; i > 0; i--) {
        h = Math.imul(h ^ (h >>> 13), 1103515245) >>> 0;
        const k = h % (i + 1);
        [порядок[i], порядок[k]] = [порядок[k], порядок[i]];
      }
      const начало = листья.length / 12;
      for (const i of порядок) {
        const л = с.листья[i];
        листья.push(л.x, л.y, л.z, л.длина, л.nx, л.ny, л.nz, л.вес, л.своя, л.фаза, 0, 0);
      }
      const п = ВИДЫ[вид];
      шаблоны.set(`${вид}:${в}`, {
        с, вблизи: кора(с, false), вдали: кора(с, true), начало, листьев: с.листья.length,
        цвет: new THREE.Color().setHSL(п.зелень[0], п.зелень[1], п.зелень[2], THREE.SRGBColorSpace),
      });
    }
  }
  const строк = Math.ceil(листья.length / 4 / ШИР);
  const данныеЛистьев = new Float32Array(ШИР * строк * 4);
  данныеЛистьев.set(листья);
  const листьяТ = new THREE.DataTexture(данныеЛистьев, ШИР, строк, THREE.RGBAFormat, THREE.FloatType);
  листьяТ.magFilter = листьяТ.minFilter = THREE.NearestFilter;
  листьяТ.needsUpdate = true;

  const деревоДанные = new Float32Array(МАКС * 3 * 4);
  const деревоТ = new THREE.DataTexture(деревоДанные, МАКС, 3, THREE.RGBAFormat, THREE.FloatType);
  деревоТ.magFilter = деревоТ.minFilter = THREE.NearestFilter;
  const суммаДанные = new Float32Array(МАКС * 4);
  const суммаТ = new THREE.DataTexture(суммаДанные, МАКС, 1, THREE.RGBAFormat, THREE.FloatType);
  суммаТ.magFilter = суммаТ.minFilter = THREE.NearestFilter;

  const uniforms = {
    ...ветер,
    uLeafData: { value: листьяТ as THREE.Texture },
    uTreeData: { value: деревоТ as THREE.Texture },
    uTreeSum: { value: суммаТ as THREE.Texture },
    uTreeCount: { value: 0 },
    uCam: { value: new THREE.Vector3() },
    uSunDir: { value: new THREE.Vector3(0, 1, 0) },
    uSunColor: { value: new THREE.Color() },
  };
  const материалЛиста = new THREE.MeshLambertMaterial({ color: 0xffffff, side: THREE.DoubleSide });
  материалЛиста.onBeforeCompile = (shader) => {
    Object.assign(shader.uniforms, uniforms);
    shader.vertexShader = ЛИСТ_ВЕРШИНА + shader.vertexShader
      .replace('#include <beginnormal_vertex>', ЛИСТ_ТЕЛО)
      .replace('#include <begin_vertex>', 'vec3 transformed = leafP;');
    shader.fragmentShader = 'varying vec3 vLeaf;\nvarying float vTrans;\nuniform vec3 uSunColor;\n' + shader.fragmentShader
      .replace('#include <color_fragment>', 'diffuseColor.rgb *= vLeaf;')
      .replace('#include <normal_fragment_begin>',
        'float faceDirection = 1.0;\nvec3 normal = normalize( vNormal );\nvec3 nonPerturbedNormal = normal;')
      .replace('#include <envmap_fragment>', 'outgoingLight += diffuseColor.rgb * uSunColor * vTrans;');
  };
  материалЛиста.customProgramCacheKey = () => 'лист';
  /** Тень от листьев: та же раскладка, только глубина. Иначе газон под деревом залит солнцем. */
  const теньЛиста = new THREE.MeshDepthMaterial({ depthPacking: THREE.RGBADepthPacking, side: THREE.DoubleSide });
  теньЛиста.onBeforeCompile = (shader) => {
    Object.assign(shader.uniforms, uniforms);
    shader.vertexShader = ЛИСТ_ВЕРШИНА + shader.vertexShader
      .replace('#include <begin_vertex>', ЛИСТ_ТЕЛО + '\nvec3 transformed = leafP;');
  };
  теньЛиста.customProgramCacheKey = () => 'лист-тень';

  const материалКорыОбщий = материалКоры(ветер);

  let форма: string | null = null;
  let листМеш: THREE.Mesh | null = null;
  let посадки: readonly Посадка[] = [];
  /** Кора: по мешу на шаблон и дальность. */
  const кораМеши = new Map<string, THREE.InstancedMesh>();
  let где = { x: Infinity, z: Infinity };
  let цена: ЦенаДеревьев = { деревьев: 0, листьев: 0, вершинКоры: 0, вызовов: 0, форма: 'нет' };

  const убратьКору = (): void => {
    for (const м of кораМеши.values()) { сцена.remove(м); м.dispose(); }
    кораМеши.clear();
  };

  const задатьФорму = (новое: string | null): void => {
    if (листМеш !== null) { сцена.remove(листМеш); листМеш.geometry.dispose(); листМеш = null; }
    форма = новое !== null && ФОРМЫ[новое] ? новое : null;
    const ф = ФОРМЫ[форма ?? 'прямоугольник'];
    const g = new THREE.InstancedBufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(ф.точки.flatMap(([x, y]) => [x, y, 0]), 3));
    g.setAttribute('normal', new THREE.Float32BufferAttribute(new Float32Array(ф.точки.length * 3), 3));
    g.setIndex([...ф.тр]);
    листМеш = new THREE.Mesh(g, материалЛиста);
    листМеш.customDepthMaterial = теньЛиста;
    листМеш.frustumCulled = false;
    листМеш.castShadow = true;
    листМеш.receiveShadow = true;
    листМеш.name = 'листья';
    листМеш.visible = форма !== null;
    сцена.add(листМеш);
    где = { x: Infinity, z: Infinity };
  };
  задатьФорму('прямоугольник');

  /** Разложить деревья по дальности: кора вблизи/вдали, сколько листьев каждому. */
  const разложить = (cx: number, cz: number): void => {
    const по = посадки
      .map((п) => ({ п, d: Math.hypot(п.x - cx, п.z - cz) }))
      .sort((a, b) => a.d - b.d)
      .slice(0, МАКС);
    // кора
    const группы = new Map<string, { п: Посадка }[]>();
    for (const { п, d } of по) {
      const ключ = `${п.вид}:${п.вариант % ВАРИАНТОВ}:${d < БЛИЖНИЕ ? 'в' : 'д'}`;
      const г = группы.get(ключ);
      if (г) г.push({ п }); else группы.set(ключ, [{ п }]);
    }
    for (const [ключ, м] of кораМеши) if (!группы.has(ключ)) { сцена.remove(м); м.dispose(); кораМеши.delete(ключ); }
    const матрица = new THREE.Matrix4(), кв = new THREE.Quaternion(), ось = new THREE.Vector3(0, 1, 0);
    let вершинКоры = 0;
    for (const [ключ, г] of группы) {
      const [вид, вар, даль] = ключ.split(':');
      const ш = шаблоны.get(`${вид}:${вар}`)!;
      const geo = даль === 'в' ? ш.вблизи : ш.вдали;
      let м = кораМеши.get(ключ);
      if (!м || м.instanceMatrix.count < г.length) {
        if (м) { сцена.remove(м); м.dispose(); }
        м = new THREE.InstancedMesh(geo, материалКорыОбщий, Math.max(8, г.length * 2));
        м.castShadow = true; м.receiveShadow = true; м.frustumCulled = false; м.name = 'кора';
        сцена.add(м);
        кораМеши.set(ключ, м);
      }
      г.forEach(({ п }, i) => {
        кв.setFromAxisAngle(ось, -п.курс);
        матрица.compose(new THREE.Vector3(п.x, п.низ, п.z), кв, new THREE.Vector3(п.масштаб, п.масштаб, п.масштаб));
        м!.setMatrixAt(i, матрица);
      });
      м.count = г.length;
      м.instanceMatrix.needsUpdate = true;
      вершинКоры += geo.getAttribute('position').count * г.length;
    }
    // листья: сколько каждому дереву и с какого номера
    let сумма = 0;
    по.forEach(({ п, d }, i) => {
      const ш = шаблоны.get(`${п.вид}:${п.вариант % ВАРИАНТОВ}`)!;
      const доля = Math.min(1, Math.max(0.07, (ПОЛНО / Math.max(d, 1)) ** 2));
      const n = Math.ceil(ш.листьев * доля);
      деревоДанные.set([п.x, п.низ, п.z, п.курс], (0 * МАКС + i) * 4);
      деревоДанные.set([п.масштаб, ш.начало, Math.min(2.4, 1 / Math.sqrt(доля)), ш.с.высота], (1 * МАКС + i) * 4);
      const в = 0.9 + 0.2 * ((п.вариант * 0.618) % 1);
      деревоДанные.set([ш.цвет.r * в, ш.цвет.g * в, ш.цвет.b * в, 1], (2 * МАКС + i) * 4);
      суммаДанные[i * 4] = сумма;
      сумма += n;
    });
    деревоТ.needsUpdate = true;
    суммаТ.needsUpdate = true;
    uniforms.uTreeCount.value = по.length;
    if (листМеш !== null) (листМеш.geometry as THREE.InstancedBufferGeometry).instanceCount = форма === null ? 0 : сумма;
    цена = {
      деревьев: по.length, листьев: форма === null ? 0 : сумма, вершинКоры,
      вызовов: кораМеши.size + (форма === null ? 0 : 2), форма: форма === null ? 'нет' : ФОРМЫ[форма].подпись,
    };
  };

  return {
    поставить(новые) {
      посадки = новые;
      убратьКору();
      где = { x: Infinity, z: Infinity };
    },
    форма(новое) { задатьФорму(новое); },
    котораяФорма: () => форма,
    цена: () => цена,
    кадр(камера) {
      uniforms.uCam.value.copy(камера.position);
      uniforms.uSunDir.value.copy(солнце.position).sub(солнце.target.position).normalize();
      uniforms.uSunColor.value.copy(солнце.color).multiplyScalar(солнце.intensity);
      if (листМеш !== null) листМеш.visible = форма !== null;
      // раскладка дорогая — только когда камера ушла на несколько метров
      if (Math.hypot(камера.position.x - где.x, камера.position.z - где.z) > 4) {
        где = { x: камера.position.x, z: камера.position.z };
        разложить(где.x, где.z);
      }
    },
  };
}
