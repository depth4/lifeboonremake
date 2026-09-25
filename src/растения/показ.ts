/**
 * КАК РИСУЕТСЯ ТРАВА. Про мир ничего не решает: где расти и на какой высоте —
 * спрашивает `поле.ts`, где примято — `Примятость`.
 *
 * УСТРОЙСТВО (по чужому опыту — Ghost of Tsushima, Zelda BotW, Crysis):
 *
 * - **травинку не хранят.** Мир поделён на плитки 12 × 12 м. Травинка номер
 *   i в плитке стоит в точке i-го числа последовательности R2 — любой её
 *   отрезок от начала ровно покрывает квадрат. Поэтому «нарисовать меньше
 *   травы вдали» — это просто нарисовать меньше первых номеров, и густота
 *   спадает плавно, без швов между плитками;
 * - **одна плитка — один вызов отрисовки**, все её травинки разом. Плитки
 *   за спиной отсекает сам three по ограничивающей сфере;
 * - **густота падает с квадратом расстояния**, а ширина травинки растёт так,
 *   чтобы покрытие земли на экране не менялось. Так поступают все, кто
 *   рисует траву: вблизи травинки, вдали — цвет;
 * - **ветер — бегущий шум**: по полю катятся порывы, видимые волнами,
 *   и поверх каждая травинка дрожит в своей фазе;
 * - **изгиб — дуга постоянной кривизны**: длина травинки не меняется, как бы
 *   её ни гнуло, и «травинка вытянулась на ветру» невыразимо.
 */

import * as THREE from 'three';
import {
  КЛЕТКА, КЛЕТКА_СЛЕДА, СТОРОНА_СЛЕДА, type Поле, Примятость, высотаПоля,
} from './поле.ts';

/** Ветер, время и шум травы — те же для деревьев: один ветер на всё, что растёт. */
export interface ОбщийВетер {
  readonly uTime: { value: number };
  readonly uWind: { value: number };
  readonly uWindDir: { value: THREE.Vector2 };
  readonly uNoise: { value: THREE.Texture };
}

/** Сторона плитки, м. Меньше — больше вызовов отрисовки; больше — больше лишней работы у ног. */
const ПЛИТКА = 12;

export interface Вариант {
  readonly подпись: string;
  /** Уровни травинки снизу вверх: [доля высоты, доля ширины]. Ширина 0 — остриё, одна точка. */
  readonly вблизи: readonly (readonly [number, number])[];
  readonly вдали: readonly (readonly [number, number])[];
  /** Травинок на квадратный метр у самых ног. */
  readonly густота: number;
  /** Средние высота и ширина травинки, м. */
  readonly высота: number;
  readonly ширина: number;
  /** Насколько нормаль скруглена поперёк травинки: плоская полоска выглядит объёмной. */
  readonly скругление: number;
  /** Насколько травинка просвечивает против солнца. */
  readonly просвет: number;
}

/**
 * Четыре травинки при РАВНОЙ цене: вершин на квадратный метр у ног поровну
 * (около 2800). Сравнивается не «какая красивее», а «на что лучше потратить
 * одни и те же деньги»: на много простых или на мало гладких.
 */
export const ВАРИАНТЫ: Record<string, Вариант> = {
  треугольник: {
    подпись: 'треугольник — одна грань, как в Zelda',
    вблизи: [[0, 1], [1, 0]], вдали: [[0, 1], [1, 0]],
    густота: 900, высота: 0.34, ширина: 0.05, скругление: 0, просвет: 0.25,
  },
  полоска: {
    подпись: 'полоска — прямоугольник без острия',
    вблизи: [[0, 1], [1, 1]], вдали: [[0, 1], [1, 1]],
    густота: 700, высота: 0.32, ширина: 0.022, скругление: 0, просвет: 0.25,
  },
  остриё: {
    подпись: 'полоска с остриём — гнётся в трёх местах',
    вблизи: [[0, 1], [0.42, 0.93], [0.74, 0.72], [1, 0]],
    вдали: [[0, 1], [0.6, 0.8], [1, 0]],
    густота: 400, высота: 0.36, ширина: 0.04, скругление: 0.35, просвет: 0.35,
  },
  гладкая: {
    подпись: 'гладкая — 15 точек, как у Ghost of Tsushima',
    вблизи: [[0, 1], [0.2, 0.97], [0.38, 0.92], [0.54, 0.85], [0.68, 0.75], [0.8, 0.62], [0.9, 0.45], [1, 0]],
    вдали: [[0, 1], [0.45, 0.88], [0.75, 0.6], [1, 0]],
    густота: 190, высота: 0.4, ширина: 0.05, скругление: 0.6, просвет: 0.45,
  },
};
export const ПОРЯДОК = ['остриё', 'треугольник', 'полоска', 'гладкая'] as const;

/** Травинка-заготовка: x — поперёк (−1..1, уже с сужением), y — доля высоты. */
function заготовка(уровни: readonly (readonly [number, number])[]): THREE.BufferGeometry {
  const pos: number[] = [];
  const idx: number[] = [];
  let прошлый: number[] = [];
  for (const [s, w] of уровни) {
    const этот: number[] = [];
    if (w > 0) {
      этот.push(pos.length / 3); pos.push(-w, s, 0);
      этот.push(pos.length / 3); pos.push(w, s, 0);
    } else {
      этот.push(pos.length / 3); pos.push(0, s, 0);
    }
    if (прошлый.length === 2 && этот.length === 2) idx.push(прошлый[0], прошлый[1], этот[1], прошлый[0], этот[1], этот[0]);
    else if (прошлый.length === 2 && этот.length === 1) idx.push(прошлый[0], прошлый[1], этот[0]);
    прошлый = этот;
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  /**
   * Нормаль-пустышка: настоящую считает вершинный шейдер из изгиба. Без неё
   * three сам включает плоское освещение, и нормали из шейдера пропадают.
   */
  g.setAttribute('normal', new THREE.Float32BufferAttribute(new Float32Array(pos.length).fill(0), 3));
  g.setIndex(idx);
  return g;
}

/**
 * Шум для ветра и пятен: 256 × 256, бесшовный, два канала с разным зерном.
 * Не случайность, а функция клетки — одна и та же трава у всех и всегда.
 */
function шум(): THREE.DataTexture {
  const N = 256;
  const data = new Uint8Array(N * N * 4);
  const решётка = (период: number, сид: number): Float32Array => {
    const v = new Float32Array(период * период);
    let s = сид >>> 0;
    for (let k = 0; k < v.length; k++) { s = (s * 1664525 + 1013904223) >>> 0; v[k] = s / 4294967296; }
    return v;
  };
  const октавы = (сид: number): Float32Array => {
    const out = new Float32Array(N * N);
    let вес = 0.5, всего = 0;
    for (const период of [4, 8, 16, 32]) {
      const r = решётка(период, сид + период * 7919);
      for (let y = 0; y < N; y++)
        for (let x = 0; x < N; x++) {
          const fx = (x / N) * период, fy = (y / N) * период;
          const x0 = Math.floor(fx), y0 = Math.floor(fy);
          const tx = fx - x0, ty = fy - y0;
          const sx = tx * tx * (3 - 2 * tx), sy = ty * ty * (3 - 2 * ty);
          const a = r[(y0 % период) * период + (x0 % период)];
          const b = r[(y0 % период) * период + ((x0 + 1) % период)];
          const c = r[((y0 + 1) % период) * период + (x0 % период)];
          const d = r[((y0 + 1) % период) * период + ((x0 + 1) % период)];
          out[y * N + x] += ((a * (1 - sx) + b * sx) * (1 - sy) + (c * (1 - sx) + d * sx) * sy) * вес;
        }
      всего += вес; вес *= 0.5;
    }
    for (let k = 0; k < out.length; k++) out[k] /= всего;
    return out;
  };
  const r = октавы(11), g = октавы(29);
  for (let k = 0; k < N * N; k++) {
    data[k * 4] = Math.round(r[k] * 255);
    data[k * 4 + 1] = Math.round(g[k] * 255);
    data[k * 4 + 3] = 255;
  }
  const t = new THREE.DataTexture(data, N, N, THREE.RGBAFormat);
  t.wrapS = t.wrapT = THREE.RepeatWrapping;
  t.magFilter = t.minFilter = THREE.LinearFilter;
  t.needsUpdate = true;
  return t;
}

const ВЕРШИНА = /* glsl */`
uniform float uTime;
uniform vec2 uWindDir;
uniform float uWind;
uniform vec3 uCam;
uniform sampler2D uHeights;
uniform sampler2D uMask;
uniform vec2 uFieldOrigin;
uniform vec2 uFieldCells;
uniform float uFieldCell;
uniform float uHeightRef;
uniform sampler2D uTrample;
uniform vec2 uTrampleOrigin;
uniform float uTrampleSpan;
uniform sampler2D uNoise;
uniform float uTile;
uniform float uFull;
uniform float uNear;
uniform float uFar;
uniform float uHeight;
uniform float uWidth;
uniform float uRound;
uniform float uTrans;
uniform vec3 uSunDir;
varying vec3 vGrass;
varying float vTrans;

uint grassHash(uint x) { x ^= x >> 16; x *= 0x7feb352du; x ^= x >> 15; x *= 0x846ca68bu; x ^= x >> 16; return x; }
float grassRnd(inout uint s) { s = grassHash(s); return float(s >> 8) / 16777216.0; }
`;

const ТЕЛО = /* glsl */`
  vec3 tileO = vec3(modelMatrix[3].x, 0.0, modelMatrix[3].z);
  ivec2 tileI = ivec2(floor(tileO.xz / uTile + 0.5)) + 32768;
  uint seed = grassHash(uint(tileI.x) * 73856093u ^ uint(tileI.y) * 19349663u);
  uint idx = uint(gl_InstanceID);
  // R2: любой отрезок номеров от нуля ровно покрывает плитку
  float fx = float(idx * 3242174889u + seed) * (1.0 / 4294967296.0);
  float fz = float(idx * 2447445414u + grassHash(seed)) * (1.0 / 4294967296.0);
  vec2 base = tileO.xz + vec2(fx, fz) * uTile;

  float dist = length(base - uCam.xz);
  float keep = min(1.0, (uNear * uNear) / max(dist * dist, 1e-4)) * (1.0 - smoothstep(uFar * 0.72, uFar, dist));
  float rank = (float(idx) + 0.5) / uFull;
  bool alive = rank < keep;

  // где растёт: клетка целиком в траве (поле.ts)
  vec2 fc = (base - uFieldOrigin) / uFieldCell;
  ivec2 ci = ivec2(floor(fc));
  if (ci.x < 0 || ci.y < 0 || ci.x >= int(uFieldCells.x) || ci.y >= int(uFieldCells.y)) alive = false;
  else if (alive && texelFetch(uMask, ci, 0).r < 0.5) alive = false;

  vec3 grassP;
  vec3 objectNormal = vec3(0.0, 1.0, 0.0);
  vGrass = vec3(0.0);
  vTrans = 0.0;
  if (!alive) {
    // мёртвая травинка — одна точка далеко под землёй: ни ветра, ни цвета ей не считаем
    grassP = vec3(base.x, -1.0e4, base.y);
  } else {
    float y0 = texture(uHeights, (fc + 0.5) / (uFieldCells + 1.0)).r + uHeightRef;

    uint s = grassHash(idx ^ (seed * 747796405u));
    float r1 = grassRnd(s), r2 = grassRnd(s), r3 = grassRnd(s), r4 = grassRnd(s), r5 = grassRnd(s);

    // пятна: где трава выше, где суше
    float patchH = texture(uNoise, base * 0.011).r;
    float patchD = texture(uNoise, base * 0.043 + 0.37).g;
    float grow = smoothstep(keep, keep * 0.8, rank);
    // вдали трава опускается в землю, а не обрывается чертой
    float far = smoothstep(uFar * 0.5, uFar, dist);
    float H = uHeight * (0.55 + 0.75 * r2) * (0.55 + 0.9 * patchH) * mix(0.3, 1.0, grow) * (1.0 - 0.8 * far);
    float W = uWidth * (0.75 + 0.5 * r3) * clamp(inversesqrt(max(keep, 0.02)), 1.0, 3.0);

    // своя поза: травинка наклонена туда, куда смотрит её грань
    float leanA = r4 * 6.2831853;
    vec2 own = vec2(cos(leanA), sin(leanA));
    vec3 across = vec3(-own.y, 0.0, own.x);
    vec2 lean = own * (0.1 + 0.35 * r5);

    // ветер: порывы катятся по полю волнами, поверх — дрожь в своей фазе
    float gust = texture(uNoise, base * 0.03 - uWindDir * uTime * 0.075).r;
    float gust2 = texture(uNoise, base * 0.13 - uWindDir * uTime * 0.21 + 0.5).g;
    float push = uWind * (0.1 + 1.25 * gust * gust + 0.3 * gust2);
    float flutter = sin(uTime * (2.6 + 2.2 * r3) + r1 * 25.0 + dot(base, uWindDir) * 1.7) * (0.04 + 0.1 * uWind);
    lean += uWindDir * push + vec2(-uWindDir.y, uWindDir.x) * flutter;

    // примятость: трава ложится туда, куда её вдавили
    vec2 tw = (base - uTrampleOrigin) / uTrampleSpan;
    if (tw.x >= 0.0 && tw.y >= 0.0 && tw.x < 1.0 && tw.y < 1.0) {
      vec4 t = texture(uTrample, fract(base / uTrampleSpan));
      vec2 pd = t.rg * 2.0 - 1.0;
      float pl = length(pd);
      if (pl > 1e-3) lean = mix(lean, pd / pl * 1.45, t.b);
    }

    // дуга постоянной кривизны: длина травинки не меняется
    float m = min(length(lean), 1.5);
    vec2 ld2 = m > 1e-4 ? lean / length(lean) : own;
    vec3 ld = vec3(ld2.x, 0.0, ld2.y);
    float sp = position.y;
    float a = m * sp;
    float up = m < 1e-3 ? H * sp : H * sin(a) / m;
    float fw = m < 1e-3 ? 0.5 * H * m * sp * sp : H * (1.0 - cos(a)) / m;
    vec3 tangent = vec3(0.0, cos(a), 0.0) + ld * sin(a);
    grassP = vec3(base.x, y0, base.y) + vec3(0.0, up, 0.0) + ld * fw + across * position.x * W * 0.5;

    // нормаль: к камере, скруглена поперёк, вдали — к небу, как у земли
    vec3 nrm = normalize(cross(across, tangent));
    float side = dot(nrm, uCam - grassP) < 0.0 ? -1.0 : 1.0;
    nrm *= side;
    nrm = normalize(nrm + across * position.x * uRound * side);
    objectNormal = normalize(mix(nrm, vec3(0.0, 1.0, 0.0), 0.3 + 0.5 * smoothstep(6.0, uFar, dist)));

    // цвет: тёмный корень, светлая верхушка, пятна суше и сочнее
    vec3 root = vec3(0.018, 0.04, 0.008);
    vec3 tipC = vec3(0.15, 0.29, 0.05) * (0.8 + 0.4 * r3);
    tipC = mix(tipC, vec3(0.3, 0.25, 0.09), smoothstep(0.55, 0.85, patchD) * 0.75);
    vec3 col = mix(root, tipC, pow(sp, 0.7));
    col *= mix(1.0, mix(0.6, 1.0, sp), 1.0 - smoothstep(10.0, uFar, dist));
    vGrass = col;
    vTrans = uTrans * pow(max(dot(normalize(grassP - uCam), uSunDir), 0.0), 3.0) * sp;
  }
`;

export interface ЦенаТравы {
  readonly вариант: string;
  /** Плиток в поле зрения = вызовов отрисовки на траву. */
  readonly плиток: number;
  /** Сколько травинок видеокарта обработала и сколько из них вырастет (оценка). */
  readonly травинок: number;
  readonly живых: number;
  readonly вершин: number;
  /** Сумма примятости по окну следа: ноль — никто не мял. */
  readonly примято: number;
}

export interface Трава {
  /** Откуда брать поле: строит его сам вокруг камеры. null — травы нет. */
  /** Откуда брать поле травы: постройка порциями (`полеПоШагам`), по одной на окно. */
  источник(строить: ((окно: { x0: number; z0: number; ширина: number; глубина: number }) => Iterator<void, Поле, void>) | null): void;
  /** Имя варианта или null — выключить. */
  вариант(имя: string | null): void;
  которыйВариант(): string | null;
  /** Сила ветра 0..1.5, направление — угол по земле, радианы. */
  ветер(сила: number, куда?: number): void;
  силаВетра(): number;
  /** Во сколько раз гуще или реже варианта: 0.25..2. Ручка для слабых и сильных компьютеров. */
  густота(доля: number): void;
  readonly примятость: Примятость;
  /** Ветер, время и шум — те же самые для листвы: один ветер на всё, что растёт. */
  readonly ветерОбщий: ОбщийВетер;
  /** Каждый кадр. `время` — секунды мира, а не часов. */
  кадр(камера: THREE.Camera, время: number): void;
  цена(): ЦенаТравы;
}

/** Сторона окна поля, м, и насколько камера может от его середины отойти. */
const ОКНО = 176;
const ОТХОД = 32;
/** Число в половинную точность — быстро, через биты, с округлением до ближайшего. */
const битыЧисла = new Float32Array(1), биты = new Uint32Array(битыЧисла.buffer);
function вПоловину(x: number): number {
  битыЧисла[0] = x;
  const b = биты[0];
  const знак = (b >>> 16) & 0x8000, порядок = ((b >>> 23) & 0xff) - 112, мантисса = b & 0x7fffff;
  if (порядок <= 0) return знак;
  if (порядок >= 31) return знак | 0x7c00;
  // перенос из мантиссы в порядок при округлении — законный: так и растёт число
  return знак | ((порядок << 10) + ((мантисса + 0x1000) >>> 13));
}

/** Сколько миллисекунд кадра отдаётся на постройку следующего поля травы. */
const БЮДЖЕТ_ПОЛЯ = 2.5;

export function создатьТраву(сцена: THREE.Scene, солнце: THREE.DirectionalLight): Трава {
  const примятость = new Примятость();
  const шумТ = шум();
  const следДанные = new Uint8Array(СТОРОНА_СЛЕДА * СТОРОНА_СЛЕДА * 4);
  const следТ = new THREE.DataTexture(следДанные, СТОРОНА_СЛЕДА, СТОРОНА_СЛЕДА, THREE.RGBAFormat);
  следТ.wrapS = следТ.wrapT = THREE.RepeatWrapping;
  следТ.magFilter = следТ.minFilter = THREE.LinearFilter;

  const uniforms = {
    uTime: { value: 0 },
    uWindDir: { value: new THREE.Vector2(0.8, 0.6) },
    uWind: { value: 0.55 },
    uCam: { value: new THREE.Vector3() },
    uHeights: { value: null as THREE.Texture | null },
    uMask: { value: null as THREE.Texture | null },
    uFieldOrigin: { value: new THREE.Vector2() },
    uFieldCells: { value: new THREE.Vector2(1, 1) },
    uFieldCell: { value: КЛЕТКА },
    uHeightRef: { value: 0 },
    uTrample: { value: следТ as THREE.Texture },
    uTrampleOrigin: { value: new THREE.Vector2() },
    uTrampleSpan: { value: КЛЕТКА_СЛЕДА * СТОРОНА_СЛЕДА },
    uNoise: { value: шумТ as THREE.Texture },
    uTile: { value: ПЛИТКА },
    uFull: { value: 1 },
    uNear: { value: 5.5 },
    uFar: { value: 46 },
    uHeight: { value: 0.35 },
    uWidth: { value: 0.04 },
    uRound: { value: 0 },
    uTrans: { value: 0 },
    uSunDir: { value: new THREE.Vector3(0, 1, 0) },
    uSunColor: { value: new THREE.Color() },
  };

  const материал = new THREE.MeshLambertMaterial({ color: 0xffffff, side: THREE.DoubleSide });
  материал.onBeforeCompile = (shader) => {
    Object.assign(shader.uniforms, uniforms);
    shader.vertexShader = ВЕРШИНА + shader.vertexShader
      .replace('#include <beginnormal_vertex>', ТЕЛО)
      .replace('#include <begin_vertex>', 'vec3 transformed = grassP - tileO;');
    shader.fragmentShader = 'varying vec3 vGrass;\nvarying float vTrans;\nuniform vec3 uSunColor;\n' + shader.fragmentShader
      .replace('#include <color_fragment>', 'diffuseColor.rgb *= vGrass;')
      // нормаль уже смотрит на камеру: переворачивать изнанку не надо
      .replace('#include <normal_fragment_begin>',
        'float faceDirection = 1.0;\nvec3 normal = normalize( vNormal );\nvec3 nonPerturbedNormal = normal;')
      .replace('#include <envmap_fragment>', 'outgoingLight += diffuseColor.rgb * uSunColor * vTrans;');
  };
  материал.customProgramCacheKey = () => 'трава';

  let имя: string | null = null;
  let доляГустоты = 1;
  let заготовки: { вблизи: THREE.BufferGeometry; вдали: THREE.BufferGeometry } | null = null;
  let строить: ((окно: { x0: number; z0: number; ширина: number; глубина: number }) => Iterator<void, Поле, void>) | null = null;
  let поле: Поле | null = null;
  let серединаX = Infinity, серединаZ = Infinity;
  /** Поле, которое строится про запас, пока показывается старое. */
  let стройка: { ход: Iterator<void, Упаковка, void>; x: number; z: number } | null = null;
  const плитки = new Map<string, { меш: THREE.Mesh; даль: boolean }>();
  let цена: ЦенаТравы = { вариант: '', плиток: 0, травинок: 0, живых: 0, вершин: 0, примято: 0 };
  const зрение = new THREE.Frustum();
  const экран = new THREE.Matrix4();
  const шар = new THREE.Sphere();

  const убратьПлитки = (): void => {
    for (const { меш } of плитки.values()) { сцена.remove(меш); меш.geometry.dispose(); }
    плитки.clear();
  };

  /** Поле, упакованное для видеокарты: высоты в половинной точности, маска байтами. */
  interface Упаковка { п: Поле; h: Uint16Array; m: Uint8Array; опора: number }

  /**
   * Построить поле И упаковать его — порциями. Упаковка тоже не бесплатна:
   * полмиллиона высот в половинную точность за раз — 30–60 мс, и 25.09 замер
   * (`tools/рывки.mjs`) нашёл рывок именно здесь, когда само поле уже
   * строилось порциями.
   */
  function* собратьПоле(ход: Iterator<void, Поле, void>): Generator<void, Упаковка, void> {
    let r = ход.next();
    while (!r.done) { yield; r = ход.next(); }
    const п = r.value;
    const cx = п.nx + 1, cz = п.nz + 1;
    // высоты — от середины окна: половинной точности хватает на ±30 м вокруг неё
    const опора = п.высоты[Math.floor(cz / 2) * cx + Math.floor(cx / 2)];
    const h = new Uint16Array(cx * cz);
    for (let k = 0; k < h.length; k++) {
      h[k] = вПоловину(п.высоты[k] - опора);
      if ((k & 32767) === 32767) yield;
    }
    const m = new Uint8Array(п.nx * п.nz);
    for (let k = 0; k < m.length; k++) {
      m[k] = п.растёт[k] * 255;
      if ((k & 131071) === 131071) yield;
    }
    return { п, h, m, опора };
  }

  const поставитьПоле = ({ п, h, m, опора }: Упаковка): void => {
    поле = п;
    uniforms.uHeights.value?.dispose();
    uniforms.uMask.value?.dispose();
    const cx = п.nx + 1, cz = п.nz + 1;
    const ht = new THREE.DataTexture(h, cx, cz, THREE.RedFormat, THREE.HalfFloatType);
    ht.magFilter = ht.minFilter = THREE.LinearFilter;
    ht.needsUpdate = true;
    const mt = new THREE.DataTexture(m, п.nx, п.nz, THREE.RedFormat, THREE.UnsignedByteType);
    mt.magFilter = mt.minFilter = THREE.NearestFilter;
    mt.needsUpdate = true;
    uniforms.uHeights.value = ht;
    uniforms.uMask.value = mt;
    uniforms.uFieldOrigin.value.set(п.x0, п.z0);
    uniforms.uFieldCells.value.set(п.nx, п.nz);
    uniforms.uHeightRef.value = опора;
  };

  const задатьВариант = (новое: string | null): void => {
    убратьПлитки();
    заготовки?.вблизи.dispose(); заготовки?.вдали.dispose();
    заготовки = null;
    имя = новое !== null && ВАРИАНТЫ[новое] ? новое : null;
    if (имя === null) return;
    const в = ВАРИАНТЫ[имя];
    заготовки = { вблизи: заготовка(в.вблизи), вдали: заготовка(в.вдали) };
    uniforms.uFull.value = Math.ceil(в.густота * доляГустоты * ПЛИТКА * ПЛИТКА);
    uniforms.uHeight.value = в.высота;
    uniforms.uWidth.value = в.ширина;
    uniforms.uRound.value = в.скругление;
    uniforms.uTrans.value = в.просвет;
  };

  const плиткаНужна = (tx: number, tz: number, даль: boolean): THREE.Mesh => {
    const ключ = `${tx},${tz}`;
    const была = плитки.get(ключ);
    const загот = даль ? заготовки!.вдали : заготовки!.вблизи;
    if (была && была.даль === даль) return была.меш;
    if (была) { сцена.remove(была.меш); была.меш.geometry.dispose(); }
    const g = new THREE.InstancedBufferGeometry();
    g.setAttribute('position', загот.getAttribute('position'));
    g.setAttribute('normal', загот.getAttribute('normal'));
    g.setIndex(загот.getIndex());
    const меш = new THREE.Mesh(g, материал);
    меш.position.set(tx * ПЛИТКА, 0, tz * ПЛИТКА);
    меш.receiveShadow = true;
    меш.castShadow = false;
    меш.name = 'трава';
    сцена.add(меш);
    плитки.set(ключ, { меш, даль });
    return меш;
  };

  return {
    примятость,
    ветерОбщий: { uTime: uniforms.uTime, uWind: uniforms.uWind, uWindDir: uniforms.uWindDir, uNoise: uniforms.uNoise },
    источник(с) {
      строить = с;
      поле = null;
      стройка = null;
      серединаX = Infinity;
      if (с === null) убратьПлитки();
    },
    вариант(новое) { задатьВариант(новое); },
    которыйВариант: () => имя,
    ветер(сила, куда) {
      uniforms.uWind.value = Math.max(0, сила);
      if (куда !== undefined) uniforms.uWindDir.value.set(Math.cos(куда), Math.sin(куда));
    },
    силаВетра: () => uniforms.uWind.value,
    густота(доля) {
      доляГустоты = Math.min(2, Math.max(0.25, доля));
      задатьВариант(имя);
    },
    цена: () => цена,
    кадр(камера, время) {
      /**
       * Трава распрямляется по СВОИМ часам — тем же, по которым дует ветер.
       * Часы одни: остановили время — замер и ветер, и след; съёмка ставит
       * время шагом — и след идёт тем же шагом. Скачок назад или больше
       * секунды — не жизнь, а перестановка часов: его не проживаем.
       */
      const прожито = время - uniforms.uTime.value;
      if (прожито > 0 && прожито < 1) примятость.жить(прожито);
      uniforms.uTime.value = время;
      const cx = камера.position.x, cz = камера.position.z;
      uniforms.uCam.value.copy(камера.position);
      uniforms.uSunDir.value.copy(солнце.position).sub(солнце.target.position).normalize();
      uniforms.uSunColor.value.copy(солнце.color).multiplyScalar(солнце.intensity);

      // окно примятости ходит за камерой; в видеокарту — только если менялось
      примятость.встать(cx, cz);
      if (примятость.изменилось) {
        const N = СТОРОНА_СЛЕДА;
        for (let n = 0; n < N * N; n++) {
          следДанные[n * 4] = Math.round((примятость.кудаX[n] * 0.5 + 0.5) * 255);
          следДанные[n * 4 + 1] = Math.round((примятость.кудаZ[n] * 0.5 + 0.5) * 255);
          следДанные[n * 4 + 2] = Math.round(Math.min(1, примятость.сила[n]) * 255);
        }
        следТ.needsUpdate = true;
        uniforms.uTrampleOrigin.value.set(примятость.i0 * КЛЕТКА_СЛЕДА, примятость.j0 * КЛЕТКА_СЛЕДА);
        примятость.изменилось = false;
      }

      if (имя === null || строить === null || заготовки === null) {
        for (const { меш } of плитки.values()) меш.visible = false;
        цена = { вариант: имя ?? 'нет', плиток: 0, травинок: 0, живых: 0, вершин: 0, примято: 0 };
        return;
      }
      /**
       * Поле — окно вокруг камеры. Новое строится ЗАРАНЕЕ и ПОРЦИЯМИ: стоило
       * отойти на пол-отхода — начинаем, по `БЮДЖЕТ_ПОЛЯ` мс за кадр, а до
       * готовности показывается старое (у окна 176 м запас в полсотни метров).
       * До 25.09 поле строилось целиком в один кадр — 40–70 мс на «большом
       * городе», и это был рывок раз в 32 м пути (Алекс: «рывки при ходьбе»).
       * Целиком за раз — только первое поле, когда показывать ещё нечего,
       * и когда камера умчалась за край старого.
       */
      const отошли = Math.hypot(cx - серединаX, cz - серединаZ);
      if (стройка === null && (поле === null || отошли > ОТХОД / 2)) {
        const x0 = Math.floor((cx - ОКНО / 2) / КЛЕТКА) * КЛЕТКА;
        const z0 = Math.floor((cz - ОКНО / 2) / КЛЕТКА) * КЛЕТКА;
        стройка = { ход: собратьПоле(строить({ x0, z0, ширина: ОКНО, глубина: ОКНО })), x: cx, z: cz };
      }
      if (стройка !== null) {
        const срочно = поле === null || отошли > ОКНО / 2 - 24;
        const начало = performance.now();
        let шаг = стройка.ход.next();
        while (!шаг.done && (срочно || performance.now() - начало < БЮДЖЕТ_ПОЛЯ)) шаг = стройка.ход.next();
        if (шаг.done) {
          поставитьПоле(шаг.value);
          серединаX = стройка.x; серединаZ = стройка.z;
          стройка = null;
        }
      }

      const в = ВАРИАНТЫ[имя];
      const R = uniforms.uFar.value, near = uniforms.uNear.value, full = uniforms.uFull.value;
      // что в поле зрения, решаем сами: тогда цена считает только нарисованное
      камера.updateMatrixWorld();
      экран.multiplyMatrices(камера.projectionMatrix, камера.matrixWorldInverse);
      зрение.setFromProjectionMatrix(экран);
      const нужны = new Set<string>();
      let плиток = 0, травинок = 0, живых = 0, вершин = 0;
      const tx0 = Math.floor((cx - R) / ПЛИТКА), tx1 = Math.floor((cx + R) / ПЛИТКА);
      const tz0 = Math.floor((cz - R) / ПЛИТКА), tz1 = Math.floor((cz + R) / ПЛИТКА);
      const вершинВблизи = заготовки.вблизи.getAttribute('position').count;
      const вершинВдали = заготовки.вдали.getAttribute('position').count;
      for (let tx = tx0; tx <= tx1; tx++)
        for (let tz = tz0; tz <= tz1; tz++) {
          const bx = Math.max(tx * ПЛИТКА - cx, 0, cx - (tx + 1) * ПЛИТКА);
          const bz = Math.max(tz * ПЛИТКА - cz, 0, cz - (tz + 1) * ПЛИТКА);
          const ближе = Math.hypot(bx, bz);
          if (ближе > R) continue;
          const keep = Math.min(1, (near * near) / Math.max(ближе * ближе, 1e-4));
          const count = Math.ceil(full * keep);
          const даль = ближе > 14;
          const меш = плиткаНужна(tx, tz, даль);
          const g = меш.geometry as THREE.InstancedBufferGeometry;
          g.instanceCount = count;
          const hc = поле !== null ? высотаПоля(поле, (tx + 0.5) * ПЛИТКА, (tz + 0.5) * ПЛИТКА) : 0;
          if (!g.boundingSphere) g.boundingSphere = new THREE.Sphere();
          g.boundingSphere.center.set(ПЛИТКА / 2, hc, ПЛИТКА / 2);
          g.boundingSphere.radius = ПЛИТКА * 0.72 + 3;
          нужны.add(`${tx},${tz}`);
          шар.center.set((tx + 0.5) * ПЛИТКА, hc, (tz + 0.5) * ПЛИТКА);
          шар.radius = g.boundingSphere.radius;
          меш.visible = зрение.intersectsSphere(шар);
          if (!меш.visible) continue;
          плиток++;
          травинок += count;
          // живых — по той же густоте, что в шейдере, средней по плитке (без маски)
          let сумма = 0;
          for (let a = 0; a < 4; a++)
            for (let b = 0; b < 4; b++) {
              const d = Math.hypot((tx + (a + 0.5) / 4) * ПЛИТКА - cx, (tz + (b + 0.5) / 4) * ПЛИТКА - cz);
              сумма += Math.min(1, (near * near) / Math.max(d * d, 1e-4)) * (d > R ? 0 : 1);
            }
          живых += full * сумма / 16;
          вершин += count * (даль ? вершинВдали : вершинВблизи);
        }
      for (const [ключ, п] of плитки) {
        if (нужны.has(ключ)) continue;
        сцена.remove(п.меш); п.меш.geometry.dispose(); плитки.delete(ключ);
      }
      let примято = 0;
      for (let n = 0; n < примятость.сила.length; n++) примято += примятость.сила[n];
      цена = { вариант: в.подпись, плиток, травинок, живых: Math.round(живых), вершин, примято: Math.round(примято) };
    },
  };
}
