/**
 * Работа с плоскими областями: объединение, расширение, вычитание.
 *
 * Всё покрытие города — это области на плоскости. Перекрёсток не строится
 * вручную: он ПОЛУЧАЕТСЯ сам, когда коридоры дорог объединяются. Скруглённые
 * углы получаются расширением контура со скруглением стыков. Ручной сшивки
 * торцов, подрезки и площадок больше нет — а значит нет и их поломок.
 *
 * Библиотека считает в целых числах, поэтому метры умножаются на 1000:
 * работаем с точностью до миллиметра, чего для города более чем достаточно.
 */

import ClipperLib from 'clipper-lib';
import type { Point2 } from '../world/road.ts';

const { Clipper, ClipperOffset, ClipType, EndType, JoinType, PolyFillType, PolyType } = ClipperLib;

/** Миллиметры на метр. */
const S = 1000;
/** Насколько мелко дробятся скруглённые стыки. */
const ROUND_PRECISION = 0.02 * S;
/**
 * Ближе этого две точки контура — одна и та же точка, метры.
 * Библиотека честно возвращает пересечения с точностью до миллиметра, и после
 * объединения десятка коридоров в контуре заводятся рёбра длиной в миллиметр.
 * Для картинки они не значат ничего, а любой триангулятор на них ломается.
 * Поэтому область НЕ ВЫХОДИТ отсюда неприбранной: вырожденных контуров
 * снаружи этого файла просто не существует.
 */
const CLEAN = 0.05;
/** Кольцо мельче этого — числовой мусор, а не геометрия, м². */
const CRUMB = 0.05;

/** Кольцо: замкнутая цепочка точек. Область — набор колец (внешние и дырки). */
export type Region = Point2[][];

const toPath = (ring: readonly Point2[]): ClipperLib.Path =>
  ring.map((p) => ({ X: Math.round(p.x * S), Y: Math.round(p.z * S) }));

const fromPaths = (paths: ClipperLib.Paths): Region =>
  Clipper.CleanPolygons(paths, CLEAN * S)
    .filter((path) => path.length >= 3 && Math.abs(Clipper.Area(path)) > CRUMB * S * S)
    .map((path) => path.map((p) => ({ x: p.X / S, z: p.Y / S })));

/** Полоса заданной полуширины вдоль ломаной. Концы срезаны прямо. */
export function corridor(line: readonly Point2[], halfWidth: number): Region {
  if (line.length < 2 || halfWidth <= 0) return [];
  const co = new ClipperOffset(2, ROUND_PRECISION);
  co.AddPath(toPath(line), JoinType.jtRound, EndType.etOpenButt);
  const out: ClipperLib.Paths = [];
  co.Execute(out, halfWidth * S);
  return fromPaths(out);
}

/** Область вокруг точки — кружок. Нужен для скруглений и заглушек. */
export function disc(center: Point2, radius: number): Region {
  if (radius <= 0) return [];
  const co = new ClipperOffset(2, ROUND_PRECISION);
  co.AddPath(toPath([center, center]), JoinType.jtRound, EndType.etOpenRound);
  const out: ClipperLib.Paths = [];
  co.Execute(out, radius * S);
  return fromPaths(out);
}

function combine(kind: number, a: Region, b: Region): Region {
  const clipper = new Clipper();
  if (a.length > 0) clipper.AddPaths(a.map(toPath), PolyType.ptSubject, true);
  if (b.length > 0) clipper.AddPaths(b.map(toPath), PolyType.ptClip, true);
  const out: ClipperLib.Paths = [];
  clipper.Execute(kind, out, PolyFillType.pftNonZero, PolyFillType.pftNonZero);
  return fromPaths(out);
}

export const union = (a: Region, b: Region): Region => combine(ClipType.ctUnion, a, b);
export const subtract = (a: Region, b: Region): Region => combine(ClipType.ctDifference, a, b);
export const intersect = (a: Region, b: Region): Region => combine(ClipType.ctIntersection, a, b);

export function unionAll(regions: readonly Region[]): Region {
  let out: Region = [];
  for (const r of regions) out = union(out, r);
  return out;
}

/** Расширить область наружу со скруглением углов. Отрицательное — сжать. */
export function grow(region: Region, delta: number): Region {
  if (region.length === 0 || delta === 0) return region;
  const co = new ClipperOffset(2, ROUND_PRECISION);
  co.AddPaths(region.map(toPath), JoinType.jtRound, EndType.etClosedPolygon);
  const out: ClipperLib.Paths = [];
  co.Execute(out, delta * S);
  return fromPaths(out);
}

/**
 * Разбивает слишком длинные рёбра контура.
 *
 * Зачем: высота поверхности меняется вдоль земли, а ребро — это прямая.
 * Ребро длиной в сто метров врёт про высоту на всём своём протяжении.
 * После этой операции ребра длиннее шага не бывает, и врать нечему.
 *
 * Деление детерминированное: два одинаковых ребра всегда делятся одинаково,
 * поэтому общая граница двух областей после деления остаётся общей.
 */
export function densify(region: Region, maxEdge: number): Region {
  return region.map((ring) => {
    const out: Point2[] = [];
    for (let i = 0; i < ring.length; i++) {
      const a = ring[i], b = ring[(i + 1) % ring.length];
      out.push(a);
      const steps = Math.ceil(Math.hypot(b.x - a.x, b.z - a.z) / maxEdge);
      for (let k = 1; k < steps; k++) {
        out.push({ x: a.x + ((b.x - a.x) * k) / steps, z: a.z + ((b.z - a.z) * k) / steps });
      }
    }
    return out;
  });
}

/**
 * Точка внутри области. Кольца из библиотеки не пересекаются и вложены
 * правильно, поэтому достаточно чётности: внутри внешнего и внутри дырки
 * даёт два попадания — значит снаружи.
 */
export function contains(region: Region, x: number, z: number): boolean {
  let hits = 0;
  for (const ring of region) {
    let inside = false;
    for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
      const a = ring[i], b = ring[j];
      if ((a.z > z) !== (b.z > z) && x < ((b.x - a.x) * (z - a.z)) / (b.z - a.z) + a.x) inside = !inside;
    }
    if (inside) hits++;
  }
  return hits % 2 === 1;
}

/** То же самое, но с заранее посчитанными рамками колец: для многих вопросов подряд. */
export function inside(region: Region): (x: number, z: number) => boolean {
  const boxes = region.map((ring) => {
    let x0 = Infinity, x1 = -Infinity, z0 = Infinity, z1 = -Infinity;
    for (const p of ring) {
      x0 = Math.min(x0, p.x); x1 = Math.max(x1, p.x);
      z0 = Math.min(z0, p.z); z1 = Math.max(z1, p.z);
    }
    return { x0, x1, z0, z1 };
  });
  return (x, z) => {
    let hits = 0;
    for (let r = 0; r < region.length; r++) {
      const b = boxes[r];
      if (x < b.x0 || x > b.x1 || z < b.z0 || z > b.z1) continue;
      const ring = region[r];
      let is = false;
      for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
        const a = ring[i], c = ring[j];
        if ((a.z > z) !== (c.z > z) && x < ((c.x - a.x) * (z - a.z)) / (c.z - a.z) + a.x) is = !is;
      }
      if (is) hits++;
    }
    return hits % 2 === 1;
  };
}

/** Площадь области в квадратных метрах: внешние кольца плюс, дырки минус. */
export function area(region: Region): number {
  return region.reduce((sum, ring) => sum + Clipper.Area(toPath(ring)) / (S * S), 0);
}

/** Прямоугольник — обычно это край мира. */
export const box = (half: number): Region => [[
  { x: -half, z: -half }, { x: half, z: -half }, { x: half, z: half }, { x: -half, z: half },
]];
