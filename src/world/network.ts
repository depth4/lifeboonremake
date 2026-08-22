/**
 * Дорожная сеть: узлы и участки между ними.
 *
 * Главное правило: **две дороги не могут просто наложиться друг на друга.**
 * Если они пересекаются, они делятся в точке пересечения и получают общий узел.
 * Поэтому «два дорожных полотна в одном месте» перестаёт быть выразимым —
 * а именно это рвало землю в дырки и роняло триангуляцию.
 *
 * Про экран и про Three.js этот файл не знает ничего.
 */

import type { Point2, Road, RoadType } from './road.ts';
import { roadWidth, sampleCenterline } from './road.ts';

/** Ближе этого две точки считаем одной. */
const SAME = 0.5;
/**
 * Ближе этого два узла сливаются в один. Иначе площадки двух перекрёстков
 * налезают друг на друга, и землю между ними построить нельзя.
 */
const MERGE = 11;
/** Насколько близко торец должен подойти к дороге, чтобы считаться примыканием. */
const TOUCH = 1.5;
/** Короче этого участок не оставляем: он только мешает. */
const MIN_EDGE = 4;

export interface Node {
  readonly x: number;
  readonly z: number;
  /** сколько участков сходится */
  readonly degree: number;
}

export interface Edge {
  readonly type: RoadType;
  /** осевая линия участка: плотная ломаная от узла до узла */
  readonly line: Point2[];
  readonly from: number;
  readonly to: number;
}

export interface Network {
  readonly nodes: readonly Node[];
  readonly edges: readonly Edge[];
}

const near = (a: Point2, b: Point2): boolean => Math.hypot(a.x - b.x, a.z - b.z) < SAME;

/** Точка пересечения двух отрезков, если она есть строго внутри обоих. */
function crossing(a1: Point2, a2: Point2, b1: Point2, b2: Point2): { t: number; u: number } | null {
  const ax = a2.x - a1.x, az = a2.z - a1.z;
  const bx = b2.x - b1.x, bz = b2.z - b1.z;
  const den = ax * bz - az * bx;
  if (Math.abs(den) < 1e-9) return null;
  const t = ((b1.x - a1.x) * bz - (b1.z - a1.z) * bx) / den;
  const u = ((b1.x - a1.x) * az - (b1.z - a1.z) * ax) / den;
  if (t <= 1e-6 || t >= 1 - 1e-6 || u <= 1e-6 || u >= 1 - 1e-6) return null;
  return { t, u };
}

/** Разбивает дороги на участки в точках пересечения и сшивает их узлами. */
export function planarize(roads: readonly Road[]): Network {
  // каждая дорога — плотная ломаная: делить ломаную можно в любой точке
  const lines: { line: Point2[]; type: RoadType }[] = roads
    .map((road) => ({ line: sampleCenterline(road, 2).map((st) => ({ x: st.x, z: st.z })), type: road.type }))
    .filter((r) => r.line.length >= 2);

  // где какую ломаную резать: номер отрезка -> доли вдоль него
  const cuts: Map<number, { seg: number; t: number }[]> = new Map();
  const addCut = (road: number, seg: number, t: number): void => {
    if (!cuts.has(road)) cuts.set(road, []);
    cuts.get(road)!.push({ seg, t });
  };

  // примыкание торцом: дорога упирается в другую, не пересекая её насквозь
  for (let a = 0; a < lines.length; a++) {
    for (const endIndex of [0, lines[a].line.length - 1]) {
      const tip = lines[a].line[endIndex];
      for (let b = 0; b < lines.length; b++) {
        if (a === b) continue;
        const lb = lines[b].line;
        for (let j = 0; j + 1 < lb.length; j++) {
          const dx = lb[j + 1].x - lb[j].x, dz = lb[j + 1].z - lb[j].z;
          const lenSq = dx * dx + dz * dz;
          if (lenSq < 1e-9) continue;
          let u = ((tip.x - lb[j].x) * dx + (tip.z - lb[j].z) * dz) / lenSq;
          if (u <= 1e-6 || u >= 1 - 1e-6) continue;
          const px = lb[j].x + dx * u, pz = lb[j].z + dz * u;
          if (Math.hypot(tip.x - px, tip.z - pz) > TOUCH) continue;
          addCut(b, j, u);
        }
      }
    }
  }

  for (let a = 0; a < lines.length; a++) {
    for (let b = a; b < lines.length; b++) {
      const la = lines[a].line, lb = lines[b].line;
      for (let i = 0; i + 1 < la.length; i++) {
        const jStart = a === b ? i + 2 : 0;
        for (let j = jStart; j + 1 < lb.length; j++) {
          const hit = crossing(la[i], la[i + 1], lb[j], lb[j + 1]);
          if (!hit) continue;
          addCut(a, i, hit.t);
          addCut(b, j, hit.u);
        }
      }
    }
  }

  const nodes: { x: number; z: number; degree: number }[] = [];
  /**
   * Узлы ближе MERGE сливаются: две площадки перекрёстка рядом не помещаются,
   * и земля между ними построиться не может. Слить — единственный способ
   * сделать такое состояние невыразимым.
   */
  const nodeAt = (p: Point2, merge: boolean): number => {
    const limit = merge ? MERGE : SAME;
    let best = -1;
    let bestDist = limit;
    nodes.forEach((n, i) => {
      const d = Math.hypot(n.x - p.x, n.z - p.z);
      if (d < bestDist) {
        best = i;
        bestDist = d;
      }
    });
    if (best >= 0) return best;
    nodes.push({ x: p.x, z: p.z, degree: 0 });
    return nodes.length - 1;
  };

  const edges: Edge[] = [];

  lines.forEach((road, index) => {
    const list = (cuts.get(index) ?? []).sort((p, q) => (p.seg - q.seg) || (p.t - q.t));
    const pieces: Point2[][] = [];
    let current: Point2[] = [road.line[0]];

    for (let i = 0; i + 1 < road.line.length; i++) {
      for (const cut of list.filter((c) => c.seg === i)) {
        const p = {
          x: road.line[i].x + (road.line[i + 1].x - road.line[i].x) * cut.t,
          z: road.line[i].z + (road.line[i + 1].z - road.line[i].z) * cut.t,
        };
        if (!near(current[current.length - 1], p)) current.push(p);
        pieces.push(current);
        current = [p];
      }
      if (!near(current[current.length - 1], road.line[i + 1])) current.push(road.line[i + 1]);
    }
    pieces.push(current);

    for (const line of pieces) {
      if (line.length < 2) continue;
      const length = line.reduce((sum, p, i) => (i === 0 ? 0 : sum + Math.hypot(p.x - line[i - 1].x, p.z - line[i - 1].z)), 0);
      if (length < MIN_EDGE) continue;
      // концы дорог не сливаем: тупик посреди поля должен остаться на месте
      const from = nodeAt(line[0], true);
      const to = nodeAt(line[line.length - 1], true);
      if (from === to) continue;
      nodes[from].degree++;
      nodes[to].degree++;
      edges.push({ type: road.type, line, from, to });
    }
  });

  return { nodes, edges };
}

/**
 * Насколько подрезать коридор у узла, чтобы полотна не налезали друг на друга.
 * Берём самую широкую из сходящихся дорог с запасом.
 */
export function trimRadius(network: Network, node: number): number {
  let widest = 0;
  for (const edge of network.edges) {
    if (edge.from === node || edge.to === node) widest = Math.max(widest, roadWidth(edge.type) / 2);
  }
  return widest * 1.35 + 1;
}
