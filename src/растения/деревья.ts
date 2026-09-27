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
 * - **Дальняя крона** — у КАЖДОГО дерева города, без предела дальности:
 *   пучки его же листьев (бугор на пучок) и ствол, две сотни
 *   треугольников. Вблизи её нет; к краю дальности листьев она проступает
 *   теми самыми точками, которыми растворяется листва (см. «ПРОЯВЛЕНИЕ»).
 * - **Ветер** — одна функция `treeSway` для коры и листа: лист качается
 *   ровно с точкой ветки, на которой сидит, и на ветру от неё не отрывается.
 *   Ветер, время и шум те же, что у травы.
 */

import * as THREE from 'three';
import { mergeGeometries, mergeVertices } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import { type Вид, ВИДЫ, КУСТЫ, type Скелет, вырастить } from './дерево.ts';
import type { ОбщийВетер } from './показ.ts';

/** Сколько разных деревьев на вид. */
export const ВАРИАНТОВ = 2;
/**
 * Ближе этого — прутья в коре, м. Прут не пропадает на этой черте, а к ней
 * истончается до нуля (`ПРУТ_ТОНЬШЕ`), и то, что вдали их нет, не видно.
 */
const БЛИЖНИЕ = 45;
const ПРУТ_ТОНЬШЕ = 0.7;
/** До этого расстояния листьев полный набор, дальше редеют по квадрату. */
const ПОЛНО = 22;
/** Дальше листьев не меньше этой доли. */
const ПОЛ = 0.07;
/**
 * ПРОЯВЛЕНИЕ. 27.09 Алекс: «растительность по-прежнему прорисовывается по
 * мере того, как едешь, и это бросается в глаза». Причин было три, и все
 * три — «что видно, зависит не только от того, где глаз»:
 *
 * 1. **Листва ступенями.** Число листьев дерева считалось раз в 4 м пути
 *    по месту последней раскладки, и лист менял размер тоже ступенькой.
 *    Теперь раскладка только ОТВОДИТ листья с запасом (на ближайшее место,
 *    куда глаз успеет дойти до следующей раскладки, — `ШАГ_РАСКЛАДКИ`),
 *    а видно ли лист и какого он размера, шейдер считает каждый кадр от
 *    глаза. Лист на пороге не выключается, а сжимается в точку.
 * 2. **Крона вдали пустела.** Лист рос не больше чем в 2.4 раза, а редел
 *    до 7%: за 53 м крона теряла площадь и дерево «набиралось» по мере
 *    приближения. Теперь лист растёт ровно настолько, насколько поредели
 *    соседи (площадь ∝ число × размер² = постоянна).
 * 3. **Деревья кончались.** За 230 м деревьев не было вовсе — в чистом
 *    воздухе, пешком и за рулём. Так в играх не делают: дерево не исчезает,
 *    пока оно больше пикселя, а вдали его рисует дешёвый заменитель
 *    (у SpeedTree и в RDR2 — картинка или упрощённая крона). Здесь —
 *    дальняя крона. Листва растворяется точками по узору, крона проступает
 *    в ДОПОЛНИТЕЛЬНЫХ точках того же узора: каждая точка экрана в полосе —
 *    ровно одно из двух, не оба и не ни одного.
 *
 * Дальность листвы — `ДАЛЬ`, полоса перехода — `ПОЛОСА`.
 */
const ДАЛЬ = 230;
const ПОЛОСА = 40;
/** Кусты — ближе и уже: полоса своя. */
const КУСТ_ДАЛЬ = 90;
const КУСТ_ПОЛОСА = 25;
/** Раскладка — когда глаз ушёл от прошлой дальше этого, м. */
const ШАГ_РАСКЛАДКИ = 4;
/** Сколько деревьев одевается листьями. Потолок двоичного поиска листа — 2^11. */
const МАКС = 2048;
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

/** Насколько листва дерева светлее или темнее своего вида: одно число на листья и дальнюю крону. */
const оттенок = (п: Pick<Посадка, 'вариант'>): number => 0.9 + 0.2 * ((п.вариант * 0.618) % 1);

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
/**
 * Доля ближнего вида (кора и листья) у дерева в точке at: 1 — только он,
 * 0 — только дальняя крона. Одна функция на кору, лист и крону, поэтому
 * их полосы перехода не могут разойтись.
 */
float nearShare(vec2 at, float edge, float band) {
  return clamp((edge - distance(uCam.xz, at)) / band, 0.0, 1.0);
}
`;

/* ─────────────────────────── кора ─────────────────────────── */

/**
 * Кора из скелета. `даль` — без последнего уровня веток: прутья вдали тоньше
 * пикселя, а вершин в них больше, чем во всём остальном дереве.
 */
function кора(с: Скелет, даль: boolean): THREE.BufferGeometry {
  const п = ВИДЫ[с.вид];
  const pos: number[] = [], nor: number[] = [], col: number[] = [], кач: number[] = [], прут: number[] = [], idx: number[] = [];
  const граней = [7, 5, 4, 3];
  const цвет = new THREE.Color();
  const тёмный = new THREE.Color().setHSL(0.08, 0.1, 0.12, THREE.SRGBColorSpace);
  const куст = п.стволов > 1;
  for (const в of с.ветки) {
    if (даль && в.уровень >= п.уровней) continue;
    // у куста прутья не видны в листве, а вершин в них — больше всего остального
    if (куст && в.уровень >= п.уровней) continue;
    if (даль && куст && в.уровень >= 1) continue;
    const n = куст ? Math.max(3, (граней[в.уровень] ?? 3) - 2) : граней[в.уровень] ?? 3;
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
        // «прут» — всё, чего нет в дальней коре: к черте ближних оно истончается до нуля
        прут.push(в.уровень >= п.уровней || (куст && в.уровень >= 1) ? т0.радиус : 0);
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
  g.setAttribute('twig', new THREE.Float32BufferAttribute(прут, 1));
  g.setIndex(idx);
  g.computeBoundingSphere();
  return g;
}

/**
 * Кора и её тень — ОДИН вершинный код: качание, истончение прута, доля
 * ближнего вида. До 27.09 тень рисовалась стандартным материалом глубины:
 * она не качалась и не истончала прутья, и пока квадрат тени стоял у
 * середины мира, этого не было видно. Когда тень поехала за глазом,
 * `обход.ts проявление` поймал 55 точек: тень прутьев зависела от
 * раскладки. Теперь «тень не совпадает с деревом» записать нельзя.
 */
function материалыКоры(ветер: ОбщийВетер, даль: Record<string, THREE.IUniform>): { кора: THREE.MeshLambertMaterial; тень: THREE.MeshDepthMaterial } {
  const вершины = (shader: THREE.WebGLProgramParametersWithUniforms): void => {
    Object.assign(shader.uniforms, ветер, даль);
    shader.fragmentShader = РАСТВОРИТЬ + shader.fragmentShader.replace('void main() {', РАСТВОРИТЬ_ТОЧКУ);
    shader.vertexShader = 'uniform vec3 uCam;\n' + ОБЩЕЕ + 'attribute vec4 kach;\nattribute float twig;\nvarying float vFade;\nuniform float uTreeFar;\nuniform float uTreeBand;\n'
      + shader.vertexShader.replace('#include <project_vertex>', /* glsl */`
      vFade = 1.0;
      #ifdef USE_INSTANCING
        // прут к черте ближних истончается до нуля — от глаза, каждый кадр
        float twigD = distance(uCam.xz, instanceMatrix[3].xz);
        transformed -= normal * twig * smoothstep(${(БЛИЖНИЕ * ПРУТ_ТОНЬШЕ).toFixed(1)}, ${БЛИЖНИЕ.toFixed(1)}, twigD);
      #endif
      vec4 mvPosition = vec4( transformed, 1.0 );
      #ifdef USE_INSTANCING
        mvPosition = instanceMatrix * mvPosition;
        float treeScale = length(instanceMatrix[1].xyz);
        mvPosition.xyz += treeSway(instanceMatrix[3].xz, kach.w * treeScale, kach.xyz);
        vFade = nearShare(instanceMatrix[3].xz, uTreeFar, uTreeBand);
      #endif
      mvPosition = modelViewMatrix * mvPosition;
      gl_Position = projectionMatrix * mvPosition;
    `);
  };
  const кора = new THREE.MeshLambertMaterial({ vertexColors: true });
  кора.onBeforeCompile = вершины;
  кора.customProgramCacheKey = () => 'кора';
  const тень = new THREE.MeshDepthMaterial({ depthPacking: THREE.RGBADepthPacking });
  тень.onBeforeCompile = вершины;
  тень.customProgramCacheKey = () => 'кора-тень';
  return { кора, тень };
}

/* ─────────────────────────── дальняя крона ─────────────────────────── */

/**
 * Дальняя крона — из тех же листьев, что ближняя: не «шар по размаху»,
 * а ПУЧКИ. Листья делятся на пучки по месту (k-средних: у дерева 10,
 * у куста 4) — это и есть концы ветвей, где листья сидят гуще; каждый пучок —
 * свой бугор по разбросу его листьев. Поэтому у тополя крона столбом,
 * у берёзы свисает, у липы шатром, а между пучками в силуэте просветы —
 * как у ближнего вида; одна оболочка на всю крону читалась шаром на палке.
 * Внизу — ствол до середины кроны.
 */
function дальняяКрона(с: Скелет): THREE.BufferGeometry {
  const п = ВИДЫ[с.вид];
  const куст = п.стволов > 1;
  const л = с.листья;
  const K = Math.min(куст ? 4 : 10, л.length);
  // начала пучков — листья через равный шаг списка: список перемешан, они разбросаны по кроне
  const ц = Array.from({ length: K }, (_, k) => { const x = л[Math.floor((k * л.length) / K)]; return { x: x.x, y: x.y, z: x.z }; });
  const чей = new Int32Array(л.length);
  for (let шаг = 0; шаг < 10; шаг++) {
    л.forEach((x, i) => {
      let best = 0, bd = Infinity;
      ц.forEach((c, k) => { const d = (x.x - c.x) ** 2 + (x.y - c.y) ** 2 + (x.z - c.z) ** 2; if (d < bd) { bd = d; best = k; } });
      чей[i] = best;
    });
    const сумма = ц.map(() => ({ x: 0, y: 0, z: 0, n: 0 }));
    л.forEach((x, i) => { const с2 = сумма[чей[i]]; с2.x += x.x; с2.y += x.y; с2.z += x.z; с2.n++; });
    сумма.forEach((с2, k) => { if (с2.n > 0) ц[k] = { x: с2.x / с2.n, y: с2.y / с2.n, z: с2.z / с2.n }; });
  }
  let cy = 0, низ = Infinity, верх = -Infinity;
  for (const x of л) { cy += x.y; низ = Math.min(низ, x.y); верх = Math.max(верх, x.y); }
  cy /= л.length;
  const зелень = new THREE.Color().setHSL(п.зелень[0], п.зелень[1], п.зелень[2], THREE.SRGBColorSpace);
  const пучки: THREE.BufferGeometry[] = [];
  ц.forEach((c, k) => {
    // размер бугра — разброс листьев пучка по каждой оси (с запасом на выросший вдали лист)
    let n = 0, sx = 0, sy = 0, sz = 0, длина = 0;
    л.forEach((x, i) => {
      if (чей[i] !== k) return;
      n++; sx += (x.x - c.x) ** 2; sy += (x.y - c.y) ** 2; sz += (x.z - c.z) ** 2; длина += x.длина;
    });
    if (n === 0) return;
    const запас = (длина / n) * 1.5;
    // двадцать граней на пучок: вдали пучок — пара десятков точек экрана; нормаль гладкая, как у шара
    const g = new THREE.IcosahedronGeometry(1, 0).deleteAttribute('uv');
    g.setAttribute('normal', g.getAttribute('position').clone());
    g.scale(Math.sqrt(sx / n) * 1.6 + запас, Math.sqrt(sy / n) * 1.6 + запас, Math.sqrt(sz / n) * 1.6 + запас).translate(c.x, c.y, c.z);
    const pos = g.getAttribute('position');
    const cols: number[] = [];
    for (let v = 0; v < pos.count; v++) {
      // низ кроны в тени верха
      const k2 = 0.8 + 0.3 * THREE.MathUtils.clamp((pos.getY(v) - низ) / Math.max(верх - низ, 0.1), 0, 1);
      cols.push(зелень.r * k2, зелень.g * k2, зелень.b * k2);
    }
    g.setAttribute('color', new THREE.Float32BufferAttribute(cols, 3));
    g.setAttribute('crown', new THREE.Float32BufferAttribute(new Float32Array(pos.count).fill(1), 1));
    пучки.push(g);
  });
  const шар = mergeVertices(mergeGeometries(пучки)!);
  if (куст) return шар;
  // ствол: четыре грани от земли до середины кроны
  const r = п.толщина / 2, кора = new THREE.Color().setHSL(п.кора[0], п.кора[1], п.кора[2], THREE.SRGBColorSpace);
  const ствол = new THREE.CylinderGeometry(r * 0.7, r, cy, 4, 1, true).translate(0, cy / 2, 0).deleteAttribute('uv');
  ствол.setAttribute('crown', new THREE.Float32BufferAttribute(new Float32Array(ствол.getAttribute('position').count), 1));
  ствол.setAttribute('color', new THREE.Float32BufferAttribute(
    Array.from({ length: ствол.getAttribute('position').count }, () => [кора.r, кора.g, кора.b]).flat(), 3));
  const вместе = mergeGeometries([шар, ствол])!;
  вместе.computeBoundingSphere();
  return вместе;
}

/**
 * Материал дальней кроны: видна там, где ближний вид растворён, — в тех
 * точках узора, которые листва выбросила. `край` и `полоса` — те же
 * объекты, что у листвы и коры своего дерева.
 */
function материалКроны(ветер: ОбщийВетер, uCam: THREE.IUniform, край: THREE.IUniform, полоса: THREE.IUniform): THREE.MeshLambertMaterial {
  const м = new THREE.MeshLambertMaterial({ vertexColors: true });
  м.onBeforeCompile = (shader) => {
    Object.assign(shader.uniforms, ветер, { uCam, uEdge: край, uBand: полоса });
    shader.vertexShader = 'uniform vec3 uCam;\n' + ОБЩЕЕ
      + 'attribute float crown;\nvarying float vFade;\nvarying float vCrown;\nvarying vec3 vWP;\nvarying vec3 vWN;\nuniform float uEdge;\nuniform float uBand;\n'
      + shader.vertexShader.replace('#include <begin_vertex>', /* glsl */`
      #include <begin_vertex>
      vFade = 1.0;
      vCrown = crown;
      vWP = transformed;
      vWN = objectNormal;
      #ifdef USE_INSTANCING
        vFade = nearShare(instanceMatrix[3].xz, uEdge, uBand);
        vWP = (instanceMatrix * vec4(transformed, 1.0)).xyz;
        vWN = mat3(instanceMatrix) * objectNormal;
      #endif
      // пока дерево целиком ближнее, крону не рисуем вовсе: все вершины в одну точку
      if (vFade >= 1.0) transformed = vec3(0.0);
    `);
    /**
     * Крона — не гладкий шар (его Алекс уже забраковал 23.09): край рвётся
     * по шуму, как пучки листьев на фоне неба, поверхность пятнистая, а свет
     * ложится как на листья — нормаль наполовину к глазу (у листа она тоже
     * повёрнута к смотрящему), иначе крона темнее листвы, и переход виден.
     */
    shader.fragmentShader = /* glsl */`
      varying float vCrown;
      varying vec3 vWP;
      varying vec3 vWN;
      float crownHash(vec3 p) { return fract(sin(dot(p, vec3(127.1, 311.7, 74.7))) * 43758.5453); }
      float crownNoise(vec3 p) {
        vec3 i = floor(p), f = fract(p);
        f = f * f * (3.0 - 2.0 * f);
        return mix(mix(mix(crownHash(i), crownHash(i + vec3(1, 0, 0)), f.x), mix(crownHash(i + vec3(0, 1, 0)), crownHash(i + vec3(1, 1, 0)), f.x), f.y),
                   mix(mix(crownHash(i + vec3(0, 0, 1)), crownHash(i + vec3(1, 0, 1)), f.x), mix(crownHash(i + vec3(0, 1, 1)), crownHash(i + vec3(1, 1, 1)), f.x), f.y), f.z);
      }
    ` + РАСТВОРИТЬ + shader.fragmentShader
      .replace('void main() {', ПРОСТУПИТЬ_ТОЧКУ + /* glsl */`
        float leafy = crownNoise(vWP * 1.1) * 0.6 + crownNoise(vWP * 2.9 + 17.0) * 0.4;
        float facing = abs(dot(normalize(vWN), normalize(cameraPosition - vWP)));
        if (vCrown > 0.5 && leafy < 0.95 - facing * 1.6) discard;
      `)
      .replace('#include <color_fragment>', '#include <color_fragment>\n  diffuseColor.rgb *= mix(1.0, 0.72 + 0.5 * leafy, vCrown);')
      .replace('#include <normal_fragment_begin>', '#include <normal_fragment_begin>\n  normal = normalize(mix(normal, vec3(0.0, 0.0, 1.0), 0.45 * vCrown));');
  };
  м.customProgramCacheKey = () => 'крона';
  return м;
}

/** Узор растворения: порог 4 × 4 по точке экрана (матрица Байера). Один на деревья и людей. */
export const РАСТВОРИТЬ = /* glsl */`
varying float vFade;
float bayer4(vec2 p) {
  ivec2 q = ivec2(mod(p, 4.0));
  int i = q.x + q.y * 4;
  float m[16] = float[16](0., 8., 2., 10., 12., 4., 14., 6., 3., 11., 1., 9., 15., 7., 13., 5.);
  return (m[i] + 0.5) / 16.0;
}
`;
export const РАСТВОРИТЬ_ТОЧКУ = 'void main() {\n  if (vFade < bayer4(gl_FragCoord.xy)) discard;';
/** Ровно дополнение `РАСТВОРИТЬ_ТОЧКУ`: точка экрана — или ближний вид, или крона. */
const ПРОСТУПИТЬ_ТОЧКУ = 'void main() {\n  if (vFade >= bayer4(gl_FragCoord.xy)) discard;';

/* ─────────────────────────── листья ─────────────────────────── */

const ЛИСТ_ВЕРШИНА = /* glsl */`
uniform vec3 uCam;
${ОБЩЕЕ}
uniform sampler2D uLeafData;
uniform sampler2D uTreeData;
uniform sampler2D uTreeSum;
uniform float uTreeCount;
/** Откуда считается, сколько листьев видно: глаз (в сломанном варианте — место раскладки). */
uniform vec3 uLeafEye;
uniform vec3 uSunDir;
varying vec3 vLeaf;
varying float vTrans;
varying float vFade;

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
  vec4 t1 = texelFetch(uTreeData, ivec2(lo, 1), 0);   // масштаб, начало, листьев у шаблона, высота шаблона
  vec4 t2 = texelFetch(uTreeData, ivec2(lo, 2), 0);   // цвет листа
  vec4 t3 = texelFetch(uTreeData, ivec2(lo, 3), 0);   // край дальности и полоса растворения
  vFade = nearShare(t0.xz, t3.x, t3.y);
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

  // сколько листьев видно и какого они размера — от глаза, каждый кадр:
  // реже в share раз — крупнее в 1/sqrt(share), площадь кроны та же;
  // лист у порога сжимается в точку, а не выключается
  float eyeD = distance(uLeafEye.xz, t0.xz);
  float share = clamp(${(ПОЛНО * ПОЛНО).toFixed(1)} / max(eyeD * eyeD, 1.0), ${ПОЛ}, 1.0);
  float rank = (float(j) + 0.5) / t1.z;
  float len = a.w * S * inversesqrt(share) * (1.0 - smoothstep(share * 0.8, share, rank));
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

/**
 * `редеть: 'ступенями'` — заведомо сломанный вариант для проверки: сколько
 * листьев видно, считается от места раскладки, а не от глаза, как до 27.09.
 */
export function создатьДеревья(сцена: THREE.Scene, солнце: THREE.DirectionalLight, ветер: ОбщийВетер,
  как: { редеть?: 'ступенями' } = {}): Деревья {
  const ступенями = как.редеть === 'ступенями';
  /** Шаблоны: вид × вариант → скелет, кора вблизи и вдали, дальняя крона, где его листья в текстуре. */
  const шаблоны = new Map<string, {
    с: Скелет; вблизи: THREE.BufferGeometry; вдали: THREE.BufferGeometry; крона: THREE.BufferGeometry;
    начало: number; листьев: number; цвет: THREE.Color;
  }>();
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
        с, вблизи: кора(с, false), вдали: кора(с, true), крона: дальняяКрона(с), начало, листьев: с.листья.length,
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

  const деревоДанные = new Float32Array(МАКС * 4 * 4);
  const деревоТ = new THREE.DataTexture(деревоДанные, МАКС, 4, THREE.RGBAFormat, THREE.FloatType);
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
    uLeafEye: { value: new THREE.Vector3() },
    uSunDir: { value: new THREE.Vector3(0, 1, 0) },
    uSunColor: { value: new THREE.Color() },
    // край дальности деревьев сейчас (он ближе ДАЛИ, когда ближних больше МАКС)
    uTreeFar: { value: ДАЛЬ },
    uTreeBand: { value: ПОЛОСА },
  };
  const материалЛиста = new THREE.MeshLambertMaterial({ color: 0xffffff, side: THREE.DoubleSide });
  материалЛиста.onBeforeCompile = (shader) => {
    Object.assign(shader.uniforms, uniforms);
    shader.vertexShader = ЛИСТ_ВЕРШИНА + shader.vertexShader
      .replace('#include <beginnormal_vertex>', ЛИСТ_ТЕЛО)
      .replace('#include <begin_vertex>', 'vec3 transformed = leafP;');
    shader.fragmentShader = 'varying vec3 vLeaf;\nvarying float vTrans;\nuniform vec3 uSunColor;\n' + РАСТВОРИТЬ + shader.fragmentShader
      .replace('void main() {', РАСТВОРИТЬ_ТОЧКУ)
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
    // тень растворяется вместе с листом, иначе на газоне лежала бы тень невидимого дерева
    shader.fragmentShader = РАСТВОРИТЬ + shader.fragmentShader.replace('void main() {', РАСТВОРИТЬ_ТОЧКУ);
  };
  теньЛиста.customProgramCacheKey = () => 'лист-тень';

  const материалКорыОбщий = материалыКоры(ветер, { uCam: uniforms.uCam, uTreeFar: uniforms.uTreeFar, uTreeBand: uniforms.uTreeBand });
  const материалКроныДерева = материалКроны(ветер, uniforms.uCam, uniforms.uTreeFar, uniforms.uTreeBand);
  const материалКроныКуста = материалКроны(ветер, uniforms.uCam, { value: КУСТ_ДАЛЬ }, { value: КУСТ_ПОЛОСА });
  /** Дальние кроны: по мешу на шаблон, у всех деревьев города, ставятся раз. */
  const кроны: THREE.InstancedMesh[] = [];

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
    // сначала отсев по кругу — дешёвым сравнением квадратов, потом сортировка оставшихся
    const рядом: { п: Посадка; d: number; i: number }[] = [];
    посадки.forEach((п, i) => {
      const dx = п.x - cx, dz = п.z - cz, d2 = dx * dx + dz * dz;
      // с запасом на шаг раскладки: дерево у края, до которого глаз дойдёт
      // до следующей раскладки, ещё растворяется — его точки должны быть
      const даль = (КУСТЫ.includes(п.вид) ? КУСТ_ДАЛЬ : ДАЛЬ) + ШАГ_РАСКЛАДКИ;
      if (d2 < даль * даль) рядом.push({ п, d: Math.sqrt(d2), i });
    });
    рядом.sort((a, b) => a.d - b.d);
    const по = рядом.slice(0, МАКС);
    // ближних больше потолка — край деревьев там, где кончилось последнее взятое
    const крайДеревьев = рядом.length > МАКС ? Math.min(ДАЛЬ, по[по.length - 1].d) : ДАЛЬ;
    /**
     * Рисуются взятые — в ПОРЯДКЕ ПОСАДКИ, а не по расстоянию от места
     * раскладки. Где листья соседних деревьев пересекаются, глубина у них
     * одна, и точку берёт нарисованный первым; при порядке «от места
     * раскладки» эта точка зависела от того, где глаз был раньше
     * (`обход.ts проявление`: 5 точек на пересечении крон).
     */
    по.sort((a, b) => a.i - b.i);
    uniforms.uTreeFar.value = крайДеревьев;
    // кора
    const группы = new Map<string, { п: Посадка }[]>();
    for (const { п, d } of по) {
      // с прутьями — все, кто может оказаться ближе черты до следующей раскладки
      const ключ = `${п.вид}:${п.вариант % ВАРИАНТОВ}:${d < БЛИЖНИЕ + ШАГ_РАСКЛАДКИ ? 'в' : 'д'}`;
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
        м = new THREE.InstancedMesh(geo, материалКорыОбщий.кора, Math.max(8, г.length * 2));
        м.customDepthMaterial = материалКорыОбщий.тень;
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
      // отвести столько, сколько понадобится в самом близком месте, куда глаз
      // дойдёт до следующей раскладки; видно ли лист — решает шейдер
      const ближе = Math.max(d - ШАГ_РАСКЛАДКИ, 1);
      const n = Math.ceil(ш.листьев * Math.min(1, Math.max(ПОЛ, (ПОЛНО / ближе) ** 2)));
      деревоДанные.set([п.x, п.низ, п.z, п.курс], (0 * МАКС + i) * 4);
      деревоДанные.set([п.масштаб, ш.начало, ш.листьев, ш.с.высота], (1 * МАКС + i) * 4);
      const в = оттенок(п);
      деревоДанные.set([ш.цвет.r * в, ш.цвет.g * в, ш.цвет.b * в, 1], (2 * МАКС + i) * 4);
      const куст = КУСТЫ.includes(п.вид);
      деревоДанные.set([куст ? КУСТ_ДАЛЬ : крайДеревьев, куст ? КУСТ_ПОЛОСА : ПОЛОСА, 0, 0], (3 * МАКС + i) * 4);
      суммаДанные[i * 4] = сумма;
      сумма += n;
    });
    деревоТ.needsUpdate = true;
    суммаТ.needsUpdate = true;
    uniforms.uTreeCount.value = по.length;
    if (листМеш !== null) (листМеш.geometry as THREE.InstancedBufferGeometry).instanceCount = форма === null ? 0 : сумма;
    цена = {
      деревьев: по.length, листьев: форма === null ? 0 : сумма, вершинКоры,
      вызовов: кораМеши.size + кроны.length + (форма === null ? 0 : 2), форма: форма === null ? 'нет' : ФОРМЫ[форма].подпись,
    };
  };

  return {
    поставить(новые) {
      посадки = новые;
      убратьКору();
      for (const м of кроны) { сцена.remove(м); м.dispose(); }
      кроны.length = 0;
      const поШаблонам = new Map<string, Посадка[]>();
      for (const п of новые) {
        const ключ = `${п.вид}:${п.вариант % ВАРИАНТОВ}`;
        const г = поШаблонам.get(ключ);
        if (г) г.push(п); else поШаблонам.set(ключ, [п]);
      }
      const матрица = new THREE.Matrix4(), кв = new THREE.Quaternion(), ось = new THREE.Vector3(0, 1, 0), цвет = new THREE.Color();
      for (const [ключ, г] of поШаблонам) {
        const куст = КУСТЫ.includes(г[0].вид);
        const м = new THREE.InstancedMesh(шаблоны.get(ключ)!.крона, куст ? материалКроныКуста : материалКроныДерева, г.length);
        г.forEach((п, i) => {
          кв.setFromAxisAngle(ось, -п.курс);
          матрица.compose(new THREE.Vector3(п.x, п.низ, п.z), кв, new THREE.Vector3(п.масштаб, п.масштаб, п.масштаб));
          м.setMatrixAt(i, матрица);
          const в = оттенок(п);
          м.setColorAt(i, цвет.setRGB(в, в, в));
        });
        м.frustumCulled = false;
        м.name = 'крона';
        сцена.add(м);
        кроны.push(м);
      }
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
      if (Math.hypot(камера.position.x - где.x, камера.position.z - где.z) > ШАГ_РАСКЛАДКИ) {
        где = { x: камера.position.x, z: камера.position.z };
        разложить(где.x, где.z);
        if (ступенями) uniforms.uLeafEye.value.copy(камера.position);
      }
      if (!ступенями) uniforms.uLeafEye.value.copy(камера.position);
    },
  };
}
