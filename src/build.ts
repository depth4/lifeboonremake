/**
 * Инструмент строительства дорог.
 *
 * Порядок работы:
 *   клик по земле            — начало линии
 *   ведёшь                   — предпросмотр прямого участка
 *   клик                     — участок зафиксирован, ведёшь дальше
 *   зажал и потянул          — участок изгибается, как пером в Inkscape
 *   Esc / двойной клик       — линия закончена, включается настройка ширины
 *   ведёшь, потом клик       — число полос щёлкает: 1, 2, 3, 4
 *
 * Инструмент не лепит асфальт. Он задаёт осевую линию и число полос —
 * ровно то же самое, что позже будет делать импортёр реальных карт.
 */

import type { Point2, Road } from './world/road.ts';
import type { Viewer } from './render.ts';
import { roadTypeForLanes } from './world/road.ts';

export type Phase = 'off' | 'idle' | 'drawing' | 'width';

export interface Builder {
  /** к чему сейчас прилипнет курсор; пустая строка — ни к чему */
  snapped(): string;
  /** Включить или выключить режим строительства. */
  setActive(on: boolean): void;
  phase(): Phase;
  lanes(): number;
  /** Прервать текущее действие. */
  cancel(): void;
  /** Убрать последнюю построенную дорогу. */
  undo(): boolean;
}

export interface BuilderOptions {
  readonly viewer: Viewer;
  readonly canvas: HTMLElement;
  readonly roads: Road[];
  /** Дороги изменились — мир пересобрать. */
  readonly onChanged: () => void;
  /** Состояние инструмента изменилось — обновить подсказку. */
  readonly onState: () => void;
  /** Показать призрак будущей дороги. */
  readonly preview: (road: Road | null) => void;
  /**
   * Привязка к существующей сети. Инструмент не заставляет игрока попадать
   * мышью в пиксель: он распознаёт намерение и подставляет точную точку.
   */
  readonly snap: (point: Point2) => { point: Point2; kind: string } | null;
}

/** Ближе этого точки подряд не ставим — кривая вырождается. */
const MIN_STEP = 5;
/** На сколько пикселей надо увести мышь, чтобы это считалось «зажал и потянул». */
const DRAG_THRESHOLD = 5;
/** Сколько пикселей движения мыши стоит одна полоса. */
const PIXELS_PER_LANE = 70;
/** На сколько точек разбивается изогнутый участок. */
const CURVE_STEPS = 6;

export function createBuilder(options: BuilderOptions): Builder {
  const { viewer, canvas, roads, onChanged, onState, preview, snap } = options;
  let snapKind = '';

  /** Точка под курсором с учётом привязки. */
  const place = (event: PointerEvent | MouseEvent): Point2 | null => {
    const raw = viewer.pick(event);
    if (!raw) {
      snapKind = '';
      return null;
    }
    const hit = snap(raw);
    snapKind = hit ? hit.kind : '';
    return hit ? hit.point : raw;
  };

  let phase: Phase = 'off';
  let points: Point2[] = [];
  let lanes = 1;
  let roadIndex = -1;

  let pressScreen: { x: number; y: number } | null = null;
  let pressGround: Point2 | null = null;
  let handle: Point2 | null = null;
  let widthAnchor = 0;
  let lanesAtAnchor = 1;

  const roadOf = (line: Point2[]): Road | null =>
    line.length >= 2 ? { type: roadTypeForLanes(lanes), centerline: line } : null;

  /** Изогнутый участок: квадратичная кривая, разложенная в точки осевой линии. */
  const curveTo = (from: Point2, to: Point2, pulled: Point2): Point2[] => {
    const control = { x: to.x * 2 - pulled.x, z: to.z * 2 - pulled.z };
    const line: Point2[] = [];
    for (let i = 1; i <= CURVE_STEPS; i++) {
      const t = i / CURVE_STEPS;
      const u = 1 - t;
      line.push({
        x: u * u * from.x + 2 * u * t * control.x + t * t * to.x,
        z: u * u * from.z + 2 * u * t * control.z + t * t * to.z,
      });
    }
    return line;
  };

  const commit = (): void => {
    const road = roadOf([...points]);
    if (!road) return;
    if (roadIndex < 0) {
      roads.push(road);
      roadIndex = roads.length - 1;
    } else {
      roads[roadIndex] = road;
    }
    onChanged();
  };

  const reset = (): void => {
    phase = phase === 'off' ? 'off' : 'idle';
    points = [];
    roadIndex = -1;
    handle = null;
    pressScreen = null;
    pressGround = null;
    preview(null);
    onState();
  };

  const previewLine = (tail: Point2[]): void => {
    preview(roadOf([...points, ...tail]));
  };

  canvas.addEventListener('pointerdown', (event) => {
    if (phase === 'off' || event.button !== 0) return;
    pressScreen = { x: event.clientX, y: event.clientY };
    pressGround = place(event);
    handle = null;
  });

  canvas.addEventListener('pointermove', (event) => {
    if (phase === 'off') return;

    if (phase === 'width') {
      const next = Math.max(1, Math.min(4, lanesAtAnchor + Math.round((event.clientX - widthAnchor) / PIXELS_PER_LANE)));
      if (next !== lanes) {
        lanes = next;
        previewLine([]);
        onState();
      }
      return;
    }

    const before = snapKind;
    const ground = place(event);
    if (before !== snapKind) onState();
    if (!ground) return;

    // зажал и тянет — участок изгибается
    if (pressScreen && pressGround && phase === 'drawing') {
      const moved = Math.hypot(event.clientX - pressScreen.x, event.clientY - pressScreen.y);
      if (moved > DRAG_THRESHOLD) {
        handle = ground;
        previewLine(curveTo(points[points.length - 1], pressGround, ground));
        return;
      }
    }

    if (phase === 'drawing') previewLine([ground]);
  });

  canvas.addEventListener('pointerup', (event) => {
    if (phase === 'off' || event.button !== 0) return;

    if (phase === 'width') {
      commit();
      reset();
      return;
    }

    const press = pressScreen;
    const ground = pressGround ?? place(event);
    pressScreen = null;
    pressGround = null;
    if (!press || !ground) return;

    const moved = Math.hypot(event.clientX - press.x, event.clientY - press.y);

    if (phase === 'idle') {
      if (moved > DRAG_THRESHOLD) return; // это был поворот камеры, а не клик
      points = [ground];
      phase = 'drawing';
      onState();
      return;
    }

    const last = points[points.length - 1];
    if (Math.hypot(ground.x - last.x, ground.z - last.z) < MIN_STEP) return;

    points.push(...(handle && moved > DRAG_THRESHOLD ? curveTo(last, ground, handle) : [ground]));
    handle = null;
    commit();
    previewLine([]);
    onState();
  });

  canvas.addEventListener('dblclick', () => finish());
  addEventListener('keydown', (event) => {
    if (event.key !== 'Escape') return;
    if (phase === 'width') {
      commit();
      reset();
    } else {
      finish();
    }
  });

  function finish(): void {
    if (phase !== 'drawing') return;
    if (points.length < 2) return reset();
    phase = 'width';
    widthAnchor = innerWidth / 2;
    lanesAtAnchor = lanes;
    previewLine([]);
    onState();
  }

  return {
    setActive(on) {
      phase = on ? 'idle' : 'off';
      points = [];
      roadIndex = -1;
      preview(null);
      viewer.setBuilding(on);
      onState();
    },
    phase: () => phase,
    lanes: () => lanes,
    snapped: () => snapKind,
    cancel: () => reset(),
    undo() {
      reset();
      if (roads.length === 0) return false;
      roads.pop();
      onChanged();
      onState();
      return true;
    },
  };
}
