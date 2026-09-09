/**
 * Что нарушил игрок.
 *
 * Отдельный файл, потому что это ДРУГОЙ ВОПРОС: `traffic.ts` отвечает
 * «как ехать по правилам», а здесь — «соблюдал ли их тот, кем правила
 * не управляют». Смешивать их нельзя: движение чужих машин не должно
 * ничего знать про счётчик нарушений, а счётчик — про модель следования.
 *
 * ГЛАВНОЕ УСТРОЙСТВО. Ни одно правило здесь заново не пишется. Проезд
 * на красный спрашивается тем же `watch`, которым чужая машина смотрит
 * на свой светофор; сторона дороги — тем же `locate`, которым город находит
 * машину игрока. Вторая копия правила разошлась бы с первой, и тогда
 * «трафик стоит, а игроку ничего не засчитали» стало бы вопросом времени.
 *
 * Каждое нарушение — СОБЫТИЕ, а не состояние: засчитывается один раз,
 * в миг перехода. Поэтому «ехал по встречной десять секунд» — одно
 * нарушение, а не шестьсот.
 */

import type { World } from '../world/world.ts';
import { type Network, locate, watch } from './traffic.ts';
import type { Walker } from './walkers.ts';
import { walkerPose } from './walkers.ts';

/** Одно нарушение: что и когда. */
export interface Offence {
  readonly what: string;
  /** По городским часам, секунды. */
  readonly at: number;
}

/**
 * Память наблюдателя. Нужна ровно для одного — чтобы одно событие
 * не засчиталось дважды. Ничего о правилах она не знает.
 */
export interface Watchdog {
  list: Offence[];
  /** Был ли игрок перед стоп-линией на прошлом шаге. */
  beforeLine: boolean;
  /** Ехал ли он по встречной на прошлом шаге. */
  onWrongSide: boolean;
  /** Кого из пешеходов уже не пропустили на этом переходе. */
  scared: Set<number>;
}

export function newWatchdog(): Watchdog {
  return { list: [], beforeLine: true, onWrongSide: false, scared: new Set() };
}

/** Машина игрока глазами города. */
export interface Player {
  x: number; z: number; yaw: number; speed: number;
}

/** Ближе этого к переходящему пешеходу проезжать нельзя, м. */
const SCARE = 4;
/** Медленнее этого никого не пугают и никуда не выезжают. */
const CRAWL = 2;

/**
 * Шаг наблюдателя. Зовётся каждый кадр, пока игрок за рулём; всё, что нашёл,
 * складывает в `dog.list`.
 */
export function judge(
  world: World, net: Network, dog: Watchdog,
  you: Player, time: number, walkers: readonly Walker[],
): void {
  const at = locate(world, you.x, you.z);
  const add = (what: string): void => { dog.list.push({ what, at: time }); };

  if (at === null) {
    // съехал с дороги — правила перекрёстков к нему уже не относятся
    dog.beforeLine = true;
    dog.onWrongSide = false;
    return;
  }

  const facing = Math.cos(you.yaw) * at.fx + Math.sin(you.yaw) * at.fz;
  const dir = facing >= 0 ? 1 : -1;
  const me = { shape: at.shape, s: at.s, dir };

  /**
   * ── ПРОЕЗД НА КРАСНЫЙ. Ловится в МИГ пересечения стоп-линии: въехал
   * на жёлтый и доехал на красном — это не нарушение, а именно так и надо.
   * Тем же `watch`, что и у чужих машин.
   */
  const ahead = watch(world, net, me, time);
  const before = ahead === null ? true : ahead.stopGap > 0;
  if (dog.beforeLine && !before && ahead !== null
    && ahead.light === 'красный' && Math.abs(you.speed) > 1) {
    add('проезд на красный');
  }
  dog.beforeLine = before;

  /**
   * ── ВСТРЕЧНАЯ ПОЛОСА. Право по ходу — это положительное `across`,
   * умноженное на сторону движения. Считаем только когда кузов ЦЕЛИКОМ
   * за осевой: полметра захода — это не выезд на встречную, а неточность
   * руления. И только на ходу: разворот на месте нарушением не считаем.
   */
  const wrong = at.across * dir < -1.2 && Math.abs(you.speed) > CRAWL;
  if (wrong && !dog.onWrongSide) add('выезд на встречную полосу');
  dog.onWrongSide = wrong;

  /**
   * ── НЕ ПРОПУСТИЛ ПЕШЕХОДА (14.1). Один пешеход на одном переходе —
   * одно нарушение: пока он переходит, он в списке напуганных, и второй
   * раз тот же переход не засчитается.
   */
  walkers.forEach((w, i) => {
    if (w.crossing <= 0) { dog.scared.delete(i); return; }
    if (dog.scared.has(i)) return;
    const pose = walkerPose(world, w);
    if (Math.hypot(pose.x - you.x, pose.z - you.z) < SCARE && Math.abs(you.speed) > CRAWL) {
      dog.scared.add(i);
      add('не пропустил пешехода');
    }
  });
}

/** Сводка: чего и сколько. Свежие сверху. */
export function tally(dog: Watchdog): { what: string; count: number }[] {
  const seen = new Map<string, number>();
  for (const o of dog.list) seen.set(o.what, (seen.get(o.what) ?? 0) + 1);
  return [...seen.entries()]
    .map(([what, count]) => ({ what, count }))
    .sort((a, b) => b.count - a.count);
}
