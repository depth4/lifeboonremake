/**
 * Инструмент строительства дорог.
 *
 * Инструмент не лепит асфальт. Он добавляет точки в осевую линию —
 * ровно то же самое, что позже будет делать импортёр реальных карт.
 * Поэтому дорога, построенная руками, и дорога, пришедшая из данных,
 * это один и тот же объект, а не два похожих.
 */

import type { Point2, Road, RoadType } from './world/road.ts';
import type { Viewer } from './render.ts';

export interface Builder {
  /** Выбрать тип дороги и войти в режим строительства. null — просто смотреть. */
  setType(type: RoadType | null): void;
  /** Закончить текущую дорогу. */
  finish(): void;
  /** Убрать последнюю построенную дорогу. */
  undo(): boolean;
  isBuilding(): boolean;
}

export interface BuilderOptions {
  readonly viewer: Viewer;
  readonly canvas: HTMLElement;
  /** Список дорог мира — инструмент правит его на месте. */
  readonly roads: Road[];
  /** Позвать, когда дороги изменились: мир надо пересобрать. */
  readonly onChanged: () => void;
  /** Позвать, когда сменилось состояние инструмента: обновить подсказку. */
  readonly onState: () => void;
  /** Предпросмотр линии: во что она превратится. */
  readonly preview: (road: Road | null) => void;
}

/** Ближе этого две точки подряд не ставим — иначе кривая вырождается. */
const MIN_STEP = 6;

export function createBuilder(options: BuilderOptions): Builder {
  const { viewer, canvas, roads, onChanged, onState, preview } = options;

  let type: RoadType | null = null;
  let draft: Point2[] = [];
  let draftIndex = -1;
  let pressedAt: { x: number; y: number } | null = null;

  const clearDraft = (): void => {
    draft = [];
    draftIndex = -1;
    preview(null);
  };

  const showPreview = (cursor: Point2 | null): void => {
    if (!type || draft.length === 0) return preview(null);
    const line = cursor ? [...draft, cursor] : draft;
    preview(line.length >= 2 ? { type, centerline: line } : null);
  };

  const commit = (): void => {
    if (!type || draft.length < 2) return;
    const road: Road = { type, centerline: [...draft] };
    if (draftIndex < 0) {
      roads.push(road);
      draftIndex = roads.length - 1;
    } else {
      roads[draftIndex] = road;
    }
    onChanged();
  };

  const addPoint = (point: Point2): void => {
    const last = draft.at(-1);
    if (last && Math.hypot(point.x - last.x, point.z - last.z) < MIN_STEP) return;
    draft.push(point);
    commit();
    showPreview(null);
    onState();
  };

  canvas.addEventListener('pointerdown', (event) => {
    if (!type || event.button !== 0) return;
    pressedAt = { x: event.clientX, y: event.clientY };
  });

  canvas.addEventListener('pointerup', (event) => {
    if (!type || event.button !== 0 || !pressedAt) return;
    const moved = Math.hypot(event.clientX - pressedAt.x, event.clientY - pressedAt.y);
    pressedAt = null;
    if (moved > 4) return;
    const point = viewer.pick(event);
    if (point) addPoint(point);
  });

  canvas.addEventListener('pointermove', (event) => {
    if (!type || draft.length === 0) return;
    showPreview(viewer.pick(event));
  });

  canvas.addEventListener('dblclick', () => {
    if (type) builder.finish();
  });

  addEventListener('keydown', (event) => {
    if (event.key === 'Escape') builder.finish();
  });

  const builder: Builder = {
    setType(next) {
      builder.finish();
      type = next;
      viewer.setBuilding(next !== null);
      onState();
    },
    finish() {
      clearDraft();
      onState();
    },
    undo() {
      clearDraft();
      if (roads.length === 0) return false;
      roads.pop();
      onChanged();
      onState();
      return true;
    },
    isBuilding() {
      return type !== null && draft.length > 0;
    },
  };

  return builder;
}
