/** Склейка: собрать мир, посчитать поверхность, показать, повесить кнопки. */

import type { Road } from './world/road.ts';
import { DEFAULT_SCENE, ИМЕНА_СЦЕН, дорогиСцены, посёлокСцены } from './scenes.ts';
import { ЦОКОЛЬ_ШИРЕ, гдеПроём, домНаУчастке } from './city/дом.ts';
import {
  type Форма, type Твердь, ПУСТО, СТУПЕНЬ, коробка, круг, пройти, собратьТвердь, упереть, формыВещи,
} from './city/твердь.ts';
import { частиВещи } from './модели.ts';
import { ВИДЫ, КУСТЫ } from './растения/дерево.ts';
import { ЗАПАС_ДЕРЕВА, деревьяДворов, деревьяУлиц, кустыДворов } from './city/зелень.ts';
import { полеПоШагам, полеТравы } from './растения/поле.ts';
import { ПОРЯДОК as ТРАВЫ } from './растения/показ.ts';
import { ПОРЯДОК_ЛИСТВЫ as ЛИСТВЫ } from './растения/деревья.ts';
import { занято, наЗемлеПосёлка, откудаСмотретьВоДвор } from './city/двор.ts';
import { roadWidth } from './world/road.ts';
import { MAX_GRADE, buildWorld, nearestRoad, snapPoint } from './world/world.ts';
import { DEFAULT_TERRAIN, TERRAINS } from './world/terrain.ts';
import { DEFAULT_VARIANT, VARIANTS, buildGhost, buildSurface } from './surface/index.ts';
import { type View, show, viewFromQuery } from './render.ts';
import { createBuilder } from './build.ts';
import { GroundIndex } from './car/ground.ts';
import { type Плита, крыльцо, площадкаПодСледом } from './city/площадка.ts';
import { SETUPS, VIPER } from './car/passport.ts';
import { P_ZERO } from './car/tyre.ts';
import { type Car, createCar, forwardSpeed, restLength, step } from './car/car.ts';
import { createDriver } from './car/controls.ts';
import { createAim } from './aim.ts';
import {
  type Person, ПЛЕЧИ, createPerson, eyes as eyesOf, look, step as stepPerson,
} from './person/person.ts';
import {
  type Mover, type Network, LENGTH, WIDE, along, bump, buildNetwork, moveTraffic, placeTraffic, poseOf, signalsOf,
} from './city/traffic.ts';
import { КВАРТАЛ } from './city/norms.ts';
import { judge, newWatchdog, tally } from './city/offence.ts';
import { laneAcross } from './city/lanes.ts';
import { lightFor } from './city/signals.ts';
import { type Walker, moveWalkers, placeWalkers, walkerPose, фазаШага } from './city/walkers.ts';
import { СЕКУНД_В_ЧАСЕ, type Зачем, type Расселение, где as гдеЖителя, кто, расселить } from './city/житель.ts';
import {
  ЧАС_УТРА, type Снаружи, вывестиНаУлицу, гдеЖитель, жить, сколькоМашин, сколькоПешеходов,
} from './city/жизнь.ts';

const query = new URLSearchParams(location.search);
const startView = query.get('view') ?? 'road';
const startScene = query.get('scene') ?? DEFAULT_SCENE;

/** На каком расстоянии инструмент начинает распознавать намерение, метры. */
const SNAP_RADIUS = 14;

/**
 * Куда страница записывает, что не поняла имени и взяла своё.
 *
 * Человеку, промахнувшемуся в адресе, белый экран не нужен — подмена
 * для него правильное поведение. А инструменту, снимающему доказательство,
 * она смертельна: 17.09 `npm run shot -- наводка город холмы` снял ПЛАТО,
 * и подсказка самого инструмента предлагала писать именно `холмы`.
 * Снимок не той земли хуже отказа: он выглядит как доказательство.
 *
 * Это уже ловили 15 сентября на сценах. Второй раз тот же корень — значит
 * чинится корень: список имён никуда не переписывается, страница просто
 * ПРИЗНАЁТСЯ, что подменила, а проверки отказываются работать с подменой.
 */
const подмены: string[] = [];
const подменено = (что: string, просили: string, взяли: string): void => {
  подмены.push(`${что}: «${просили}» не знаю, взял «${взяли}»`);
};

let sceneName = ИМЕНА_СЦЕН.includes(startScene) ? startScene : DEFAULT_SCENE;
if (sceneName !== startScene) подменено('сцена', startScene, sceneName);
const roads: Road[] = [...дорогиСцены(sceneName)];
/**
 * Рельеф по имени. Принимается и ключ (`hills`), и подпись с кнопки
 * (`холмы`) — человек пишет в адресе то, что видит на экране, и это
 * не два имени, а одно: подпись кнопки и есть источник.
 */
let terrainName = query.get('terrain') ?? DEFAULT_TERRAIN;
if (!TERRAINS[terrainName]) {
  // принимается и ключ (`hills`), и подпись с кнопки (`холмы`): человек
  // пишет в адресе то, что видит на экране, и это одно имя, а не два
  const поПодписи = Object.keys(TERRAINS).find((k) => TERRAINS[k].label === terrainName);
  if (поПодписи !== undefined) terrainName = поПодписи;
  else { подменено('рельеф', terrainName, DEFAULT_TERRAIN); terrainName = DEFAULT_TERRAIN; }
}

let variant = query.get('variant')?.toUpperCase() ?? DEFAULT_VARIANT;
if (!VARIANTS[variant]) { подменено('вариант', variant, DEFAULT_VARIANT); variant = DEFAULT_VARIANT; }

let world = buildWorld(roads, terrainName);
let surface = buildSurface(world, variant);
let rebuildMs = 0;
let lastGood: Road[] = [...roads];
let refusal = '';

// ?bare=1 — убрать всю обвязку: нужно, когда снимок идёт в сравнение
if (query.get('bare') === '1') {
  document.querySelector('.layer')?.remove();
  document.getElementById('news')?.remove();
}

/**
 * Отметка сборки. Ставится при сборке страницы, а не пишется руками:
 * иначе однажды она соврёт. Нужна ровно для одного вопроса — «я открыл
 * свежую версию или старую из памяти браузера?»
 */
const stamp = (import.meta.env.VITE_BUILD as string | undefined) ?? '';
const changes = ((import.meta.env.VITE_CHANGES as string | undefined) ?? '')
  .split('\n')
  .map((line) => line.trim())
  .filter((line) => line.length > 0);

const buildLine = document.getElementById('build');
if (buildLine && stamp !== '') {
  buildLine.textContent = stamp;
  buildLine.classList.add('fresh');
}

const news = document.getElementById('news');
const newsList = document.getElementById('news-list');
if (news && newsList && changes.length > 0 && query.get('bare') !== '1') {
  newsList.innerHTML = changes.map((line) => `<li>${line}</li>`).join('');
  const when = document.getElementById('news-when');
  if (when) when.textContent = `что нового · ${stamp}`;
  news.classList.add('open');
  document.getElementById('news-close')?.addEventListener('click', () => news.classList.remove('open'));
  // отметку сборки можно нажать, чтобы список вернулся
  buildLine?.addEventListener('click', () => news.classList.toggle('open'));
}

/**
 * Ракурс «двор» — единственный, который нельзя записать постоянными числами.
 *
 * ЗАЧЕМ. 18 сентября Алекс открыл выложенный мир и сказал: «где дворы,
 * их нету блять». Дворы были — все тридцать шесть, соединённые с улицами,
 * с проездами, стоянками и машинами жителей. Но ни один ракурс в меню
 * на них не смотрел: каждый из них это пара координат, зашитая в код
 * (`вдоль` всегда глядит из −118,52,−128 в 15,2,8). Город менялся,
 * ракурсы смотрели в одно и то же место. Построить и не показать —
 * то же самое, что не построить.
 *
 * Камера стоит У ВЪЕЗДА, НА УРОВНЕ ГЛАЗ и смотрит вглубь двора. Высота
 * берётся у той же земли, что под колесом и на экране, — второй земли нет.
 */
const ГЛАЗА = 1.7;
function ракурсДвора(): Record<string, View> {
  const посёлок = посёлокСцены(sceneName);
  if (посёлок === null) return {};
  const место = откудаСмотретьВоДвор(посёлок);
  if (место === null) return {};
  const высота = (p: { x: number; z: number }): number =>
    (nearestRoad(world, p.x, p.z)?.roadHeight ?? 0) + ГЛАЗА;
  return {
    двор: {
      label: 'двор',
      from: [место.от.x, высота(место.от), место.от.z],
      at: [место.до.x, высота(место.до), место.до.z],
      fog: 320,
    },
  };
}

const наводка = viewFromQuery(query);
const viewer = show(surface, startView, наводка, ракурсДвора());
/**
 * Какой ракурс показан НА САМОМ ДЕЛЕ. Своя наводка (`from`/`at` в адресе)
 * бьёт список готовых; неизвестное имя даёт «вдоль».
 */
let показанныйРакурс = наводка !== null ? 'наводка'
  : (viewer.ракурсы()[startView] ? startView : 'road');
if (показанныйРакурс !== startView) подменено('ракурс', startView, показанныйРакурс);
const canvas = document.querySelector('canvas');

/**
 * Пересобрать мир. Если постройка такая, что мир её принять не может,
 * откатываем последнее действие и говорим об этом. Кривой мир на экран
 * не попадает никогда — в этом и смысл отказа.
 */
/**
 * Застройка посёлка. Дом ставится НА УЧАСТОК, а участок нарезан от улицы, —
 * поэтому «дом посреди поля» или «дом на проезжей части» невыразимы: их
 * негде было бы записать.
 *
 * Здесь не осталось ни одного решения про дом: ни цвета, ни этажности,
 * ни размера. Всё это — свойства объекта, и живут они в `city/дом.ts`.
 * Склейка только спрашивает высоту земли и отдаёт готовое показу.
 */
/**
 * ТВЕРДЬ ГОРОДА — из того же, что нарисовано (`city/твердь.ts`). Каждый
 * кусок собирается там же, где его отдают показу, и из того же массива:
 * дома и крыльца — в застройке, стволы и вещи двора — в зелени, столбы —
 * там, где ставят знаки. Отдельного списка преград нет.
 */
const твёрдое: { дома: Форма[]; зелень: Форма[]; столбы: Форма[] } = { дома: [], зелень: [], столбы: [] };
let твердь: Твердь = ПУСТО;
const пересобратьТвердь = (): void => {
  твердь = собратьТвердь([...твёрдое.дома, ...твёрдое.зелень, ...твёрдое.столбы]);
};
/** Столб знака и светофора в плане, м (радиус). */
const СТОЛБ = 0.07;
/** Сколько чего твёрдо — проверкам из терминала. */
(window as unknown as { __твердь?: () => unknown }).__твердь = () => ({
  форм: твердь.формы.length, домов: твёрдое.дома.length, зелени: твёрдое.зелень.length, столбов: твёрдое.столбы.length,
});

function застройка(): void {
  const посёлок = посёлокСцены(sceneName);
  if (посёлок === null || !viewer) {
    viewer?.setBuildings([]); viewer?.setКрыльца([]);
    твёрдое.дома = []; пересобратьТвердь();
    return;
  }
  // объекты, а не участки: школа на четырёх участках — ОДНО здание
  const земля = (x: number, z: number): number => ground.sample(x, z).height;
  const наГазоне = (x: number, z: number): boolean => ground.sample(x, z).material === 'grass';
  const плиты: Плита[] = [];
  const дома = посёлок.объекты.map((о) => {
    const дом = домНаУчастке(о, посёлок.вид, посёлок.сид);
    /**
     * Дом спрашивает землю ПОД ВСЕМ СВОИМ СЛЕДОМ, а не в одной точке своей
     * середины. Одна точка — это то, из-за чего у 635 домов из 676 на холмах
     * угол висел в воздухе: дом ровный, земля нет, и разницу никто не брал.
     * Ту же самую землю щупает колесо и нога — второй земли не существует.
     */
    const площадка = площадкаПодСледом(
      { x: дом.x, z: дом.z, курс: дом.курс, ширина: дом.ширина, глубина: дом.глубина }, земля);
    // крыльцо у каждой двери — из пола дома и земли у двери; прямо — только по газону
    for (const п of дом.двери) {
      плиты.push(...крыльцо(гдеПроём(дом, п), площадка.пол, земля, наГазоне));
    }
    return { дом, площадка };
  });
  viewer.setBuildings(дома);
  viewer.setКрыльца(плиты);
  // твёрдо то же, что нарисовано: дом по цоколю, крыльцо — там, где оно выше ступени
  твёрдое.дома = [
    ...дома.map(({ дом: д }) => коробка(д.x, д.z, д.курс, д.глубина + ЦОКОЛЬ_ШИРЕ, д.ширина + ЦОКОЛЬ_ШИРЕ)),
    ...плиты.filter((п) => п.верх - п.низ > СТУПЕНЬ).map((п) => коробка(п.x, п.z, п.курс, п.длина, п.ширина)),
  ];
  пересобратьТвердь();
}

/**
 * Зелень улиц и дворов. Дерево ставится НА ЗЕМЛЮ, и земля та же самая,
 * по которой едет колесо. Отдельной площадки, как у дома, тут не нужно:
 * у дома ровный пол на всю ширину, у дерева пола нет вовсе — ствол
 * в треть метра на предельном уклоне расходится с землёй на три сантиметра,
 * и это ниже того, что видно глазом.
 */
function зеленьСцены(): void {
  const посёлок = посёлокСцены(sceneName);
  if (посёлок === null || !viewer) {
    viewer?.setTrees([]); viewer?.setPaths([]); viewer?.setВещи([]); viewer?.setРазметка([]);
    твёрдое.зелень = []; пересобратьТвердь();
    // рукотворная сцена: на земле ничего не стоит, трава растёт на всём газоне
    viewer?.трава().источник((окно) => полеПоШагам(surface, null, окно));
    return;
  }

  /**
   * Что стоит на земле — один список на страницу и на все проверки
   * (`city/двор.ts`). Дерево растёт там, где ничего нет: ни дома, ни
   * дорожки, ни вещи двора.
   */
  const н = наЗемлеПосёлка(посёлок);
  // трава спрашивает то же, что дерево: что стоит на земле
  /**
   * `?поле=сразу` — заведомо сломанный вариант для замера рывков: всё поле
   * строится в первом же шаге, то есть в одном кадре, как было до 25.09.
   */
  viewer.трава().источник(new URLSearchParams(location.search).get('поле') === 'сразу'
    ? (окно) => (function* сразу() { return полеТравы(surface, н, окно); })()
    : (окно) => полеПоШагам(surface, н, окно));
  /**
   * Дорожка кладётся ПЛИТАМИ по два метра, каждая по своей земле. Тротуар
   * двора тянется на сотню метров, и одна плита от конца до конца висела бы
   * над ложбиной и тонула бы в бугре; плита в два метра расходится с землёй
   * меньше, чем на свою толщину.
   */
  const плиты: { подход: typeof н.подходы[number]; отY: number; доY: number }[] = [];
  for (const п of н.подходы) {
    const длина = Math.hypot(п.доX - п.отX, п.доZ - п.отZ);
    const n = Math.max(1, Math.ceil(длина / 2));
    for (let k = 0; k < n; k++) {
      const a = k / n, b = (k + 1) / n;
      const кусок = {
        ...п,
        отX: п.отX + (п.доX - п.отX) * a, отZ: п.отZ + (п.доZ - п.отZ) * a,
        доX: п.отX + (п.доX - п.отX) * b, доZ: п.отZ + (п.доZ - п.отZ) * b,
      };
      плиты.push({
        подход: кусок,
        отY: ground.sample(кусок.отX, кусок.отZ).height,
        доY: ground.sample(кусок.доX, кусок.доZ).height,
      });
    }
  }
  viewer.setPaths(плиты);
  viewer.setВещи(н.вещи.map((вещь) => ({ вещь, низ: ground.sample(вещь.x, вещь.z).height })));
  /**
   * Разметка стоянок — из тех же карманов, куда встают машины (`network.bays`):
   * по черте у каждого края места поперёк полосы стоянки. Второго списка мест
   * нет, поэтому «нарисовано место, куда никто не встанет» записать нельзя.
   */
  const линии: { x: number; z: number; курс: number; длина: number; y: number }[] = [];
  for (const b of network.bays) {
    for (const край of [-1, 1]) {
      const т = along(world, b.shape, b.s + (край * КВАРТАЛ.место.длина) / 2);
      const x = т.x - b.across * т.fz, z = т.z + b.across * т.fx;
      линии.push({ x, z, курс: Math.atan2(т.fx, -т.fz), длина: b.ширина, y: ground.sample(x, z).height });
    }
  }
  viewer.setРазметка(линии);
  // сеть уже собрана для трафика: второй такой же завести значило бы
  // держать две правды об одних и тех же дорогах
  const деревья = деревьяУлиц(world, network, посёлок.сид, {
    занято: (x, z) => занято(н, x, z, ЗАПАС_ДЕРЕВА),
  });
  // деревья двора — рощицами по газону (в дворе до 24.09 деревьев не было вовсе)
  const дворовые = деревьяДворов(н, посёлок.кварталы, посёлок.сид, (x, z) => ground.sample(x, z).material);
  // кусты — после деревьев: куст не растёт вплотную к стволу
  const кусты = кустыДворов(н, посёлок.сид, (x, z) => ground.sample(x, z).material, [...деревья, ...дворовые]);
  const посадки = [...деревья, ...дворовые, ...кусты];
  viewer.setTrees(посадки.map((дерево) => ({
    дерево, низ: ground.sample(дерево.x, дерево.z).height,
  })));
  /**
   * Твёрдо: ствол дерева (порода и масштаб — те же, что у нарисованного)
   * и каждая вещь двора своими частями. Куст мягкий: машина его продавливает,
   * пешеход раздвигает ветки.
   */
  твёрдое.зелень = [
    ...посадки.filter((д) => !КУСТЫ.includes(д.вид)).map((д) => круг(д.x, д.z, (ВИДЫ[д.вид].толщина / 2) * д.масштаб)),
    ...н.вещи.flatMap((в) => формыВещи(частиВещи(в.что), в)),
  ];
  пересобратьТвердь();
}

function rebuild(): void {
  const started = performance.now();
  try {
    const next = buildWorld(roads, terrainName);
    const nextSurface = buildSurface(next, variant);
    world = next;
    surface = nextSurface;
    lastGood = [...roads];
    refusal = '';
  } catch (error) {
    refusal = String(error instanceof Error ? error.message : error).replace(/ \(.*\)$/, '');
    roads.splice(0, roads.length, ...lastGood);
    world = buildWorld(roads, terrainName);
    surface = buildSurface(world, variant);
  }
  rebuildMs = performance.now() - started;
  ground = new GroundIndex(surface);
  network = buildNetwork(world);
  // дороги стали другими — знаки тоже: старые относились к прежним улицам
  signsShown = false;
  viewer?.setSigns([]);
  твёрдое.столбы = [];
  // застройка ставится после того, как заведена опора: дом стоит НА земле,
  // и её высоту надо у кого-то спросить
  if (опораГотова) { застройка(); зеленьСцены(); }
  if (городЖив) заселить();
  viewer.setSurface(surface);
  readout();
  hint();
}

function readout(): void {
  const facts = document.getElementById('facts');
  const name = document.getElementById('road-name');
  const length = world.shapes.reduce((sum, shape) => sum + (shape.stations.at(-1)?.s ?? 0), 0);
  const widest = roads.reduce((w, r) => Math.max(w, roadWidth(r.type)), 0);

  if (name) {
    name.textContent = roads.length === 0
      ? 'дорог нет'
      : `дорог: ${roads.length}, перекрёстков: ${world.junctions.length}`;
  }
  if (facts) {
    const rows: [string, string][] = [
      ['длина', `${Math.round(length)} м`],
      ['полос в сторону', String(builder.lanes())],
      ['ширина', `${widest.toFixed(2)} м`],
      ['уклон', `${(world.grade * 100).toFixed(1)}% из ${(MAX_GRADE * 100).toFixed(0)}%`],
      ['отрыв от земли', `${world.lift.toFixed(1)} м${world.lift > 6 ? ' — нужен мост' : ''}`],
      ['перекрёстков', String(world.junctions.length)],
      ['пересборка', `${rebuildMs.toFixed(0)} мс`],
      ['вариант', VARIANTS[variant].label],
    ];
    facts.innerHTML = rows.map(([k, v]) => `<div>${k} <b>${v}</b></div>`).join('');
  }
}

const builder = createBuilder({
  viewer,
  canvas: canvas ?? document.body,
  roads,
  onChanged: rebuild,
  onState: () => {
    hint();
    readout();
  },
  preview: (road) => {
    viewer.setGhost(road ? buildGhost(world, road) : null);
  },
  // мышь держит тело — пешеход или руль; строить можно только со стороны
  свободна: () => walker === null && !driving,
  наЗемле: (event) => {
    const { o, d } = viewer.луч(event);
    return ground.луч(o.x, o.y, o.z, d.x, d.y, d.z);
  },
  snap: (point) => {
    const hit = snapPoint(world, point.x, point.z, SNAP_RADIUS);
    return hit ? { point: hit.point, kind: hit.kind } : null;
  },
});

// --- кнопки ракурса ---
const views = document.getElementById('views');
if (views) {
  views.innerHTML = Object.entries(viewer.ракурсы())
    .map(([key, v]) => `<button type="button" data-view="${key}" aria-pressed="${key === startView}">${v.label}</button>`)
    .join('');
  views.addEventListener('click', (event) => {
    const button = (event.target as HTMLElement).closest<HTMLButtonElement>('button[data-view]');
    if (!button) return;
    показанныйРакурс = button.dataset.view ?? 'road';
    viewer.setView(показанныйРакурс);
    views.querySelectorAll('button').forEach((b) => b.setAttribute('aria-pressed', String(b === button)));
  });
}

// --- кнопки строительства ---
const tools = document.getElementById('tools');
if (tools) {
  tools.innerHTML =
    '<button type="button" data-tool="look" aria-pressed="true">смотреть</button>' +
    '<button type="button" data-tool="road" aria-pressed="false">дорога</button>' +
    '<button type="button" class="plain" data-tool="undo">убрать последнюю</button>';

  tools.addEventListener('click', (event) => {
    const button = (event.target as HTMLElement).closest<HTMLButtonElement>('button[data-tool]');
    if (!button) return;
    const tool = button.dataset.tool ?? 'look';

    if (tool === 'undo') {
      builder.undo();
      return;
    }
    builder.setActive(tool === 'road');
    tools.querySelectorAll<HTMLButtonElement>('button[data-tool]').forEach((b) => {
      if (b.dataset.tool !== 'undo') b.setAttribute('aria-pressed', String(b.dataset.tool === tool));
    });
  });
}

// --- кнопка «сетка»: показать, из чего мир сделан на самом деле ---
/**
 * Трава и ветер: кнопками и клавишами T и V — клавишами на ходу, когда мышь
 * отдана рулю или взгляду. Начальные — из адреса: ?трава=гладкая&ветер=1.
 * Вариантов четыре при равной цене в вершинах: сравнивается, на что лучше
 * потратить одни и те же деньги.
 */
const ВЕТРА = [0, 0.3, 0.6, 1.1] as const;
const ИМЕНА_ВЕТРА = ['штиль', 'слабый', 'средний', 'сильный'];
{
  const т = viewer.трава();
  const спрошено = query.get('трава');
  т.вариант(спрошено === 'нет' ? null : (спрошено && (ТРАВЫ as readonly string[]).includes(спрошено) ? спрошено : ТРАВЫ[0]));
  const густота = Number(query.get('густота'));
  if (query.has('густота') && Number.isFinite(густота)) т.густота(густота);
  const ветер = Number(query.get('ветер'));
  т.ветер(Number.isFinite(ветер) && query.has('ветер') ? ветер : ВЕТРА[2]);
}
{
  const спрошено = query.get('листва');
  viewer.деревья().форма(спрошено === 'нет' ? null
    : (спрошено && (ЛИСТВЫ as readonly string[]).includes(спрошено) ? спрошено : ЛИСТВЫ[0]));
}
const leavesBox = document.getElementById('leaves');
const grassBox = document.getElementById('grass');
const windBox = document.getElementById('wind');
function травяныеКнопки(): void {
  const т = viewer.трава();
  if (grassBox) grassBox.querySelectorAll<HTMLButtonElement>('button[data-grass]').forEach((b) => {
    b.setAttribute('aria-pressed', String((b.dataset.grass === 'нет' ? null : b.dataset.grass) === т.которыйВариант()));
  });
  if (leavesBox) leavesBox.querySelectorAll<HTMLButtonElement>('button[data-leaf]').forEach((b) => {
    b.setAttribute('aria-pressed', String((b.dataset.leaf === 'нет' ? null : b.dataset.leaf) === viewer.деревья().котораяФорма()));
  });
  if (windBox) windBox.querySelectorAll<HTMLButtonElement>('button[data-wind]').forEach((b) => {
    b.setAttribute('aria-pressed', String(Math.abs(Number(b.dataset.wind) - т.силаВетра()) < 1e-6));
  });
}
if (grassBox) {
  grassBox.innerHTML = [...ТРАВЫ, 'нет'].map((и) => `<button type="button" data-grass="${и}">${и}</button>`).join('');
  grassBox.addEventListener('click', (event) => {
    const b = (event.target as HTMLElement).closest<HTMLButtonElement>('button[data-grass]');
    if (!b) return;
    viewer.трава().вариант(b.dataset.grass === 'нет' ? null : (b.dataset.grass ?? null));
    травяныеКнопки();
  });
}
if (leavesBox) {
  leavesBox.innerHTML = [...ЛИСТВЫ, 'нет'].map((и) => `<button type="button" data-leaf="${и}">${и}</button>`).join('');
  leavesBox.addEventListener('click', (event) => {
    const b = (event.target as HTMLElement).closest<HTMLButtonElement>('button[data-leaf]');
    if (!b) return;
    viewer.деревья().форма(b.dataset.leaf === 'нет' ? null : (b.dataset.leaf ?? null));
    травяныеКнопки();
  });
}
if (windBox) {
  windBox.innerHTML = ВЕТРА.map((в, i) => `<button type="button" data-wind="${в}">${ИМЕНА_ВЕТРА[i]}</button>`).join('');
  windBox.addEventListener('click', (event) => {
    const b = (event.target as HTMLElement).closest<HTMLButtonElement>('button[data-wind]');
    if (!b) return;
    viewer.трава().ветер(Number(b.dataset.wind));
    травяныеКнопки();
  });
}
травяныеКнопки();
/**
 * Сколько кадров в секунду и сколько травинок в кадре — рядом с кнопками
 * травы. Видеокарты Алекса Клод не видит: это единственный способ узнать,
 * тянет ли его компьютер, не спрашивая «а как у тебя».
 */
{
  const метка = document.querySelector<HTMLElement>('#grass')?.previousElementSibling as HTMLElement | null;
  let кадров = 0, с = performance.now();
  const считать = (): void => {
    кадров++;
    const сейчас = performance.now();
    if (сейчас - с > 500 && метка) {
      const ц = viewer.трава().цена();
      const кс = Math.round((кадров * 1000) / (сейчас - с));
      метка.textContent = `трава · T · ${кс} к/с · ${Math.round(ц.живых / 1000)} тыс.`;
      кадров = 0; с = сейчас;
    }
    requestAnimationFrame(считать);
  };
  requestAnimationFrame(считать);
}
addEventListener('keydown', (event) => {
  const т = viewer.трава();
  if (event.code === 'KeyT') {
    const все: (string | null)[] = [...ТРАВЫ, null];
    т.вариант(все[(все.indexOf(т.которыйВариант()) + 1) % все.length]);
    травяныеКнопки();
  } else if (event.code === 'KeyL') {
    const все: (string | null)[] = [...ЛИСТВЫ, null];
    viewer.деревья().форма(все[(все.indexOf(viewer.деревья().котораяФорма()) + 1) % все.length]);
    травяныеКнопки();
  } else if (event.code === 'KeyV') {
    const i = ВЕТРА.findIndex((в) => Math.abs(в - т.силаВетра()) < 1e-6);
    т.ветер(ВЕТРА[(i + 1) % ВЕТРА.length]);
    травяныеКнопки();
  }
});

const wireBox = document.getElementById('wire');
if (wireBox) {
  wireBox.innerHTML =
    '<button type="button" data-wire="off">скрыть</button>' +
    '<button type="button" data-wire="on">показать</button>';
  const paint = (): void => {
    wireBox.querySelectorAll<HTMLButtonElement>('button[data-wire]').forEach((b) => {
      b.setAttribute('aria-pressed', String((b.dataset.wire === 'on') === viewer.wire()));
    });
  };
  paint();
  wireBox.addEventListener('click', (event) => {
    const button = (event.target as HTMLElement).closest<HTMLButtonElement>('button[data-wire]');
    if (!button) return;
    viewer.setWire(button.dataset.wire === 'on');
    paint();
  });
}

// --- кнопки варианта ---
const variants = document.getElementById('variants');
if (variants) {
  variants.innerHTML = Object.entries(VARIANTS)
    .map(([key, v]) => `<button type="button" data-variant="${key}" aria-pressed="${key === variant}" title="${v.label}">${key}</button>`)
    .join('');
  variants.addEventListener('click', (event) => {
    const button = (event.target as HTMLElement).closest<HTMLButtonElement>('button[data-variant]');
    if (!button) return;
    variant = button.dataset.variant ?? DEFAULT_VARIANT;
    lastGood = [...roads];
    rebuild();
    variants.querySelectorAll('button').forEach((b) => b.setAttribute('aria-pressed', String(b === button)));
  });
}

// --- кнопки сцены ---
const scenes = document.getElementById('scenes');
if (scenes) {
  scenes.innerHTML = ИМЕНА_СЦЕН
    .map((key) => `<button type="button" data-scene="${key}" aria-pressed="${key === sceneName}">${key}</button>`)
    .join('');
  scenes.addEventListener('click', (event) => {
    const button = (event.target as HTMLElement).closest<HTMLButtonElement>('button[data-scene]');
    if (!button) return;
    sceneName = button.dataset.scene ?? DEFAULT_SCENE;
    roads.splice(0, roads.length, ...дорогиСцены(sceneName));
    lastGood = [...roads];
    rebuild();
    scenes.querySelectorAll('button').forEach((b) => b.setAttribute('aria-pressed', String(b === button)));
  });
}

// --- кнопки рельефа ---
const terrains = document.getElementById('terrains');
if (terrains) {
  terrains.innerHTML = Object.entries(TERRAINS)
    .map(([key, t]) => `<button type="button" data-terrain="${key}" aria-pressed="${key === terrainName}">${t.label}</button>`)
    .join('');
  terrains.addEventListener('click', (event) => {
    const button = (event.target as HTMLElement).closest<HTMLButtonElement>('button[data-terrain]');
    if (!button) return;
    terrainName = button.dataset.terrain ?? DEFAULT_TERRAIN;
    lastGood = [...roads];
    rebuild();
    terrains.querySelectorAll('button').forEach((b) => b.setAttribute('aria-pressed', String(b === button)));
  });
}

const HINTS: Record<string, string> = {
  off: 'перетаскивай — поворот    колесо — приближение',
  idle: 'клик по земле — начать дорогу    правая кнопка — поворот камеры',
  drawing: 'клик — участок прямой    зажми и потяни — участок изогнётся    Esc — закончить линию',
  width: 'веди мышь — число полос щёлкает    клик — готово',
};

function hint(): void {
  const node = document.getElementById('hint');
  if (!node) return;
  const snapped = builder.snapped();
  node.textContent = refusal !== ''
    ? refusal
    : snapped !== ''
      ? `привязка к ${snapped === 'узел' ? 'перекрёстку' : snapped === 'торец' ? 'концу дороги' : 'дороге'} — клик соединит`
      : (HINTS[builder.phase()] ?? HINTS.off);
  node.classList.toggle('refused', refusal !== '');
  node.classList.toggle('snapped', refusal === '' && snapped !== '');
}

readout();
hint();

// Где место (x, z) оказывается на экране — нужно проверке кликами:
// она должна попадать мышью в места мира, а не в пиксели наугад.
(window as unknown as { __project?: (x: number, z: number) => { x: number; y: number } }).__project =
  (x, z) => viewer.project(x, z);

requestAnimationFrame(() => requestAnimationFrame(() => {
  (window as unknown as { __ready?: boolean }).__ready = true;
}));


// ─────────────────────────── ЗА РУЛЁМ ───────────────────────────
// Склейка: мир даёт опору, водитель — четыре числа, машина — новое состояние,
// показ — картинку. Ни одна из четырёх частей не знает про три остальные.

/** Откуда смотрит игрок за рулём. */
let eye: 'сзади' | 'из салона' = 'сзади';

/** Опора под колесом. Те же треугольники, что нарисованы на экране. */
let ground = new GroundIndex(surface);
/** Опора заведена: до этого мига спрашивать высоту земли не у кого. */
const опораГотова = true;

// ── трафик: чужие машины, которые едут сами
let network: Network = buildNetwork(world);
let traffic: Mover[] = [];
let walkers: Walker[] = [];
/**
 * Сколько машин и пешеходов показывать — НЕ ЧИСЛОМ, а по длине улиц, и той
 * же формулой, что у проверки (`сколькоМашин` в `жизнь.ts`). Раньше здесь
 * стояло четыре числа: 18 и 26 на рукотворных сценах, 180 и 220 на городских
 * — потолок под старую цену шага. После полок по дорогам весь «большой
 * город» считается за 7 мс из 16.7, и потолок стал просто неправдой:
 * страница показывала вдвое более пустой город, чем проверяла проверка.
 */
/** Расселение посёлка: кто где живёт. null — сцена без домов. */
let жизнь: Расселение | null = null;
/** Кто снаружи: улица, которая живёт по распорядку жителей. null — сцена без домов. */
let снаружи: Снаружи | null = null;
/**
 * Живёт ли город. Отдельный флаг, а не «есть ли машины в движении»: ночью
 * все стоят в карманах, и город по тому признаку выключался бы сам.
 */
let городЖив = false;
/** Стоящие машины, как они нарисованы: позы считаются раз на изменение стоянки. */
let позыСтоянки: { m: Mover; x: number; y: number; z: number; yaw: number }[] = [];
/**
 * Поза стоящей — по карману: пока она в этом кармане, она не двигается,
 * и поза устареть не может. Встала в другой карман — поза другая: ключ
 * пары «машина — карман» не даёт взять старую.
 */
const позаСтоящей = new WeakMap<Mover, { bay: number; поза: { m: Mover; x: number; y: number; z: number; yaw: number } }>();
let отрисованаСтоянка = -1;
/**
 * С какого часа идёт город. `?час=18` — вечер: улица строится сразу такой,
 * какой она в этот час по распорядку. Часы — настоящие (`СЕКУНД_В_ЧАСЕ`).
 */
const ЧАС_СТАРТА = Number.isFinite(Number(query.get('час'))) && query.get('час') !== null
  ? Number(query.get('час')) : ЧАС_УТРА;
/** Который час от начала жизни города — не по кругу суток: после полуночи 24, 25… */
const часЖизни = (): number => ЧАС_СТАРТА + cityTime / СЕКУНД_В_ЧАСЕ;
/**
 * `?traffic=1` — завести город сразу, без нажатия кнопки. Нужно снимкам из
 * терминала: пустую улицу снять было можно, а живую — только руками, и
 * поэтому её ни разу и не сняли.
 */
const СРАЗУ_ГОРОД = query.get('traffic') === '1';
/** Городские часы: по ним живут светофоры. Не связаны с кадрами. */
let cityTime = 0;
let car: Car | null = null;
/** Машина остаётся в мире, когда из неё вышли: просто перестаёт считаться. */
let driving = false;
const spinAngle = [0, 0, 0, 0];
/**
 * Мышь одна на всех: и руль, и взгляд спрашивают один и тот же захват.
 * Два захвата на одном холсте передрались бы за указатель.
 */
const aim = createAim(canvas ?? document.body);
const driver = createDriver(canvas ?? document.body, aim);

/** Человек на своих двоих. null — сейчас не пешком. */
let walker: Person | null = null;
/** Клавиши ходьбы. Руль их не видит, ходьба не видит руля. */
const afootKeys = new Set<string>();
/** Пикселей мыши на радиан поворота взгляда. */
const LOOK_TRAVEL = 1200;

aim.onMove((dx, dy) => { if (walker !== null) look(walker, dx, dy, LOOK_TRAVEL); });
/**
 * Поворот взгляда на заданный угол — для снимков и проверок из терминала.
 * Мышь под захватом присылает встречные скачки, и снимок с ней получается
 * случайным; а спросить «повернись на 70°» можно ровно.
 */
/** Состояние пешехода — проверкам из терминала, как `__car` для машины. */
(window as unknown as { __walker?: () => unknown }).__walker = () => (walker === null ? null : {
  x: walker.x, z: walker.z,
  body: walker.body, neck: walker.neck, eyeYaw: walker.eyeYaw,
  speed: Math.hypot(walker.vx, walker.vz), walked: walker.walked, lids: walker.lids,
});
(window as unknown as { __turn?: (deg: number) => void }).__turn = (degrees) => {
  if (walker !== null) look(walker, (degrees * Math.PI) / 180 * LOOK_TRAVEL, 0, LOOK_TRAVEL);
};
addEventListener('keydown', (e) => { if (walker !== null) afootKeys.add(e.code); });

/**
 * ─── СЛЕЖКА ЗА ЖИТЕЛЕМ ───
 * `?следить=798` или клавиша F рядом с человеком: камера идёт за ним,
 * а панель показывает его день — из того же распорядка, по которому он
 * живёт (второго описания нет). F ещё раз — перестать.
 */
const следитьИзАдреса = query.get('следить');
let следим: number | null = следитьИзАдреса !== null && Number.isFinite(Number(следитьИзАдреса))
  ? Number(следитьИзАдреса) : null;
const панельСлежки = document.createElement('div');
панельСлежки.id = 'слежка';
панельСлежки.style.cssText = 'position:fixed;left:16px;bottom:96px;max-width:340px;padding:10px 13px;'
  + 'background:var(--panel);border:1px solid var(--edge);border-radius:3px;color:var(--text);'
  + 'font:12px/1.5 var(--mono);white-space:pre;display:none;pointer-events:none;z-index:5';
document.body.append(панельСлежки);
let панельДо = 0;

const ЗАЧЕМ: Record<Зачем, string> = {
  сад: 'в детский сад', школа: 'в школу', работа: 'на работу', магазин: 'в магазин',
  врач: 'к врачу', двор: 'во двор', прогулка: 'погулять', дом: 'домой',
};
const КТО: Record<string, string> = { сад: 'дошкольник', школа: 'школьник', работа: 'работает', дома: 'пенсионер' };
const чч = (час: number): string => {
  const м = Math.round((((час % 24) + 24) % 24) * 60);
  return `${String(Math.floor(м / 60) % 24).padStart(2, '0')}:${String(м % 60).padStart(2, '0')}`;
};
const здание = (объект: number): string => {
  if (объект === -1) return 'за городом';
  const о = посёлокСцены(sceneName)?.объекты[объект];
  return о === undefined ? `объект ${объект}` : `${о.что === 'жильё' ? 'дом' : о.что} №${объект}`;
};

/** Текст панели: кто он и его день, текущая дорога отмечена. */
function деньСловами(номер: number, час: number, точка: ReturnType<typeof гдеЖитель>): string {
  if (жизнь === null) return '';
  const ж = кто(жизнь, номер);
  const м = гдеЖителя(ж, час % 24);
  const сейчас = м.где === 'в пути' ? `идёт ${ЗАЧЕМ[м.зачем]}${м.наМашине ? ' (за рулём)' : ''}`
    : м.где === 'на месте' ? `внутри: ${здание(м.объект)}`
      : м.где === 'во дворе' ? 'во дворе у своего дома'
        : м.где === 'за городом' ? 'за городом' : 'дома';
  const строки = [
    `Житель №${номер} · ${КТО[ж.занятие] ?? ж.занятие}${ж.заРулём ? ' · есть машина' : ''}`,
    `живёт: ${здание(ж.дом)}`,
    `сейчас ${чч(час)}: ${сейчас}${точка.как === 'внутри' || точка.как === 'во дворе' ? ' — ждём у входа' : ''}`,
    '',
    ...ж.день.map((д, i) => `${м.где === 'в пути' && м.i === i ? '▶' : ' '} ${чч(д.выход)}–${чч(д.приход)}  ${ЗАЧЕМ[д.зачем]}`
      + `${д.зачем === 'дом' || д.зачем === 'двор' || д.зачем === 'прогулка' ? '' : ` (${здание(д.куда)})`}${д.наМашине ? ', машиной' : ''}`),
  ];
  return строки.join('\n');
}

addEventListener('keydown', (e) => {
  if (e.code !== 'KeyF' || снаружи === null) return;
  if (следим !== null) { следим = null; viewer.setСлежка(null); панельСлежки.style.display = 'none'; return; }
  // ближайший к игроку житель на улице — пешком или за рулём, в тридцати метрах
  const я = walker ?? car;
  if (я === null) return;
  let ближе = 30;
  for (const w of снаружи.пешие) {
    if (w.житель < 0 || w.state === 'пришёл') continue;
    const п = walkerPose(world, w);
    const d = Math.hypot(п.x - я.x, п.z - я.z);
    if (d < ближе) { ближе = d; следим = w.житель; }
  }
  for (const m of снаружи.машины) {
    if (m.хозяин < 0) continue;
    const п = poseOf(world, network, m);
    const d = Math.hypot(п.x - я.x, п.z - я.z);
    if (d < ближе) { ближе = d; следим = m.хозяин; }
  }
});
addEventListener('keyup', (e) => { afootKeys.delete(e.code); });

const grabWalk = (): void => { aim.take(); };

/**
 * Выйти из машины и пойти пешком — или сесть обратно.
 * Человек ставится у левой двери и смотрит туда же, куда смотрела машина.
 */
function afoot(on: boolean, где: { x: number; z: number; курс: number } | null = null): void {
  if (on) {
    if (driving) seat(false);
    const from = car ?? { x: 0, z: 0, yaw: 0 };
    walker = где !== null ? createPerson(где.x, где.z, ground, где.курс) : createPerson(
      from.x - Math.sin(from.yaw) * 1.7,
      from.z + Math.cos(from.yaw) * 1.7,
      ground, from.yaw,
    );
    canvas?.addEventListener('mousedown', grabWalk);
    aim.take();
  } else {
    walker = null;
    afootKeys.clear();
    canvas?.removeEventListener('mousedown', grabWalk);
    aim.give();
    viewer.setWalk(null);
    if (lidsTop) lidsTop.style.setProperty('--shut', '0');
  }
  drivePanel();
}
const dash = document.getElementById('dash');
/** Веки. Моргание — две тёмные полосы, дешевле присутствия не бывает. */
const lidsTop = document.getElementById('lids');

/**
 * Поставить машину на первую дорогу сцены, носом вдоль неё, на трети пути —
 * чтобы перекрёсток был впереди, а не за спиной и не под колёсами.
 */
function spawnCar(): Car {
  const shape = world.shapes[0];
  const st = shape?.stations ?? [];
  if (st.length < 2) return createCar(VIPER, 0, 0, 0);
  const i = Math.min(Math.floor(st.length * 0.32), st.length - 2);
  const dx = st[i + 1].x - st[i].x, dz = st[i + 1].z - st[i].z;
  const len = Math.hypot(dx, dz) || 1;
  const fx = dx / len, fz = dz / len;
  /**
   * Машина появляется В СВОЕЙ ПОЛОСЕ, а не на осевой и не посреди неё.
   * Полоса берётся из той же таблицы, что у чужих машин: самая правая
   * по ходу. Право по ходу — это (−fz, fx).
   */
  const lane = laneAcross(network.lanes, 0, 1, 0);
  spinAngle.fill(0);
  return createCar(VIPER, st[i].x - fz * lane, st[i].z + fx * lane, Math.atan2(fz, fx));
}

function seat(on: boolean): void {
  if (on && car === null) car = spawnCar();
  if (on) { driver.anchor(); viewer.setEye(eye); } // руль в ноль: садимся с прямыми колёсами
  else driver.release(); // вышел — мышь снова твоя, иначе по кнопкам не попасть
  driving = on;
  viewer.setChase(on);
  if (dash) dash.hidden = !on;
  drivePanel();
}

const el = (id: string): HTMLElement | null => document.getElementById(id);

function drivePanel(): void {
  const panel = el('drive');
  if (!panel) return;
  panel.innerHTML =
    `<button type="button" data-drive="seat" aria-pressed="${driving}">за руль</button>` +
    `<button type="button" data-drive="afoot" aria-pressed="${walker !== null}">пешком</button>` +
    (walker === null ? '' : `<button type="button" class="plain" data-drive="sight" aria-pressed="${viewer.sight()}">глаз</button>`) +
    `<button type="button" class="plain" data-drive="assist" aria-pressed="${driver.assist}">помощь рулю</button>` +
    `<button type="button" class="plain" data-drive="setup">подвеска: ${VIPER.suspension.label}</button>` +
    `<button type="button" class="plain" data-drive="traffic" aria-pressed="${городЖив}">трафик</button>` +
    `<button type="button" class="plain" data-drive="eye">вид: ${eye}</button>` +
    (car === null ? '' : '<button type="button" class="plain" data-drive="park">убрать машину</button>');
  const tip = el('d-tip');
  if (tip) {
    tip.textContent = driver.pad()
      ? 'геймпад подключён: левый стик — руль, курки — газ и тормоз'
      : 'щёлкни по картинке — мышь возьмёт руль. Влево-вправо — руль, W/S — газ '
        + 'и тормоз, Shift — в пол, X — ручник, R — выровнять руль, [ и ] — острота, '
        + 'G — помощь, P — подвеска, C — вид из салона, Enter — выйти';
  }
}

el('drive')?.addEventListener('click', (event) => {
  const button = (event.target as HTMLElement).closest<HTMLButtonElement>('button[data-drive]');
  if (!button) return;
  const what = button.dataset.drive;
  if (what === 'seat') seat(!driving);
  else if (what === 'afoot') afoot(walker === null);
  else if (what === 'sight') { viewer.setSight(!viewer.sight()); drivePanel(); }
  else if (what === 'park') { car = null; driving = false; viewer.setCar(null); viewer.setChase(false); if (dash) dash.hidden = true; drivePanel(); }
  else if (what === 'assist') {
    driver.assist = !driver.assist;
    drivePanel();
  } else if (what === 'traffic') {
    const on = !городЖив;
    // город заново — и счёт нарушений заново: прошлый был про прошлый город
    dog = newWatchdog();
    signsShown = false;
    if (!on) viewer.setSigns([]);
    if (on) заселить(); else { traffic = []; walkers = []; жизнь = null; снаружи = null; городЖив = false; }
    viewer.setTraffic([]);
    viewer.setСтоянка([]);
    позыСтоянки = []; отрисованаСтоянка = -1;
    viewer.setSignals([]);
    viewer.setWalkers([]);
    drivePanel();
  } else if (what === 'eye') {
    eye = eye === 'сзади' ? 'из салона' : 'сзади';
    viewer.setEye(eye);
    drivePanel();
  } else if (what === 'setup') {
    // подвеска меняется на ходу: свободные длины пересчитываются, и машина
    // сама садится на новую высоту — это видно
    const names = Object.keys(SETUPS);
    const next = names[(names.indexOf(VIPER.suspension.label) + 1) % names.length];
    VIPER.suspension = SETUPS[next];
    if (car !== null) car.wheels.forEach((w, i) => { w.rest = restLength(VIPER, i < 2); });
    drivePanel();
  }
});
/**
 * Переключатели ещё и на клавишах: с захваченным указателем по кнопкам мышью
 * не попасть — она отдана рулю. Это не мелочь, а единственный способ менять
 * настройку на ходу.
 */
addEventListener('keydown', (event) => {
  if (event.code === 'KeyO' && walker !== null) { viewer.setSight(!viewer.sight()); drivePanel(); return; }
  if (event.code === 'Enter' && walker !== null) { afoot(false); return; }
  if (event.code === 'Enter' && dash !== null) { seat(!driving); return; }
  if (car === null || !driving) return;
  if (event.code === 'KeyG') { driver.assist = !driver.assist; drivePanel(); }
  if (event.code === 'KeyC') { eye = eye === 'сзади' ? 'из салона' : 'сзади'; viewer.setEye(eye); drivePanel(); }
  if (event.code === 'KeyP') {
    const names = Object.keys(SETUPS);
    VIPER.suspension = SETUPS[names[(names.indexOf(VIPER.suspension.label) + 1) % names.length]];
    car.wheels.forEach((w, i) => { w.rest = restLength(VIPER, i < 2); });
    drivePanel();
  }
});

drivePanel();

/** Шаг физики. Не связан с кадрами: на слабой машине счёт тот же. */
const PHYSICS_STEP = 1 / 300;
/** Кузов в плане — им машина упирается в твердь. */
const ГАБАРИТ = { длина: VIPER.length, ширина: VIPER.width };
/** Чужие машины рядом с пешеходом в этом кадре: подвижная твердь. */
const машиныРядом: Форма[] = [];
let bank = 0;

/**
 * ПОЗА МАШИНЫ НА ЭКРАНЕ — между двумя последними шагами физики.
 *
 * Физика шагает по 1/300 с, кадр идёт, когда его покажет экран, и в кадр
 * укладывается то четыре шага, то пять, то шесть. Показывать последний
 * шаг — значит сдвигать машину за ровный кадр неровно: на 80 км/ч это
 * ±7 см каждый кадр, дрожь. Показывается поза, где машина была ровно
 * на время кадра без одного шага: доля пути от предпоследнего шага
 * к последнему — сколько времени осталось в копилке. Отставание всегда
 * одно и то же, 3 мс, и потому его не видно (так делают все, кто считает
 * физику постоянным шагом: Glenn Fiedler, «Fix Your Timestep!»).
 */
interface Поза {
  x: number; y: number; z: number; yaw: number; pitch: number; roll: number;
  колёса: { x: number; y: number; z: number; steer: number }[];
}
const позаМашины = (c: Car): Поза => ({
  x: c.x, y: c.bodyY, z: c.z, yaw: c.yaw, pitch: c.pitch, roll: c.roll,
  колёса: c.wheels.map((w) => ({ x: w.x, y: w.y, z: w.z, steer: w.steer })),
});
const между = (a: Поза, b: Поза, t: number): Поза => {
  const m = (p: number, q: number): number => p + (q - p) * t;
  return {
    x: m(a.x, b.x), y: m(a.y, b.y), z: m(a.z, b.z),
    yaw: m(a.yaw, b.yaw), pitch: m(a.pitch, b.pitch), roll: m(a.roll, b.roll),
    колёса: a.колёса.map((w, i) => ({
      x: m(w.x, b.колёса[i].x), y: m(w.y, b.колёса[i].y), z: m(w.z, b.колёса[i].z), steer: m(w.steer, b.колёса[i].steer),
    })),
  };
};
/** Поза перед последним шагом физики. null — машина не считается (стоит без водителя). */
let позаДо: Поза | null = null;
/** `?плавно=нет` — показывать последний шаг, как до 25.09: заведомо сломанный вариант `плавность.mjs`. */
const ПОСЛЕДНИЙ_ШАГ = query.get('плавно') === 'нет';
/** Сколько секунд насчитала физика. Не то же, что время на часах. */
let simTime = 0;

let lastControls = { steer: 0, throttle: 0, brake: 0, handbrake: false, assist: true };
/** Сколько раз стукнулись и как сильно в последний раз: для приборки и проверок. */
let crashes = 0;
let lastCrash = 0;
/** Что игрок нарушил. Считается только пока город жив: без трафика светофоры стоят. */
let dog = newWatchdog();
/** Знаки расставлены? Они не меняются, и перекладывать их каждый кадр незачем. */
let signsShown = false;

/**
 * Откуда берутся машины. Если у сцены есть посёлок — ИЗ ЕГО ЖИТЕЛЕЙ: кто
 * сейчас в пути, тот едет, кто дома или на работе, тот стоит у своего
 * подъезда до часа выхода. Нет посёлка — ничьи машины, которые просто ездят
 * и не паркуются: парковаться им не к чему.
 */
function заселить(): void {
  городЖив = true;
  const посёлок = посёлокСцены(sceneName);
  if (посёлок === null) {
    traffic = placeTraffic(world, network, сколькоМашин(network));
    walkers = placeWalkers(world, network, сколькоПешеходов(network));
  } else {
    жизнь = расселить(посёлок);
    // улица — по распорядку: все, кто сейчас в пути, и дальше выходы по часам
    снаружи = вывестиНаУлицу(world, network, жизнь, часЖизни());
    traffic = снаружи.машины;
    walkers = снаружи.пешие;
    отрисованаСтоянка = -1;
  }
}

// город из адреса: ровно то же, что делает кнопка «трафик»
if (СРАЗУ_ГОРОД) заселить();
/**
 * Когда физика впервые увидела газ и когда впервые набрала сотню — по её
 * собственным часам. Проверка снаружи опрашивает страницу редко и неровно,
 * и меряя разгон своими опросами, она мажет на десятую секунды в обе
 * стороны. Пусть страница засекает сама: это точно и не зависит от того,
 * успел ли браузер отдать ответ.
 */
let gasFrom: number | null = null;
let hundredAt: number | null = null;

/** Где были ноги и колёса на прошлом кадре: трава мнётся ОТРЕЗКОМ, а не точкой. */
let следНог: { x: number; z: number } | null = null;
let следКолёс: ({ x: number; z: number } | null)[] = [];
viewer.onFrame((dt) => {
  // здесь только мнём; распрямляется трава сама, по своим часам (растения/показ.ts)
  const примятость = viewer.трава().примятость;
  if (городЖив) {
    const step = Math.min(dt, 0.1);
    cityTime += step;
    moveWalkers(world, network, walkers, step, cityTime);
    const crossing = walkers.filter((w) => w.crossing > 0).map((w) => ({ shape: w.shape, s: w.s }));
    moveTraffic(world, network, traffic, step, cityTime, {
      crossing,
      player: car === null ? null : { x: car.x, z: car.z, speed: forwardSpeed(car), yaw: car.yaw },
      // городской час: по нему стоящая машина понимает, вышел ли хозяин
      час: часЖизни(),
    });
    // выходы по распорядку — на улицу, пришедшие — в здания
    if (жизнь !== null && снаружи !== null) {
      жить(world, network, жизнь, снаружи, часЖизни());
      if (следим !== null && следим < жизнь.всего) {
        const т = гдеЖитель(world, network, жизнь, снаружи, следим, часЖизни());
        viewer.setСлежка({ x: т.x, y: ground.sample(т.x, т.z).height, z: т.z, yaw: т.yaw });
        if (cityTime >= панельДо) {
          панельДо = cityTime + 0.5;
          панельСлежки.textContent = деньСловами(следим, часЖизни(), т);
          панельСлежки.style.display = 'block';
        }
      }
      // стоянка — только когда поменялась: позы и высота земли раз на изменение
      if (снаружи.стоянка !== отрисованаСтоянка) {
        отрисованаСтоянка = снаружи.стоянка;
        позыСтоянки = снаружи.стоят.map((m) => {
          const было = позаСтоящей.get(m);
          if (было !== undefined && было.bay === m.park?.bay) return было.поза;
          const п = poseOf(world, network, m);
          const поза = { m, x: п.x, y: ground.sample(п.x, п.z).height, z: п.z, yaw: m.yaw };
          позаСтоящей.set(m, { bay: m.park?.bay ?? -1, поза });
          return поза;
        });
        viewer.setСтоянка(позыСтоянки.map((п) => ({ x: п.x, y: п.y, z: п.z, yaw: п.yaw, colour: п.m.colour })));
      }
    }
    viewer.setWalkers(walkers.map((w) => {
      const pose = walkerPose(world, w);
      return {
        x: pose.x, y: ground.sample(pose.x, pose.z).height, z: pose.z, yaw: pose.yaw,
        colour: w.colour, штаны: w.штаны, кожа: w.кожа, фаза: фазаШага(w),
      };
    }));

    // светофоры: стойка справа от стоп-линии, головой к подъезжающим
    const lamps: { x: number; y: number; z: number; yaw: number; colour: number }[] = [];
    const GLOW: Record<string, number> = { зелёный: 0x3fbf5a, жёлтый: 0xe8b53a, красный: 0xd6392f };
    for (const signal of network.signals) {
      for (const approach of signal.approaches) {
        const at = along(world, approach.shape, approach.stopS);
        const fx = at.fx * approach.dir, fz = at.fz * approach.dir;
        const side = world.shapes[approach.shape].outerHalf + 0.6;
        const x = at.x - fz * side, z = at.z + fx * side;
        lamps.push({
          x, y: ground.sample(x, z).height, z,
          yaw: Math.atan2(fz, fx) + Math.PI,
          colour: GLOW[lightFor(signal, approach, cityTime).light] ?? 0x555555,
        });
      }
    }
    viewer.setSignals(lamps);

    /**
     * Знаки. Ставятся раз и навсегда, пока город тот же: они не мигают
     * и не двигаются. Место берётся из самой дороги — знак стоит справа
     * по ходу того, кому он адресован, как в жизни.
     */
    if (!signsShown) {
      signsShown = true;
      const знаки = network.signs.all.map((sg) => {
        const at = along(world, sg.shape, sg.s);
        const side = world.shapes[sg.shape].outerHalf + 0.8;
        const fx = at.fx * sg.dir, fz = at.fz * sg.dir;
        const x = at.x - fz * side, z = at.z + fx * side;
        return {
          x, y: ground.sample(x, z).height, z,
          yaw: Math.atan2(fz, fx) + Math.PI,
          kind: sg.kind, value: sg.value,
        };
      });
      viewer.setSigns(знаки);
      // столбы знаков и светофоров твёрдые — в тех же местах, где нарисованы
      твёрдое.столбы = [...знаки, ...lamps].map((с) => круг(с.x, с.z, СТОЛБ));
      пересобратьТвердь();
    }
    // ── ПДД для игрока: те же правила, которыми живёт трафик
    if (driving && car !== null) {
      judge(world, network, dog, {
        x: car.x, z: car.z, yaw: car.yaw, speed: forwardSpeed(car),
      }, cityTime, walkers);
    }
    машиныРядом.length = 0;
    viewer.setTraffic(traffic.map((m) => {
      const pose = poseOf(world, network, m);
      // чужая машина твёрдая для пешехода — в той же позе, в какой нарисована
      if (walker !== null && Math.hypot(pose.x - walker.x, pose.z - walker.z) < 8) {
        машиныРядом.push(коробка(pose.x, pose.z, m.yaw, LENGTH, 2 * WIDE));
      }
      const lights = signalsOf(world, network, m, cityTime);
      return {
        x: pose.x, y: ground.sample(pose.x, pose.z).height, z: pose.z, yaw: m.yaw, colour: m.colour,
        blink: lights.blink, brake: lights.brake,
      };
    }));
  }
  if (walker !== null) {
    const wish = {
      forward: (afootKeys.has('KeyW') ? 1 : 0) - (afootKeys.has('KeyS') ? 1 : 0),
      side: (afootKeys.has('KeyD') ? 1 : 0) - (afootKeys.has('KeyA') ? 1 : 0),
      run: afootKeys.has('ShiftLeft') || afootKeys.has('ShiftRight'),
    };
    if (!городЖив) машиныРядом.length = 0;
    // стоящие в кармане рядом — тоже твёрдые, из тех же поз, что нарисованы
    for (const п of позыСтоянки) {
      if (Math.hypot(п.x - walker.x, п.z - walker.z) < 8) машиныРядом.push(коробка(п.x, п.z, п.yaw, LENGTH, 2 * WIDE));
    }
    // своя машина, брошенная у тротуара, тоже твёрдая
    const своя = car === null ? [] : [коробка(car.x, car.z, car.yaw, VIPER.length, VIPER.width)];
    stepPerson(walker, ground, wish, Math.min(dt, 0.1), {
      упор: (x0, z0, x1, z1) => пройти(твердь, x0, z0, x1, z1, ПЛЕЧИ, [...машиныРядом, ...своя]),
    });
    // нога раздвигает траву в стороны и немного по ходу
    if (следНог !== null) примятость.примять(следНог.x, следНог.z, walker.x, walker.z, 0.3, false);
    следНог = { x: walker.x, z: walker.z };
    viewer.setWalk(eyesOf(walker));
    if (lidsTop) lidsTop.style.setProperty('--shut', walker.lids.toFixed(3));
  } else следНог = null;
  if (car === null) { следКолёс = []; return; }
  const speed = forwardSpeed(car);
  const controls = driving
    ? driver.read(dt)
    : { steer: 0, throttle: 0, brake: 1, handbrake: true, assist: false };
  lastControls = controls;

  bank = driving ? Math.min(bank + dt, 0.3) : 0;
  if (!driving) позаДо = null;
  while (bank >= PHYSICS_STEP) {
    // перед последним шагом этого кадра — запомнить, откуда он шагнул
    if (bank < 2 * PHYSICS_STEP) позаДо = позаМашины(car);
    step(car, VIPER, P_ZERO, (x, z) => ground.sample(x, z), controls, PHYSICS_STEP);
    // твердь — на КАЖДОМ шаге физики: раз в кадр машина успевала зайти в стену на 14 см
    упереть(твердь, car, ГАБАРИТ, VIPER.mass, VIPER.yawInertia);
    bank -= PHYSICS_STEP;
    simTime += PHYSICS_STEP;
  }
  car.wheels.forEach((w, i) => { spinAngle[i] += w.spin * dt; });
  if (gasFrom === null && controls.throttle > 0.05) gasFrom = simTime;
  if (gasFrom !== null && hundredAt === null && Math.abs(speed) >= 27.78) hundredAt = simTime;

  /**
   * УДАР о чужую машину. Считает город: у него кузова всех, кто на дороге,
   * и одна общая мера касания. Машине возвращается только толчок — как ей
   * от него ехать, знает она сама.
   */
  // удар — о едущих и о стоящих рядом (стоящие не в списке движения)
  const я = car;
  const стоятРядом = позыСтоянки.filter((п) => Math.hypot(п.x - я.x, п.z - я.z) < 12).map((п) => п.m);
  const blow = !городЖив ? null : bump(world, network, [...traffic, ...стоятРядом], {
    x: car.x, z: car.z, yaw: car.yaw, vx: car.vx, vz: car.vz,
    yawRate: car.yawRate, mass: VIPER.mass, inertia: VIPER.yawInertia,
  });
  if (blow !== null) {
    car.vx += blow.dvx; car.vz += blow.dvz; car.yawRate += blow.dSpin;
    car.x += blow.pushX; car.z += blow.pushZ;
    crashes++;
    lastCrash = blow.force;
  }

  const сейчас = позаМашины(car);
  const шины = car.wheels;
  const видно = позаДо === null || ПОСЛЕДНИЙ_ШАГ ? сейчас : между(позаДо, сейчас, bank / PHYSICS_STEP);
  viewer.setCar({
    x: видно.x, y: видно.y, z: видно.z,
    yaw: видно.yaw, pitch: видно.pitch, roll: видно.roll, speed,
    wheels: видно.колёса.map((w, i) => ({
      ...w, spin: spinAngle[i],
      radius: шины[i].radius, width: i < 2 ? VIPER.wheelFront.width : VIPER.wheelRear.width,
    })),
  });
  // колесо на земле кладёт траву по ходу — полосой шириной с шину
  car.wheels.forEach((w, i) => {
    const было = следКолёс[i];
    if (w.down && было) {
      примятость.примять(было.x, было.z, w.x, w.z, (i < 2 ? VIPER.wheelFront.width : VIPER.wheelRear.width) / 2, true);
    }
    следКолёс[i] = { x: w.x, z: w.z };
  });

  // приборка
  const speedo = el('d-speed');
  if (speedo) speedo.textContent = String(Math.round(Math.abs(speed) * 3.6));
  const rev = el('d-rev');
  if (rev) {
    rev.style.width = `${(car.rpm / VIPER.cutoffRpm) * 100}%`;
    rev.classList.toggle('red', car.rpm > VIPER.cutoffRpm * 0.92);
  }
  const gear = el('d-gear');
  if (gear) gear.textContent = car.reverse ? 'R' : Math.abs(speed) < 0.3 ? 'N' : String(car.gear + 1);
  const rpm = el('d-rpm');
  if (rpm) rpm.textContent = `${Math.round(car.rpm)} об/мин`;
  const mat = el('d-mat');
  if (mat) mat.textContent = car.wheels[2].material;
  const travel = el('d-travel');
  if (travel) {
    const front = ((car.wheels[0].travel + car.wheels[1].travel) / 2) * 1000;
    const rear = ((car.wheels[2].travel + car.wheels[3].travel) / 2) * 1000;
    travel.textContent = `подвеска ${front.toFixed(0)}/${rear.toFixed(0)} мм`;
  }
  const gas = el('d-gas');
  if (gas) gas.style.height = `${controls.throttle * 100}%`;
  const brake = el('d-brake');
  if (brake) brake.style.height = `${controls.brake * 100}%`;
  const pdd = el('d-pdd');
  if (pdd) {
    const counts = tally(dog);
    pdd.textContent = counts.length === 0 ? 'ПДД: чисто'
      : `ПДД: ${counts.map((c) => `${c.what}${c.count > 1 ? ` ×${c.count}` : ''}`).join(', ')}`;
    pdd.classList.toggle('warn', counts.length > 0);
  }
  const sens = el('d-sens');
  if (sens) sens.textContent = driver.held() ? `руль ${driver.travel} px` : 'щёлкни — возьму руль';
  // руль показывает две вещи: куда просит игрок и где колёса на самом деле
  const wheelMark = el('d-wheel');
  if (wheelMark) wheelMark.setAttribute('transform', `rotate(${driver.command * 240})`);
  const realMark = el('d-real');
  if (realMark) realMark.setAttribute('transform', `rotate(${(car.steer / VIPER.steerLock) * 240})`);
  const hand = el('d-hand');
  if (hand) hand.style.left = `${50 + driver.command * 50}%`;
  const grips = el('d-grips');
  if (grips) {
    if (grips.children.length !== 4) grips.innerHTML = '<i></i><i></i><i></i><i></i>';
    car.wheels.forEach((w, i) => {
      const box = grips.children[i] as HTMLElement;
      const use = Math.min(1.6, w.use);
      // до предела зелёный, за пределом красный: видно, какое колесо поехало
      box.style.background = use < 1
        ? `rgba(127, 196, 107, ${0.2 + use * 0.65})`
        : `rgba(224, 72, 63, ${0.35 + Math.min(1, use - 1) * 0.6})`;
    });
  }
});

/**
 * Снимок состояния машины для проверок из терминала — как `__project` рядом.
 * Нужен потому, что время на часах и время, насчитанное физикой, — разные
 * вещи: в безголовом браузере кадры идут медленнее, и мерить разгон
 * секундомером снаружи бессмысленно.
 */
/** Сколько чужих машин сейчас едет — нужно проверке. */
(window as unknown as { __traffic?: () => unknown }).__traffic = () => traffic.map((m) => {
  const pose = poseOf(world, network, m);
  return {
    shape: m.shape, s: Number(m.s.toFixed(2)), speed: Number(m.speed.toFixed(2)),
    x: Number(pose.x.toFixed(2)), z: Number(pose.z.toFixed(2)),
    knocked: m.knocked !== null,
  };
});

/** Что игрок нарушил: нужно проверке. */
(window as unknown as { __offences?: () => unknown }).__offences = () => dog.list;

/** Сколько раз машина игрока стукнулась о чужую и как сильно в последний раз. */
(window as unknown as { __crash?: () => unknown }).__crash = () => ({
  count: crashes, force: Number(lastCrash.toFixed(2)),
});

/**
 * Что страница ПОКАЗАЛА на самом деле — проверкам из терминала.
 *
 * Нужно вот зачем. Страница по неизвестному имени берёт значение
 * по умолчанию и молчит: человеку, промахнувшемуся в адресе, белый экран
 * не нужен. Но инструменту, который снимает доказательство, подмена
 * смертельна: 17.09 `npm run shot -- наводка город холмы` снял ПЛАТО,
 * и в подсказке самого инструмента написано именно `холмы`. Снимок не той
 * земли хуже отказа — он выглядит как доказательство.
 *
 * Это уже ловили 15 сентября на сценах (`traffic город` полгода гонял
 * «решётку»). Второй раз тот же корень — значит чинится корень, а не случай:
 * список имён не переписывается в инструмент, страница просто ОТВЕЧАЕТ,
 * что у неё вышло, и инструмент сверяет с заказом. Тогда любая молчаливая
 * подмена — сцены, рельефа, варианта, ракурса — видна сразу и вся.
 */
(window as unknown as { __чтоПоказано?: () => unknown }).__чтоПоказано = () => ({
  scene: sceneName, terrain: terrainName, variant, view: показанныйРакурс, подмены,
});

(window as unknown as { __car?: () => unknown }).__car = () => (car === null ? null : {
  x: car.x, z: car.z, yaw: car.yaw, speed: forwardSpeed(car),
  gear: car.gear, reverse: car.reverse, rpm: car.rpm, sim: simTime,
  steer: car.steer, neutral: car.neutral, helped: car.helped, command: driver.command,
  lock: VIPER.steerLock, assist: driver.assist,
  materials: car.wheels.map((w) => w.material),
  loads: car.wheels.map((w) => Math.round(w.load)),
  use: car.wheels.map((w) => Number(w.use.toFixed(2))),
  slip: car.wheels.map((w) => Number(w.slip.toFixed(3))),
  throttle: Number(lastControls.throttle.toFixed(3)),
  gearShown: car.gear,
  lost: car.wheels.some((w) => w.y < -100),
  gasFrom, hundredAt,
});

// первая застройка: мир собран, опора заведена, смотрелка есть
застройка();
зеленьСцены();

/**
 * ?пешком=x,z,курс — начать пешком в этом месте мира, курс в радианах
 * (0 — вдоль x). Снимок оттуда, где стоит игрок (правило 7), без кнопок
 * и мыши: так снимается след в траве и любой вид с уровня глаз.
 */
{
  const где = query.get('пешком')?.split(',').map(Number) ?? [];
  if (где.length >= 2 && где.every(Number.isFinite)) afoot(true, { x: где[0], z: где[1], курс: где[2] ?? 0 });
}
