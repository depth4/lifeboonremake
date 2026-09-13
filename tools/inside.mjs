/**
 * Сколько стоит войти в дом: замер в настоящем браузере.
 *
 * Алекс: «в любое здание можно войти, и из окна видно улицу, а с улицы —
 * ту же панораму продуктового на первом этаже. Но я не знаю, как дорого
 * нам это обойдётся». Вот и меряем, а не прикидываем.
 *
 * Что меряется. Дом снаружи — это коробка, двенадцать треугольников. Дом,
 * в который можно войти, — коробка без передней стены, пол, потолок, витрина
 * из стекла и обстановка: стеллажи, прилавок. Разница в десятки раз, и вопрос
 * ровно один: сколько таких домов можно держать открытыми одновременно,
 * чтобы кадр оставался в 16.7 мс.
 *
 * Запуск: npm run inside
 */

import { createServer } from 'vite';
import { chromium } from 'playwright';
import { writeFileSync, mkdirSync } from 'node:fs';

mkdirSync('build', { recursive: true });

/** Страница-стенд: три.js, N домов, замер времени кадра. */
const СТЕНД = `<!doctype html><meta charset="utf-8"><title>цена интерьера</title>
<style>body{margin:0;background:#111;color:#eee;font:14px system-ui}canvas{display:block}</style>
<script type="module">
import * as THREE from 'three';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';

const renderer = new THREE.WebGLRenderer({ antialias: true });
renderer.setSize(1600, 900);
renderer.setPixelRatio(1);
document.body.appendChild(renderer.domElement);
const scene = new THREE.Scene();
scene.background = new THREE.Color(0x9fc4dd);
scene.add(new THREE.HemisphereLight(0xbcd3e8, 0x4a5340, 2.2));
const sun = new THREE.DirectionalLight(0xfff2dd, 1.6);
sun.position.set(60, 90, 40);
scene.add(sun);
const camera = new THREE.PerspectiveCamera(60, 16 / 9, 0.5, 900);

const стена = new THREE.MeshStandardMaterial({ color: 0xbfae95, roughness: 0.9 });
const пол = new THREE.MeshStandardMaterial({ color: 0x8d8477, roughness: 1 });
const стекло = new THREE.MeshStandardMaterial({
  color: 0xcfe3ee, roughness: 0.08, metalness: 0, transparent: true, opacity: 0.35,
});
const товар = new THREE.MeshStandardMaterial({ color: 0x9a6b4f, roughness: 0.85 });

/** Дом снаружи: одна коробка. Дёшево и слепо. */
function снаружи(x, z) {
  const m = new THREE.Mesh(new THREE.BoxGeometry(16, 9, 12), стена);
  m.position.set(x, 4.5, z);
  return [m];
}

/**
 * Дом, в который можно войти: пять стен вместо шести (перед — витрина),
 * пол, потолок и обстановка магазина. Всё раздельными мешами нарочно:
 * так честнее — именно столько вызовов отрисовки и получится.
 */
function внутри(x, z, полок) {
  const части = [];
  const стенаМеш = (w, h, d, dx, dy, dz, мат = стена) => {
    const m = new THREE.Mesh(new THREE.BoxGeometry(w, h, d), мат);
    m.position.set(x + dx, dy, z + dz);
    части.push(m);
  };
  стенаМеш(16, 9, 0.3, 0, 4.5, 6);      // задняя
  стенаМеш(0.3, 9, 12, -8, 4.5, 0);     // левая
  стенаМеш(0.3, 9, 12, 8, 4.5, 0);      // правая
  стенаМеш(16, 0.3, 12, 0, 0.15, 0, пол); // пол
  стенаМеш(16, 0.3, 12, 0, 3.9, 0, пол);  // перекрытие первого этажа
  стенаМеш(16, 5.1, 0.3, 0, 6.55, -6);  // глухая часть фасада выше витрины
  стенаМеш(16, 3.6, 0.2, 0, 1.9, -6, стекло); // витрина: через неё и видно
  for (let i = 0; i < полок; i++) {
    const ряд = Math.floor(i / 3), место = i % 3;
    стенаМеш(4.2, 2.2, 0.8, -5 + место * 5, 1.2, 3.5 - ряд * 2.4, товар);
  }
  return части;
}

const слитно = new URLSearchParams(location.search).get('слитно') === 'да';
const ряд = Math.ceil(Math.sqrt(Number(new URLSearchParams(location.search).get('домов') ?? 24)));
const домов = Number(new URLSearchParams(location.search).get('домов') ?? 24);
const сИнтерьером = new URLSearchParams(location.search).get('внутри') === 'да';
const полок = Number(new URLSearchParams(location.search).get('полок') ?? 9);

let треугольников = 0;
for (let i = 0; i < домов; i++) {
  const x = (i % ряд) * 26 - (ряд * 26) / 2;
  const z = Math.floor(i / ряд) * 26 - (ряд * 26) / 2;
  const части = сИнтерьером ? внутри(x, z, полок) : снаружи(x, z);
  if (слитно) {
    /**
     * Склейка: весь дом одним куском на материал. Стекло остаётся отдельно —
     * прозрачное рисуется по-другому, и склеивать его с непрозрачным нельзя.
     */
    const поМатериалу = new Map();
    for (const ч of части) {
      ч.updateMatrixWorld(true);
      const г = ч.geometry.clone();
      г.applyMatrix4(ч.matrixWorld);
      const список = поМатериалу.get(ч.material) ?? [];
      список.push(г);
      поМатериалу.set(ч.material, список);
    }
    for (const [мат, список] of поМатериалу) {
      const слитая = mergeGeometries(список, false);
      const меш = new THREE.Mesh(слитая, мат);
      scene.add(меш);
      треугольников += слитая.index
        ? слитая.index.count / 3 : слитая.attributes.position.count / 3;
    }
  } else {
    for (const ч of части) {
      scene.add(ч);
      треугольников += ч.geometry.index
        ? ч.geometry.index.count / 3 : ч.geometry.attributes.position.count / 3;
    }
  }
}

camera.position.set(0, 6, ряд * 16);
camera.lookAt(0, 4, 0);

let кадров = 0, сумма = 0, было = performance.now();
function кадр() {
  renderer.render(scene, camera);
  const теперь = performance.now();
  if (кадров > 10) сумма += теперь - было; // первые кадры врут: идёт раскрутка
  было = теперь;
  кадров++;
  if (кадров < 130) requestAnimationFrame(кадр);
  else {
    window.__замер = {
      домов, сИнтерьером, полок, слитно,
      мсНаКадр: сумма / (кадров - 11),
      треугольников,
      вызовов: renderer.info.render.calls,
      мешей: scene.children.length,
    };
  }
}
requestAnimationFrame(кадр);
</script>`;

writeFileSync('build/стенд-интерьера.html', СТЕНД);

const server = await createServer({
  server: { port: 5220, strictPort: true }, logLevel: 'warn',
  resolve: { alias: {} },
});
await server.listen();
const browser = await chromium.launch({ args: ['--use-gl=swiftshader', '--enable-unsafe-swiftshader'] });
const page = await browser.newPage({ viewport: { width: 1600, height: 900 } });
page.on('pageerror', (e) => console.log('ОШИБКА:', String(e).split('\n')[0]));

async function замер(домов, внутри, полок = 9, слитно = false) {
  const адрес = `http://localhost:5220/build/стенд-интерьера.html`
    + `?домов=${домов}&внутри=${внутри ? 'да' : 'нет'}&полок=${полок}`
    + `&слитно=${слитно ? 'да' : 'нет'}`;
  await page.goto(адрес, { waitUntil: 'load' });
  await page.waitForFunction(() => window.__замер !== undefined, null, { timeout: 60000 });
  return page.evaluate(() => window.__замер);
}

console.log('\nЦЕНА ИНТЕРЬЕРА — замер в браузере, 1600 × 900\n');
console.log('  домов  внутри  склеен   треугольников  вызовов  мс/кадр');
for (const [домов, внутрь, полок, слито] of [
  [24, false, 0, false],
  [24, true, 9, false], [24, true, 9, true],
  [200, true, 9, false], [200, true, 9, true],
  [400, true, 9, true], [800, true, 9, true],
]) {
  const р = await замер(домов, внутрь, полок, слито);
  console.log(
    `  ${String(р.домов).padStart(5)}  ${(р.сИнтерьером ? 'да' : 'нет').padStart(6)}  ` +
    `${(р.слитно ? 'да' : 'нет').padStart(6)}   ${р.треугольников.toLocaleString('ru-RU').padStart(13)}  ` +
    `${String(р.вызовов).padStart(7)}  ${р.мсНаКадр.toFixed(1).padStart(7)}`,
  );
}

console.log('\n  Замер идёт на программном отрисовщике (в контейнере нет видеокарты),');
console.log('  поэтому числа — нижняя граница: на настоящей карте будет заметно быстрее.');
console.log('  Смысл не в абсолютных миллисекундах, а в том, как растёт цена.\n');

await browser.close();
await server.close();
