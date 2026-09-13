/**
 * Что ГЛАЗ делает с картинкой. Не украшения, а то, чем зрение отличается
 * от фотоаппарата, и то, чем маскируется дешёвая геометрия.
 *
 * Четыре вещи, и каждая отвечает на вопрос «почему это выглядит настоящим»:
 *
 * 1. **Резко только там, куда смотришь.** Расстояние наводки СЧИТАЕТСЯ здесь
 *    и плавно ведётся за взглядом (глазу на перенаводку нужно три десятых
 *    секунды), но пока никуда не применяется. Готовый проход глубины резкости
 *    из three пришлось снять: он рисует сцену вторым заходом и ломает цвет —
 *    кадр выцветал и мылился целиком, это видно на снимках. Нужен свой,
 *    по карте глубины; это следующий шаг, и он не про «добавить», а про
 *    «сделать правильно».
 * 2. **Смаз при повороте ГОЛОВЫ, но не глаз.** Когда глаз прыгает, мир не
 *    смазывается: зрение на время скачка выключается, и картинка остаётся
 *    резкой. А когда поворачивается голова, мир смазывается по-настоящему.
 *    Поэтому смаз здесь считается от скорости ГОЛОВЫ и только от неё — и это
 *    единственное, по чему глазом видно разницу между «стрельнул глазами»
 *    и «повернул голову».
 * 3. **Свечение вокруг яркого** — будет, когда появятся настоящие источники
 *    света. Небо светиться не должно: от этого выцветает весь кадр.
 * 4. **Мягкие края.** Резко человек видит два градуса в середине; края поля
 *    зрения тусклее. Лёгкое затемнение по углам читается как «это мои глаза»,
 *    а не «это окно».
 */

import * as THREE from 'three';
import { EffectComposer } from 'three/examples/jsm/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/examples/jsm/postprocessing/RenderPass.js';
import { AfterimagePass } from 'three/examples/jsm/postprocessing/AfterimagePass.js';
import { ShaderPass } from 'three/examples/jsm/postprocessing/ShaderPass.js';
import { VignetteShader } from 'three/examples/jsm/shaders/VignetteShader.js';
import { OutputPass } from 'three/examples/jsm/postprocessing/OutputPass.js';

/** За сколько глаз перенаводится на новое расстояние, с. */
const FOCUS_TIME = 0.32;
/** Как часто спрашивать «на что я смотрю», с. Чаще незачем: глаз медленнее. */
const ASK_EVERY = 0.09;
/** Ниже этой скорости головы смаза нет совсем, рад/с. */
const SMEAR_FROM = 0.9;
/** При какой скорости головы смаз максимальный, рад/с. */
const SMEAR_FULL = 4.5;
/** Самый сильный смаз. Больше — каша, и читается как грязное стекло. */
const SMEAR_MAX = 0.58;

export interface Sight {
  /** Нарисовать кадр глазами. `headRate` — скорость поворота ГОЛОВЫ, рад/с. */
  render(headRate: number, dt: number): void;
  resize(width: number, height: number): void;
  dispose(): void;
}


export function createSight(
  renderer: THREE.WebGLRenderer,
  scene: THREE.Scene,
  camera: THREE.PerspectiveCamera,
): Sight {
  const composer = new EffectComposer(renderer);
  composer.addPass(new RenderPass(scene, camera));

  /**
   * Размытие СЛАБОЕ нарочно. Первая редакция была в десять раз сильнее, и кадр
   * читался не как «глаз навёлся», а как «объектив грязный»: у человека глубина
   * резкости огромная, размывается только то, что заметно ближе или дальше
   * точки наводки. Сильное размытие — это кино, а не зрение.
   */

  // смаз живёт ПОСЛЕ наводки: сначала глаз навёлся, потом голова повернулась
  const smear = new AfterimagePass(0);
  composer.addPass(smear);

  /**
   * Свечения пока нет нарочно. Единственное яркое место в кадре — небо, и оно
   * начинало светиться целиком: горизонт размывало в белое, а весь кадр
   * выцветал. Свечение имеет смысл, когда появятся настоящие источники —
   * фары, окна, фонари, солнце в стекле. Тогда и вернём, с порогом по ним.
   */

  const edges = new ShaderPass(VignetteShader);
  /**
   * Края. Осторожно с числом: этот проход подмешивает к кадру цвет
   * `1 - darkness`, то есть при darkness меньше единицы он мешает СВЕТЛОЕ
   * и выбеливает всю картинку молоком. Первая редакция стояла на 0.42 —
   * и кадр выглядел так, будто на объектив дохнули. Единица и чуть больше —
   * это затемнение к чёрному, как и надо.
   */
  edges.uniforms.offset.value = 1.4;
  edges.uniforms.darkness = { value: 1.05 };
  composer.addPass(edges);

  composer.addPass(new OutputPass());

  const ray = new THREE.Raycaster();
  const middle = new THREE.Vector2(0, 0);
  let focus = 30;
  let want = 30;
  let sinceAsk = 0;

  return {
    render(headRate, dt) {
      // ── на что смотрим — считается, но пока не применяется: см. ниже
      sinceAsk += dt;
      if (sinceAsk >= ASK_EVERY) {
        sinceAsk = 0;
        ray.setFromCamera(middle, camera);
        const hit = ray.intersectObjects(scene.children, true).find((h) => h.distance > 0.4);
        want = Math.max(6, hit ? hit.distance : 220);
      }
      focus += (want - focus) * (1 - Math.exp(-dt / FOCUS_TIME));
      (globalThis as unknown as { __focus?: () => unknown }).__focus = () => ({ focus, want });

      // ── смаз: только от головы, и только когда она реально едет
      const swing = Math.min(1, Math.max(0, (headRate - SMEAR_FROM) / (SMEAR_FULL - SMEAR_FROM)));
      smear.uniforms.damp.value = swing * SMEAR_MAX;

      composer.render(dt);
    },
    resize(width, height) {
      composer.setSize(width, height);
    },
    dispose() { composer.dispose(); },
  };
}
