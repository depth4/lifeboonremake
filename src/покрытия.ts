/**
 * КАК ВЫГЛЯДЯТ ПОКРЫТИЯ: асфальт, тротуар, бордюр, разметка — с износом.
 *
 * Зачем. 28.09 Алекс: «ямы, много ям-трещин, бордюров; тротуары
 * разнообразные — по всему этому у нас ноль». Дорога была ровной краской
 * одного цвета: так выглядит макет, а не улица, по которой ездят двадцать
 * лет.
 *
 * Как. Износ — ФУНКЦИЯ МЕСТА на земле, её считает шейдер: заплата,
 * трещина, яма, лужа, стёртая разметка, плитка или старый асфальт на
 * тротуаре. Ничего не хранится, поэтому одно и то же место всегда выглядит
 * одинаково, с любой стороны и после перезагрузки, и данных у города не
 * прибавилось. Форма земли не меняется (`src/surface` не трогается):
 * ямы и трещины читаются светом — нормаль наклоняется по «высоте» износа,
 * как в играх делают рельефом по карте высот.
 *
 * Лужа — в яме, и отражает небо у горизонта: цвет дымки (`fogColor`) —
 * тот же, что у неба. Поэтому лужа ночью тёмная, а на закате розовая сама.
 */

import * as THREE from 'three';
import type { Material } from './surface/index.ts';

/** Шум: хеш, шум значений, фрактальный шум, расстояние до края ячеек. */
export const ШУМ = /* glsl */`
// хеш без синуса (Dave Hoskins): синус больших чисел во float теряет
// точность и рисует решётку — так было со звёздами (решение 114)
float pkH(vec2 p) { vec3 p3 = fract(vec3(p.xyx) * 0.1031); p3 += dot(p3, p3.yzx + 33.33); return fract((p3.x + p3.y) * p3.z); }
vec2 pkH2(vec2 p) { vec3 p3 = fract(vec3(p.xyx) * vec3(0.1031, 0.1030, 0.0973)); p3 += dot(p3, p3.yzx + 33.33); return fract((p3.xx + p3.yz) * p3.zy); }
float pkN(vec2 p) {
  vec2 i = floor(p), f = fract(p);
  f = f * f * (3.0 - 2.0 * f);
  return mix(mix(pkH(i), pkH(i + vec2(1, 0)), f.x), mix(pkH(i + vec2(0, 1)), pkH(i + vec2(1, 1)), f.x), f.y);
}
float pkF(vec2 p) {
  float s = 0.0, a = 0.5;
  for (int k = 0; k < 4; k++) { s += a * pkN(p); p = p * 2.07 + vec2(13.7, 7.3); a *= 0.5; }
  return s;
}
// расстояние до ближайшего шва между ячейками (ячейки Вороного) — рисунок трещин
float pkEdge(vec2 p) {
  vec2 i = floor(p), f = fract(p);
  float d1 = 8.0, d2 = 8.0;
  for (int y = -1; y <= 1; y++) for (int x = -1; x <= 1; x++) {
    vec2 g = vec2(float(x), float(y));
    vec2 o = pkH2(i + g);
    float d = length(g + o - f);
    if (d < d1) { d2 = d1; d1 = d; } else if (d < d2) d2 = d;
  }
  return d2 - d1;
}
`;

/**
 * Износ асфальта в точке: x — множитель цвета, y — «высота» (минус — яма,
 * трещина), z — вода (0…1). Одна функция на цвет, на свет и на лужу —
 * яма не может оказаться нарисованной в одном месте, а тёмной в другом.
 */
const АСФАЛЬТ = /* glsl */`
vec3 asphaltWear(vec2 p) {
  float tone = 1.0 + (pkF(p * 0.045) - 0.5) * 0.28 + (pkH(floor(p * 30.0)) - 0.5) * 0.07;
  float h = 0.0, water = 0.0;
  // заплаты: прямоугольники свежего асфальта в ячейках 7 м, со швом по краю
  vec2 c7 = floor(p / 7.0), l7 = fract(p / 7.0) * 7.0;
  vec2 r = pkH2(c7 + 3.3);
  if (pkH(c7) < 0.16) {
    vec2 lo = r * 3.0 + 0.5, hi = lo + 1.5 + pkH2(c7 + 9.1) * 3.0;
    vec2 inside = step(lo, l7) * step(l7, hi);
    float pat = inside.x * inside.y;
    vec2 e = min(l7 - lo, hi - l7);
    float seam = pat * (1.0 - smoothstep(0.0, 0.06, min(e.x, e.y)));
    tone *= mix(1.0, 0.72, pat) * (1.0 - 0.45 * seam);
    h += pat * 0.004;
  }
  // трещины: сетка «крокодиловой кожи» там, где асфальт старый, и длинные трещины
  float old = smoothstep(0.45, 0.7, pkF(p * 0.06 + 11.0));
  float net = 1.0 - smoothstep(0.0, 0.035, pkEdge(p * 0.9));
  float longc = 1.0 - smoothstep(0.0, 0.02, pkEdge(p * vec2(0.12, 0.5)));
  float crack = max(net * old, longc * smoothstep(0.35, 0.6, pkN(p * 0.08)));
  tone *= 1.0 - 0.5 * crack;
  h -= crack * 0.012;
  // ямы: в ячейках 9 м, не во всех; в половине — вода
  vec2 c9 = floor(p / 9.0);
  if (pkH(c9 + 1.7) < 0.22) {
    vec2 at = (c9 + 0.2 + pkH2(c9 + 5.5) * 0.6) * 9.0;
    vec2 rr = vec2(0.35, 0.25) + pkH2(c9 + 2.2) * vec2(0.55, 0.4);
    vec2 q = (p - at) / rr;
    q += (vec2(pkN(p * 3.0), pkN(p * 3.0 + 4.0)) - 0.5) * 0.5;
    float rq = length(q);
    float hole = 1.0 - smoothstep(0.85, 1.0, rq);
    float rim = smoothstep(0.8, 1.0, rq) * (1.0 - smoothstep(1.0, 1.25, rq));
    tone *= mix(1.0, 0.62, hole) * (1.0 + 0.25 * rim);
    h -= hole * 0.06 * (1.0 - rq * rq);
    water = hole * step(0.5, pkH(c9 + 8.8)) * smoothstep(0.95, 0.6, rq);
  }
  return vec3(tone, h, water);
}
`;

/** Тротуар: плитка или старый асфальт — кусками вдоль улицы, как ремонтировали. */
const ТРОТУАР = /* glsl */`
vec3 sidewalkWear(vec2 p) {
  float tiles = step(0.5, pkN(floor(p / 18.0) + 0.37));
  float tone, h = 0.0;
  if (tiles > 0.5) {
    // плитка 0.3 м: шов, свой тон у каждой, изредка треснувшая или просевшая
    vec2 t = p / 0.3, ft = fract(t), it = floor(t);
    float joint = 1.0 - smoothstep(0.0, 0.05, min(min(ft.x, 1.0 - ft.x), min(ft.y, 1.0 - ft.y)));
    float rt = pkH(it);
    tone = 1.02 + (rt - 0.5) * 0.12;
    tone *= 1.0 - 0.35 * joint;
    tone *= mix(1.0, 0.8, step(0.975, rt));
    h -= joint * 0.004 + step(0.985, rt) * 0.01;
  } else {
    // старый асфальт тротуара: пятнами, в трещинах — трава
    tone = 0.92 + (pkF(p * 0.2) - 0.5) * 0.3;
    float crack = 1.0 - smoothstep(0.0, 0.03, pkEdge(p * 0.7));
    tone *= 1.0 - 0.45 * crack;
    h -= crack * 0.01;
  }
  // грязь к краям не знаем где — пятнами по всей ширине
  tone *= 1.0 - 0.12 * smoothstep(0.55, 0.8, pkF(p * 0.35 + 21.0));
  return vec3(tone, h, tiles);
}
`;

/**
 * Материал покрытия. Для травы, асфальта, тротуара, бордюра, разметки —
 * один стандартный материал с цветом вершин, как было, плюс износ своего
 * вида.
 */
export function материалПокрытия(вид: Material): THREE.MeshStandardMaterial {
  const м = new THREE.MeshStandardMaterial({
    vertexColors: true,
    roughness: вид === 'marking' ? 0.7 : 0.96,
    metalness: 0,
    // краска лежит на асфальте: пусть всегда ложится поверх него, а не
    // спорит с ним за пиксель
    polygonOffset: вид === 'marking',
    polygonOffsetFactor: -2,
    polygonOffsetUnits: -2,
  });
  if (вид === 'grass') return м;
  м.onBeforeCompile = (shader) => {
    shader.vertexShader = 'varying vec3 vPk;\n' + shader.vertexShader.replace('#include <begin_vertex>',
      '#include <begin_vertex>\n  vPk = (modelMatrix * vec4(transformed, 1.0)).xyz;');
    const тело = вид === 'asphalt' ? /* glsl */`
      vec3 wear = asphaltWear(vPk.xz);
      diffuseColor.rgb *= wear.x;
      pkHeight = wear.y; pkWater = wear.z;` : вид === 'sidewalk' ? /* glsl */`
      vec3 wear = sidewalkWear(vPk.xz);
      diffuseColor.rgb *= wear.x;
      pkHeight = wear.y;` : вид === 'marking' ? /* glsl */`
      // краска стёрта пятнами и по колеям: сквозь неё видно асфальт
      float worn = smoothstep(0.42, 0.62, pkF(vPk.xz * 1.3));
      diffuseColor.rgb = mix(diffuseColor.rgb, vec3(0.16, 0.16, 0.17), worn * 0.85);
      diffuseColor.rgb *= 0.9;` : /* glsl */`
      // бордюр: сколы, грязь, камни разного тона
      float chip = step(0.8, pkN(vPk.xz * 6.0));
      diffuseColor.rgb *= (0.9 + (pkN(vPk.xz * 1.1) - 0.5) * 0.25) * (1.0 - 0.3 * chip);`;
    shader.fragmentShader = 'varying vec3 vPk;\nfloat pkHeight = 0.0;\nfloat pkWater = 0.0;\n' + ШУМ + АСФАЛЬТ + ТРОТУАР
      + shader.fragmentShader
        .replace('#include <color_fragment>', '#include <color_fragment>\n{' + тело + '\n}')
        .replace('#include <roughnessmap_fragment>', '#include <roughnessmap_fragment>\n  roughnessFactor = mix(roughnessFactor, 0.08, pkWater);')
        .replace('#include <normal_fragment_maps>', /* glsl */`#include <normal_fragment_maps>
  {
    // рельеф износа — наклоном нормали по «высоте», без изменения земли
    vec2 gradH = vec2(dFdx(pkHeight), dFdy(pkHeight));
    vec3 dpx = dFdx(-vViewPosition), dpy = dFdy(-vViewPosition);
    vec3 r1 = cross(dpy, normal), r2 = cross(normal, dpx);
    float det = dot(dpx, r1);
    if (abs(det) > 1e-8) normal = normalize(abs(det) * normal - sign(det) * (gradH.x * r1 + gradH.y * r2) * 6.0);
  }`)
        .replace('#include <fog_fragment>', /* glsl */`
  #ifdef USE_FOG
    // лужа отражает небо у горизонта — это цвет дымки; сильнее, чем положе взгляд
    float pkFres = pow(1.0 - clamp(dot(normalize(vViewPosition), normal), 0.0, 1.0), 3.0);
    gl_FragColor.rgb = mix(gl_FragColor.rgb, fogColor * 0.85, pkWater * (0.35 + 0.55 * pkFres));
  #endif
  #include <fog_fragment>`);
  };
  м.customProgramCacheKey = () => `покрытие-${вид}`;
  return м;
}
