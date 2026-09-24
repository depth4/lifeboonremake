/**
 * Показ мира на экране. Читает готовую поверхность и рисует её.
 * Ничем не владеет: если этот файл убрать, мир останется целым.
 */

import * as THREE from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import type { Material, Surface } from './surface/index.ts';
import type { Point2 } from './world/road.ts';
import { EYE_HEIGHT } from './person/person.ts';
import { type Дом, ДВЕРЬ, ОКНО, ЭТАЖ, осиПроёма } from './city/дом.ts';
import type { Площадка, Плита } from './city/площадка.ts';
import type { Посадочное } from './city/зелень.ts';
import { ПОДЪЁМ_ПОДХОДА, type Вещь, type Подход } from './city/двор.ts';
import { type Sight, createSight } from './person/sight.ts';
import { подключитьСтиль } from './стиль.ts';
import { type Трава, создатьТраву } from './растения/показ.ts';
import { type Деревья, создатьДеревья } from './растения/деревья.ts';

const COLORS: Record<Material, number> = {
  grass: 0x5f8a4a,
  asphalt: 0x3c4046,
  // тротуар светлее асфальта, бордюр темнее тротуара: настоящий бордюр
  // читается тёмной линией, потому что его вертикальная грань в тени
  sidewalk: 0xbbb6a9,
  curb: 0x807c72,
  marking: 0xf0ecdc,
};

/** Земля на крутом откосе — не трава, а обнажённый грунт. */
const SOIL = 0x7a6a4e;
/** Насколько цвет гуляет от места к месту, доля. */
const VARIATION: Record<Material, number> = {
  grass: 0.3, asphalt: 0.1, sidewalk: 0.11, curb: 0.05, marking: 0,
};

/**
 * Пятнистость: одно и то же место всегда даёт одно и то же число.
 * Не случайность, а функция от координат — иначе мир мерцал бы при пересборке.
 */
function blotch(x: number, z: number): number {
  const wave = (fx: number, fz: number, p: number): number =>
    Math.sin(x * fx + Math.cos(z * fz + p) * 2.3) * Math.cos(z * fz * 1.31 - Math.sin(x * fx * 0.7) * 1.7);
  return (wave(0.083, 0.071, 0) * 0.6 + wave(0.31, 0.27, 1.9) * 0.28 + wave(1.05, 0.93, 4.1) * 0.12);
}

/**
 * Цвет каждой вершины: порода + пятнистость места + крутизна склона.
 *
 * Считается ЗДЕСЬ, а не в мире: мир знает, что где лежит, а как оно выглядит —
 * дело показа. Уберите этот файл — мир останется целым.
 */
function shade(surface: Surface, normals: Float32Array): Float32Array {
  const colors = new Float32Array(surface.positions.length);
  const P = surface.positions;
  const I = surface.indices;
  const soil = new THREE.Color(SOIL);
  const tone = new THREE.Color();

  for (const group of surface.groups) {
    const base = new THREE.Color(COLORS[group.material]);
    const swing = VARIATION[group.material];
    for (let k = group.start; k < group.start + group.count; k++) {
      const v = I[k];
      if (colors[v * 3] !== 0 || colors[v * 3 + 1] !== 0 || colors[v * 3 + 2] !== 0) continue;
      tone.copy(base);
      if (group.material === 'grass') {
        // чем круче склон, тем меньше на нём держится трава
        const steep = Math.min(1, Math.max(0, (1 - normals[v * 3 + 1]) * 2.6));
        tone.lerp(soil, steep * 0.72);
      }
      const spot = 1 + blotch(P[v * 3], P[v * 3 + 2]) * swing;
      colors[v * 3] = tone.r * spot;
      colors[v * 3 + 1] = tone.g * spot;
      colors[v * 3 + 2] = tone.b * spot;
    }
  }
  return colors;
}

/** Что показу нужно знать о машине. Ни грамма физики — только поза. */
export interface CarView {
  readonly x: number;
  readonly y: number;
  readonly z: number;
  readonly yaw: number;
  readonly pitch: number;
  readonly roll: number;
  /** Скорость вдоль носа, м/с — камере, чтобы отъезжать на быстром ходу. */
  readonly speed: number;
  readonly wheels: readonly {
    readonly x: number; readonly y: number; readonly z: number;
    readonly steer: number; readonly spin: number;
    readonly radius: number; readonly width: number;
  }[];
}

/**
 * Кузов: боковой силуэт, выдавленный на ширину машины. Так низкая длинная
 * машина читается с любого ракурса, а коробка — нет.
 */
function buildBody(length: number, width: number): THREE.BufferGeometry {
  const nose = length / 2;
  // Силуэт сбоку в метрах над землёй: длинный капот, кабина сдвинута назад,
  // короткий хвост. Обход против часовой стрелки, начиная с носа снизу.
  const points: [number, number][] = [
    [nose - 0.08, 0.16], [nose, 0.34], [nose - 0.55, 0.56], [nose - 1.35, 0.66],
    [nose - 2.05, 0.80], [nose - 2.45, 1.19], [nose - 3.10, 1.21], [nose - 3.55, 0.86],
    [-nose + 0.35, 0.76], [-nose, 0.60], [-nose - 0.02, 0.30], [-nose + 0.35, 0.14],
  ];
  const side = new THREE.Shape();
  side.moveTo(points[0][0], points[0][1]);
  for (const [x, y] of points.slice(1)) side.lineTo(x, y);
  side.closePath();

  // Кузов рисуется чуть уже настоящего: иначе колёса тонут в нём, а колея —
  // величина физическая, её подгонять под картинку нельзя.
  const depth = width - 0.24;
  const geometry = new THREE.ExtrudeGeometry(side, {
    depth, bevelEnabled: true, bevelSize: 0.08, bevelThickness: 0.07, bevelSegments: 2,
  });
  geometry.translate(0, 0, -depth / 2);
  geometry.computeVertexNormals();
  return geometry;
}

/** Простой силуэт городской машины — не Viper: трафик должен отличаться. */
function buildSedan(length: number, width: number): THREE.BufferGeometry {
  const nose = length / 2;
  const points: [number, number][] = [
    [nose - 0.05, 0.22], [nose, 0.42], [nose - 0.75, 0.62], [nose - 1.25, 0.78],
    [nose - 1.75, 1.28], [nose - 2.85, 1.30], [nose - 3.35, 0.80],
    [-nose + 0.25, 0.72], [-nose, 0.5], [-nose - 0.02, 0.26], [-nose + 0.3, 0.16],
  ];
  const side = new THREE.Shape();
  side.moveTo(points[0][0], points[0][1]);
  for (const [x, y] of points.slice(1)) side.lineTo(x, y);
  side.closePath();
  const depth = width - 0.2;
  const geometry = new THREE.ExtrudeGeometry(side, {
    depth, bevelEnabled: true, bevelSize: 0.07, bevelThickness: 0.06, bevelSegments: 2,
  });
  geometry.translate(0, 0, -depth / 2);
  geometry.computeVertexNormals();
  return geometry;
}

export interface View {
  readonly label: string;
  readonly from: [number, number, number];
  readonly at: [number, number, number];
  readonly fog: number;
  /**
   * Числа этого ракурса — В ДОЛЯХ МИРА, а не в метрах.
   *
   * Общие виды («план», «сверху») должны показывать ВЕСЬ мир, какой бы он
   * ни был. Метрами это записать нельзя: мир перестал быть постоянного
   * размера — рукотворные сцены 130 м, город 316, большой 616. Пока камера
   * стояла в метрах, «большой город» уходил за край кадра, а «решётка»
   * болталась островком посреди неба.
   *
   * Размер мира при этом НЕ ПЕРЕДАЁТСЯ снаружи, а меряется по самому
   * полотну: оно и есть мир. Второму числу о размере мира взяться неоткуда,
   * значит и разойтись нечему.
   */
  readonly поМиру?: true;
}

/** Ракурсы: и для кнопок на странице, и для снимков из терминала. */
export const VIEWS: Record<string, View> = {
  // высота 2.3 полумира — это ровно столько, чтобы квадратный мир влезал
  // в кадр по короткой стороне: при поле зрения 48° видно 0.89 высоты
  plan: { label: 'план', from: [0, 2.3, 0.002], at: [0, 0, 0], fog: 7, поМиру: true },
  over: { label: 'сверху', from: [-1.25, 0.95, -1.25], at: [0, -0.02, 0], fog: 7, поМиру: true },
  road: { label: 'вдоль', from: [-118, 52, -128], at: [15, 2, 8], fog: 480 },
  close: { label: 'вблизи', from: [-52, 14, -34], at: [-4, 4, 4], fog: 320 },
  curb: { label: 'с дороги', from: [-48.1, 1.1, -12.7], at: [-8.8, 2.5, 10.0], fog: 200 },
  // сверху на один перекрёсток: только отсюда видно, кто кого пропускает
  node: { label: 'перекрёсток', from: [14, 46, -76], at: [50, 0, -40], fog: 260 },
};

export interface Viewer {
  setView(name: string): void;
  /** Все ракурсы, какие есть у этого мира. Кнопки строятся отсюда и больше ниоткуда. */
  ракурсы(): Record<string, View>;
  setSurface(surface: Surface): void;
  setGhost(mesh: { positions: Float32Array; indices: Uint32Array } | null): void;
  setBuilding(on: boolean): void;
  /** Куда на земле указывает курсор. null — мимо земли. */
  pick(event: PointerEvent | MouseEvent): Point2 | null;
  /** Обратное: где место мира оказывается на экране. */
  project(x: number, z: number): { x: number; y: number };
  /** Показать рёбра треугольников: видно, из чего на самом деле сделан мир. */
  setWire(on: boolean): void;
  wire(): boolean;
  /** Поставить машину в мир. null — убрать. */
  setCar(view: CarView | null): void;
  /** Камера за машиной вместо облёта. */
  setChase(on: boolean): void;
  /** Откуда смотреть за рулём: сзади или с места водителя. */
  setEye(from: 'сзади' | 'из салона'): void;
  /**
   * Пешком: камера становится ГЛАЗАМИ, положение и поворот которых уже
   * посчитал человек. Здесь ничего не додумывается — ни тряски, ни поворота:
   * иначе у камеры завелась бы своя жизнь отдельно от тела.
   */
  setWalk(eye: {
    x: number; y: number; z: number; yaw: number; pitch: number; roll: number; headRate: number;
  } | null): void;
  /** Глаз пешехода: наводка, смаз, свечение, края. Выключается для сравнения. */
  setSight(on: boolean): void;
  sight(): boolean;
  /**
   * Дома посёлка. Один вызов ставит весь город: дома не двигаются, и
   * пересобирать их каждый кадр незачем. Пустой список — убрать застройку.
   *
   * Дом приходит ГОТОВЫМ из `city/дом.ts` — с этажами, окнами и подъездами.
   * Показ ничего не додумывает: он раскладывает то, что ему дали. Поэтому
   * «на картинке четыре этажа, а в расчёте три» невыразимо.
   */
  setBuildings(дома: readonly { дом: Дом; площадка: Площадка }[]): void;
  /**
   * Деревья улиц и дворов. Один вызов ставит всю зелень: дерево не двигается.
   * Место и размеры приходят готовыми из `city/зелень.ts` — показ ничего
   * не додумывает, поэтому «дерево на асфальте» здесь записать негде.
   */
  setTrees(деревья: readonly { дерево: Посадочное; низ: number }[]): void;
  /**
   * Дорожки от тротуара к подъездам. Один вызов ставит все: дорожка
   * не двигается. Место приходит готовым из `city/двор.ts`, показ только
   * кладёт плиту на землю и наклоняет её по уклону.
   */
  setPaths(подходы: readonly { подход: Подход; отY: number; доY: number }[]): void;
  /** Что стоит во дворе: площадка, горки, лавки, баки. Пусто — убрать всё. */
  setВещи(вещи: readonly { вещь: Вещь; низ: number }[]): void;
  /** Крыльца всех дверей: площадки и ступени, уже посчитанные по земле (`city/площадка.ts`). */
  setКрыльца(плиты: readonly Плита[]): void;
  /** Белые линии разметки на асфальте: середина, куда вытянута, длина, высота полотна. */
  setРазметка(линии: readonly { x: number; z: number; курс: number; длина: number; y: number }[]): void;
  /** Позвать это каждый кадр: сюда main двигает физику. */
  onFrame(cb: (dt: number) => void): void;
  /** Трафик: положения чужих машин. Пустой список — убрать всех. */
  setTraffic(cars: readonly {
    x: number; y: number; z: number; yaw: number; colour: number;
    /** Поворотник: −1 левый, +1 правый, 0 погашен. */
    blink?: -1 | 0 | 1;
    /** Горят ли стоп-сигналы. */
    brake?: boolean;
  }[]): void;
  /** Светофоры: где стоят и каким цветом горят. */
  setSignals(lamps: readonly { x: number; y: number; z: number; yaw: number; colour: number }[]): void;
  /** Пешеходы. `фаза` — где человек в шаге, радианы: из неё ходят ноги и руки. */
  setWalkers(people: readonly {
    x: number; y: number; z: number; yaw: number;
    colour: number; штаны: number; кожа: number; фаза: number;
  }[]): void;
  /** Дорожные знаки: где стоят, куда смотрят, какие. */
  setSigns(signs: readonly {
    x: number; y: number; z: number; yaw: number; kind: string; value: number;
  }[]): void;
  /**
   * Трава. Где ей расти, решает не показ, а `растения/поле.ts`; сюда
   * main отдаёт, откуда брать поле, и мнёт траву ногами и колёсами.
   */
  трава(): Трава;
  /** Деревья и кусты из веток. Где стоят — приходит через setTrees; форму листа выбирает main. */
  деревья(): Деревья;
}

/** Ракурс, заданный числами в адресе: ?from=x,y,z&at=x,y,z — чтобы навестись куда угодно. */
export function viewFromQuery(query: URLSearchParams): View | null {
  const triple = (name: string): [number, number, number] | null => {
    const raw = query.get(name);
    if (!raw) return null;
    const parts = raw.split(',').map(Number);
    return parts.length === 3 && parts.every((n) => Number.isFinite(n)) ? [parts[0], parts[1], parts[2]] : null;
  };
  const from = triple('from');
  const at = triple('at');
  if (!from || !at) return null;
  return { label: 'наводка', from, at, fog: Number(query.get('fog') ?? 400) };
}

/** Показывать ли рёбра треугольников сразу: ?wire=1. Дальше — кнопкой. */
const START_WIRE = new URLSearchParams(location.search).get('wire') === '1';


/**
 * ЧЕЛОВЕК — ИЗ КОРОБОК.
 *
 * Раньше пешеход был капсулой: одна гладкая пилюля, которая с любого ракурса
 * читалась «человек вообще». Рядом с миром, целиком собранным из плоских
 * граней и коробок, она выглядела чужой — единственная круглая вещь на улице.
 * Коробки не «проще»: они той же природы, что дома, машины и бордюр, и от
 * этого улица становится одним целым.
 *
 * Важнее вида то, что коробок ШЕСТЬ, а не одна: голова, корпус, две ноги,
 * две руки. У каждой свой поворот, и человек получает походку — ноги и руки
 * ходят в противофазе. Капсуле ходить было нечем.
 *
 * Все размеры — метры, от подошвы вверх. Рост 1.72: средний взрослый.
 * Числа живут ЗДЕСЬ и нигде больше, поэтому «голова оторвалась от шеи»
 * или «ноги длиннее человека» записать негде — всё считается друг от друга.
 */
/** Ноги: от земли до бедра. */
const БЕДРО = 0.84;
/** Корпус: от бедра до плеч. */
const ТЕЛО = { глубина: 0.24, высота: 0.56, ширина: 0.36 };
/** Плечо — верх корпуса. Рука висит С ПЛЕЧА, а не с макушки. */
const ПЛЕЧО = БЕДРО + ТЕЛО.высота;
/**
 * Рука: от плеча до середины бедра. Длина не выдумана, а взята от роста —
 * у человека 1.72 кончики пальцев приходятся примерно на 0.66 м от земли.
 * Первая редакция считала руку «от плеча и почти до земли», 1.12 м, и человек
 * вышел бельевой прищепкой. Это ровно тот случай, когда число надо выводить,
 * а не назначать.
 */
const РУКА = { длина: ПЛЕЧО - 0.66, глубина: 0.12, ширина: 0.10 };
/** Голова: чуть выше плеч, с зазором под шею. */
const ГОЛОВА = { низ: ПЛЕЧО + 0.03, высота: 0.27, ребро: 0.24 };
/**
 * Лицо — тёмная накладка на передней грани головы.
 *
 * Без неё человек из коробок ОДИНАКОВ спереди и сзади, и на снимке нельзя
 * сказать, идёт он к тебе или от тебя. Для живого города это не мелочь:
 * куда смотрит прохожий — половина того, что у него можно прочесть.
 */
const ЛИЦО = {
  высота: 0.09,
  ширина: 0.17,
  толщина: 0.02,
  /**
   * Середина лица приходится РОВНО на ту высоту, с которой смотрит игрок.
   * Рост прохожего и рост человека за камерой — одно число, а не два похожих:
   * иначе однажды окажется, что толпа на голову ниже того, кто в ней идёт.
   */
  надЗемлёй: EYE_HEIGHT,
};
/** Нога. */
const НОГА = { глубина: 0.19, ширина: 0.15 };
/** Насколько ноги расставлены и насколько руки вынесены вбок от оси. */
const РАССТАВ = НОГА.ширина / 2 + 0.03;
const ПЛЕЧИ = ТЕЛО.ширина / 2 + РУКА.ширина / 2;
/**
 * Размах маха на полной скорости, радианы. У идущего человека бедро уходит
 * вперёд-назад примерно на 15° в каждую сторону, рука меньше. Первая редакция
 * ставила 30°, и пешеход маршировал.
 */
const РАЗМАХ_НОГИ = 0.27;
const РАЗМАХ_РУКИ = 0.19;

/**
 * Собрать пачки частей. Коробка руки и ноги сдвинута так, что её НАЧАЛО
 * координат лежит в суставе: тогда «мах» — это просто поворот, и нога не
 * может при повороте уехать из бедра.
 */
function собратьЛюдей(сколько: number): {
  голова: THREE.InstancedMesh; лицо: THREE.InstancedMesh; тело: THREE.InstancedMesh;
  ноги: THREE.InstancedMesh; руки: THREE.InstancedMesh;
} {
  /** Коробка «вглубь × вверх × вбок»; `висит` — подвесить за верхнюю грань. */
  const кусок = (вглубь: number, вверх: number, вбок: number, висит: boolean): THREE.BoxGeometry => {
    const g = new THREE.BoxGeometry(вглубь, вверх, вбок);
    g.translate(0, висит ? -вверх / 2 : 0, 0);
    return g;
  };
  const кожа = (): THREE.Material => new THREE.MeshStandardMaterial({ roughness: 0.92 });
  const пачка = (g: THREE.BufferGeometry, n: number): THREE.InstancedMesh => {
    const m = new THREE.InstancedMesh(g, кожа(), n);
    m.castShadow = true;
    return m;
  };

  return {
    // корпус и голова стоят на своей опоре, поэтому за нижнюю грань
    тело: пачка(кусок(ТЕЛО.глубина, ТЕЛО.высота, ТЕЛО.ширина, false), сколько),
    голова: пачка(кусок(ГОЛОВА.ребро, ГОЛОВА.высота, ГОЛОВА.ребро, false), сколько),
    лицо: пачка(кусок(ЛИЦО.толщина, ЛИЦО.высота, ЛИЦО.ширина, false), сколько),
    // руки и ноги висят на суставе, поэтому за верхнюю
    ноги: пачка(кусок(НОГА.глубина, БЕДРО, НОГА.ширина, true), сколько * 2),
    руки: пачка(кусок(РУКА.глубина, РУКА.длина, РУКА.ширина, true), сколько * 2),
  };
}


/**
 * ДОМ — ИЗ ЧАСТЕЙ, А НЕ КОРОБКА.
 *
 * Раньше застройка была одним мешем одинаковых коробок, и с уровня глаз
 * посёлок выглядел складом контейнеров — Алекс это увидел и справедливо снял
 * сцены с сайта. Дело было не в числе треугольников: у коробки просто нечего
 * читать. Человек узнаёт дом по трём вещам, и все три стоят копейки —
 * цоколь, крыша и проёмы.
 *
 * Все размеры и все проёмы приходят готовыми из `city/дом.ts`. Показ ничего
 * не додумывает: он раскладывает то, что ему дали. Поэтому «на картинке
 * четыре этажа, а в расчёте три» записать негде.
 */
/** Свес крыши за стены, м. */
const СВЕС = 0.45;
/** На сколько проём выступает из стены, м. Меньше — грани мерцают друг сквозь друга. */
const ТОЛЩИНА = 0.09;
/**
 * Цвет стекла: отражение. Внизу в стекле дом напротив и тень, наверху небо;
 * смешиваются по высоте окна над полом первого этажа (числа — 14.09, `norms.ts`
 * ветки friendly-ritchie). Жилое окно днём ОТРАЖАЕТ, комнату сквозь него не видно.
 */
const СТЕКЛО = { внизу: 0x4d5f6b, вверху: 0xa9c8de, небоНа: 14 };
/** Свет в окне днём горит примерно в каждом десятом — 11%, как 14.09. */
const ГОРИТ = { доля: 0.11, цвет: 0xe6d3a3 };
/** Рама и откос: белый профиль, как у пластиковых окон; вход — тёмный козырёк. */
const РАМА = 0xd4d0c8;
const КОЗЫРЁК = 0x4a4640;

/**
 * ГЛУБИНА ПРОЁМА — рама, выступающая из стены, и подоконник.
 *
 * Окно без глубины читается как наклейка: так было до 24.09, и с тротуара
 * дом казался коробкой с нарисованными прямоугольниками. 14.09 глубину
 * давали настоящие дырки в стене; здесь стена — коробка, поэтому глубину
 * даёт рама: стекло лежит на стене, а рама стоит перед ним на `вынос`,
 * и сбоку видно откос. Результат для глаза тот же, а дырок резать не надо.
 *
 * Оси проёма: x — наружу от стены, y — вверх от низа проёма, z — вдоль стены.
 * Одна геометрия на все окна: окно у всех домов одного размера (`ОКНО`),
 * поэтому рама ставится без растяжения, и толщина профиля везде одна.
 * Грани, прижатые к стене, выброшены: их не видно никогда, а окон 18 тысяч.
 */
function обрамление(ширина: number, высота: number, как: { подоконник: boolean; импост: boolean; козырёк: boolean }): THREE.BufferGeometry {
  const ПРОФИЛЬ = 0.1, вынос = 0.14;
  const куски: THREE.BufferGeometry[] = [];
  const кусок = (x: number, y: number, z: number, sx: number, sy: number, sz: number): void => {
    const g = new THREE.BoxGeometry(sx, sy, sz);
    g.translate(x + sx / 2, y, z);
    куски.push(g.toNonIndexed());
  };
  for (const сторона of [-1, 1]) {
    кусок(0, высота / 2, сторона * (ширина / 2 + ПРОФИЛЬ / 2), вынос, высота + ПРОФИЛЬ * 2, ПРОФИЛЬ);
  }
  кусок(0, высота + ПРОФИЛЬ / 2, 0, вынос, ПРОФИЛЬ, ширина);
  if (как.подоконник) кусок(0, -0.03, 0, вынос + 0.1, 0.06, ширина + ПРОФИЛЬ * 2 + 0.12);
  if (как.импост) кусок(0, высота / 2, 0, 0.06, высота, 0.06);
  if (как.козырёк) кусок(0, высота + 0.3, 0, 1.1, 0.12, ширина + 0.9);

  // склеить и выбросить треугольники, смотрящие в стену
  const поз: number[] = [], норм: number[] = [];
  for (const g of куски) {
    const p = g.getAttribute('position'), n = g.getAttribute('normal');
    for (let t = 0; t < p.count; t += 3) {
      if (n.getX(t) < -0.5) continue;
      for (let k = t; k < t + 3; k++) {
        поз.push(p.getX(k), p.getY(k), p.getZ(k));
        норм.push(n.getX(k), n.getY(k), n.getZ(k));
      }
    }
    g.dispose();
  }
  const итог = new THREE.BufferGeometry();
  итог.setAttribute('position', new THREE.Float32BufferAttribute(поз, 3));
  итог.setAttribute('normal', new THREE.Float32BufferAttribute(норм, 3));
  return итог;
}

/**
 * Стекло: коробка, у которой верх светлее низа. Это не картинка, а то же
 * отражение, что и между этажами, только внутри одного окна: верхняя часть
 * стекла видит больше неба. Цвет вершины умножается на цвет окна.
 */
function стеклоОкна(): THREE.BufferGeometry {
  const g = new THREE.BoxGeometry(1, 1, 1);
  g.translate(0, 0.5, 0);
  const p = g.getAttribute('position');
  const цвет: number[] = [];
  for (let k = 0; k < p.count; k++) {
    const т = p.getY(k) > 0.5 ? 1.12 : 0.8;
    цвет.push(т, т, т);
  }
  g.setAttribute('color', new THREE.Float32BufferAttribute(цвет, 3));
  return g;
}

/**
 * Горит ли окно — от МЕСТА окна, а не от номера в списке. Порядок домов
 * поменяется, а свет в том же окне останется: хранить тут нечего.
 */
function горит(x: number, z: number, грань: number, вдоль: number, этаж: number): boolean {
  let h = (Math.round(x * 10) * 374761393 + Math.round(z * 10) * 668265263) >>> 0;
  h = (h ^ Math.imul(грань + 3, 2246822519) ^ Math.imul(Math.round(вдоль * 10) + 7919, 3266489917) ^ Math.imul(этаж + 1, 2654435761)) >>> 0;
  h = Math.imul(h ^ (h >>> 15), 0x2c1b3c6d) >>> 0;
  h = Math.imul(h ^ (h >>> 12), 0x297a2d39) >>> 0;
  return (h >>> 8) / 16777216 < ГОРИТ.доля;
}

/**
 * Двускатная крыша единичного размера: конёк вдоль фасада, скаты на улицу
 * и во двор. Обход вершин задан так, чтобы наружу смотрели лицевые грани, —
 * иначе крыша чернеет с одной стороны, и это видно только с улицы.
 *
 * Два тела из одной формы:
 * - `торцы: true` — замкнутая призма. Это ФРОНТОН: треугольник стены под
 *   крышей, вровень со стеной и её цвета;
 * - `торцы: false` — сама крыша: два ската и дно, без торцевых треугольников.
 *   Крыша шире стен на свес, и до 24.09 её торцы висели тёмными
 *   треугольниками поверх фронтона, а снизу, из-под свеса, взгляд уходил
 *   в пустую оболочку — изнанки не рисовались, и крыша «просвечивала»
 *   (Алекс, снимок с угла дома). Теперь у крыши есть дно, изнанка скатов
 *   рисуется (материал двусторонний), а на торце видна стена-фронтон.
 */
function двускатная(как: { торцы: boolean }): THREE.BufferGeometry {
  const A = [-0.5, 0, -0.5], B = [0.5, 0, -0.5], C = [0.5, 0, 0.5], D = [-0.5, 0, 0.5];
  const E = [0, 1, -0.5], F = [0, 1, 0.5];
  const треугольники = [
    B, F, C, B, E, F,      // скат на улицу
    A, D, F, A, F, E,      // скат во двор
    A, B, C, A, C, D,      // дно: его видно снизу, из-под свеса
    ...(как.торцы ? [A, E, B, D, C, F] : []),
  ];
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(треугольники.flat(), 3));
  g.computeVertexNormals();
  return g;
}

export function show(
  surface: Surface, startView: string, custom: View | null = null,
  /**
   * Ракурсы, которые нельзя записать постоянными числами, потому что они
   * наводятся на ТО, ЧТО ПОКАЗЫВАЮТ, а не на точку карты.
   *
   * Заведено 18.09 после прямого «где дворы, их нету». Дворы были на месте
   * все тридцать шесть, соединённые и с машинами, — но ни один ракурс в меню
   * на них не смотрел: каждый из них это пара постоянных координат, зашитая
   * в код. Город менялся, ракурсы смотрели в одно и то же место.
   */
  ещё: Record<string, View> = {},
): Viewer {
  /** Все ракурсы: постоянные и наведённые. Один список, других нет. */
  const ВСЕ: Record<string, View> = { ...VIEWS, ...ещё };
  const renderer = new THREE.WebGLRenderer({ antialias: true });
  renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
  renderer.setSize(innerWidth, innerHeight);
  renderer.shadowMap.enabled = true;
  renderer.shadowMap.type = THREE.PCFSoftShadowMap;
  document.body.prepend(renderer.domElement);

  /**
   * Полразмера мира — по самому полотну. Общие виды отсчитываются от него,
   * поэтому любая сцена кадрируется одинаково, от «решётки» до города.
   */
  let радиусМира = 128;
  {
    let r = 0;
    for (let i = 0; i < surface.positions.length; i += 3)
      r = Math.max(r, Math.abs(surface.positions[i]), Math.abs(surface.positions[i + 2]));
    if (r > 1) радиусМира = r;
  }

  const scene = new THREE.Scene();
  scene.background = new THREE.Color(0x9fc4dd);
  const fog = new THREE.Fog(0x9fc4dd, 200, 480);
  scene.fog = fog;

  const ground = new THREE.Mesh(new THREE.BufferGeometry(), [] as THREE.Material[]);
  ground.castShadow = true;
  ground.receiveShadow = true;
  scene.add(ground);

  // Сетка рёбер поверх поверхности: та же геометрия, просто видно швы
  const wire = new THREE.LineSegments(
    new THREE.BufferGeometry(),
    new THREE.LineBasicMaterial({ color: 0x14181a, transparent: true, opacity: 0.55 }),
  );
  wire.visible = START_WIRE;
  scene.add(wire);
  let wireOn = START_WIRE;

  let lastGeometry: THREE.BufferGeometry | null = null;

  const applySurface = (next: Surface): void => {
    ground.geometry.dispose();
    (ground.material as THREE.Material[]).forEach((m) => m.dispose());

    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute('position', new THREE.BufferAttribute(next.positions, 3));
    geometry.setIndex(new THREE.BufferAttribute(next.indices, 1));
    geometry.computeVertexNormals();
    const normals = geometry.getAttribute('normal').array as Float32Array;
    geometry.setAttribute('color', new THREE.BufferAttribute(shade(next, normals), 3));

    const materials = next.groups.map((group, i) => {
      geometry.addGroup(group.start, group.count, i);
      return new THREE.MeshStandardMaterial({
        vertexColors: true,
        roughness: group.material === 'marking' ? 0.7 : 0.96,
        metalness: 0,
        // краска лежит на асфальте: пусть всегда ложится поверх него, а не
        // спорит с ним за пиксель
        polygonOffset: group.material === 'marking',
        polygonOffsetFactor: -2,
        polygonOffsetUnits: -2,
      });
    });
    ground.geometry = geometry;
    ground.material = materials;

    wire.geometry.dispose();
    wire.geometry = wireOn ? new THREE.WireframeGeometry(geometry) : new THREE.BufferGeometry();
    lastGeometry = geometry;
  };
  applySurface(surface);

  const ghost = new THREE.Mesh(
    new THREE.BufferGeometry(),
    new THREE.MeshBasicMaterial({ color: 0xffe98a, transparent: true, opacity: 0.62, depthWrite: false }),
  );
  ghost.visible = false;
  ghost.renderOrder = 2;
  ghost.position.y = 0.12;
  scene.add(ghost);

  // ── машина: собирается один раз, дальше только двигается
  const carGroup = new THREE.Group();
  carGroup.visible = false;
  const body = new THREE.Mesh(
    new THREE.BufferGeometry(),
    new THREE.MeshStandardMaterial({ color: 0xb3121d, roughness: 0.35, metalness: 0.25 }),
  );
  body.castShadow = true;
  carGroup.add(body);
  // остекление: тёмная лента чуть шире кузова на высоте кабины
  const glass = new THREE.Mesh(
    new THREE.BoxGeometry(1.32, 0.42, 1.76),
    new THREE.MeshStandardMaterial({ color: 0x1b2226, roughness: 0.16, metalness: 0.35 }),
  );
  glass.position.set(-0.42, 0.94, 0);
  body.add(glass);
  /**
   * Салон: торпедо и руль. Нужны не для красоты — без них вид «из салона»
   * читается как летящая камера, и по рулю не видно, что делают колёса.
   * Руль поворачивается на настоящий угол, помноженный на передаточное
   * число рулевой: 25.9° на колёсах это 432° на руле.
   */
  const interior = new THREE.Group();
  interior.visible = false;
  const dash = new THREE.Mesh(
    new THREE.BoxGeometry(0.7, 0.3, 1.55),
    new THREE.MeshStandardMaterial({ color: 0x1a1d21, roughness: 0.9 }),
  );
  dash.position.set(0.78, 0.8, 0);
  interior.add(dash);
  const hoodTop = new THREE.Mesh(
    new THREE.BoxGeometry(1.5, 0.06, 1.6),
    new THREE.MeshStandardMaterial({ color: 0x8e1420, roughness: 0.4, metalness: 0.2 }),
  );
  hoodTop.position.set(1.6, 0.74, 0);
  interior.add(hoodTop);
  const rim = new THREE.Mesh(
    new THREE.TorusGeometry(0.155, 0.019, 8, 24),
    new THREE.MeshStandardMaterial({ color: 0x14161a, roughness: 0.7 }),
  );
  const spoke = new THREE.Mesh(
    new THREE.BoxGeometry(0.3, 0.02, 0.035),
    new THREE.MeshStandardMaterial({ color: 0x22262b, roughness: 0.8 }),
  );
  const steering = new THREE.Group();
  steering.add(rim, spoke);
  steering.position.set(0.34, 0.83, -0.38);
  steering.rotation.set(0, Math.PI / 2, -Math.PI / 9);
  interior.add(steering);
  body.add(interior);

  const wheelParts: { hub: THREE.Group; tyre: THREE.Mesh }[] = [];
  scene.add(carGroup);
  let bodyBuilt = 0;

  const wheelMaterial = new THREE.MeshStandardMaterial({ color: 0x15171a, roughness: 0.85 });
  const rimMaterial = new THREE.MeshStandardMaterial({ color: 0x9aa0a6, roughness: 0.35, metalness: 0.7 });

  // ── трафик: все чужие машины одной пачкой, иначе на тридцати штуках
  // видеокарта задыхается от отдельных вызовов
  let trafficBody: THREE.InstancedMesh | null = null;
  let trafficWheels: THREE.InstancedMesh | null = null;
  let trafficLamps: THREE.InstancedMesh | null = null;
  let signalPoles: THREE.InstancedMesh | null = null;
  let signalHeads: THREE.InstancedMesh | null = null;
  /**
   * Человек. Части тела лежат КАЖДАЯ своей пачкой: голова со всеми головами,
   * ноги со всеми ногами. Так вся толпа города стоит четыре вызова отрисовки
   * (решение 053 — цена сидит в вызовах, а не в треугольниках), и при этом
   * ноги могут ходить: у каждой части свой поворот.
   */
  let люди: {
    голова: THREE.InstancedMesh; лицо: THREE.InstancedMesh; тело: THREE.InstancedMesh;
    ноги: THREE.InstancedMesh; руки: THREE.InstancedMesh;
  } | null = null;
  /**
   * Вся застройка посёлка. Как и человек, дом разложен по ПАЧКАМ ЧАСТЕЙ:
   * все цоколи в одной, все окна в другой. Весь город — шесть вызовов
   * отрисовки независимо от числа домов (решение 053).
   */
  let застройка: THREE.InstancedMesh[] | null = null;
  /**
   * Рамы окон — только вокруг камеры. Окон в городе 18 тысяч, рама стоит
   * ~50 треугольников, и на всех сразу кадр тяжелел на 36% (замер 24.09:
   * 2.62 → 3.56 млн треугольников). Дальше сотни метров рама — два пикселя,
   * а цена её росла бы вместе с городом. Здесь цена — от того, что рядом.
   * Все места хранятся, в пачку попадают ближние; пересборка — когда камера
   * ушла на `шаг` от прошлой.
   */
  const РАМЫ = { радиус: 100, шаг: 15 };
  let рамыВсе: { меш: THREE.InstancedMesh; матрицы: Float32Array; x: number; z: number } | null = null;
  const рамыРядом = (): void => {
    if (рамыВсе === null) return;
    const cx = camera.position.x, cz = camera.position.z;
    if ((cx - рамыВсе.x) ** 2 + (cz - рамыВсе.z) ** 2 < РАМЫ.шаг ** 2) return;
    рамыВсе.x = cx; рамыВсе.z = cz;
    const { меш, матрицы } = рамыВсе, куда = меш.instanceMatrix.array as Float32Array;
    const R2 = РАМЫ.радиус ** 2;
    let n = 0;
    for (let i = 0; i < матрицы.length; i += 16) {
      if ((матрицы[i + 12] - cx) ** 2 + (матрицы[i + 14] - cz) ** 2 > R2) continue;
      куда.set(матрицы.subarray(i, i + 16), n * 16);
      n++;
    }
    меш.count = n;
    меш.instanceMatrix.needsUpdate = true;
  };
  /** Деревья улиц и дворов: те же пачки, что у домов. */
  /** Дорожки к подъездам: одна пачка на весь город. */
  let дорожки: THREE.InstancedMesh | null = null;
  let крыльца: THREE.InstancedMesh | null = null;
  let разметка: THREE.InstancedMesh | null = null;
  let дворовое: THREE.InstancedMesh | null = null;
  let signGroup: THREE.Group | null = null;

  scene.add(new THREE.HemisphereLight(0xbdd7ee, 0x51603f, 1.05));
  const sun = new THREE.DirectionalLight(0xfff3dd, 2.1);
  sun.position.set(-90, 110, -60);
  sun.castShadow = true;
  sun.shadow.mapSize.set(2048, 2048);
  const shadowBox = sun.shadow.camera;
  shadowBox.left = -170; shadowBox.right = 170; shadowBox.top = 170; shadowBox.bottom = -170;
  shadowBox.near = 1; shadowBox.far = 420;
  scene.add(sun);

  // дальняя плоскость — тоже от размера мира: с высоты над большим городом
  // его дальние углы дальше полутора километров, и на постоянных 1400
  // они бы просто исчезали
  const camera = new THREE.PerspectiveCamera(
    48, innerWidth / innerHeight, 0.5, Math.max(1400, радиусМира * 3.4),
  );
  const controls = new OrbitControls(camera, renderer.domElement);
  controls.enableDamping = true;
  controls.maxPolarAngle = Math.PI * 0.495;

  const LOOKING = { LEFT: THREE.MOUSE.ROTATE, MIDDLE: THREE.MOUSE.DOLLY, RIGHT: THREE.MOUSE.PAN };
  const BUILDING = { LEFT: null, MIDDLE: THREE.MOUSE.DOLLY, RIGHT: THREE.MOUSE.ROTATE };
  controls.mouseButtons = { ...LOOKING };
  const стиль = подключитьСтиль(new URLSearchParams(location.search).get('стиль'), renderer, scene, camera, sun, fog);
  /**
   * Трава обновляется в том же месте, где рисуется кадр, — когда камера
   * уже стоит, где стоит. Время травы — секунды мира, копятся из шагов,
   * а не берутся с часов: остановили мир — замер и ветер.
   */
  const трава = создатьТраву(scene, sun);
  const деревья = создатьДеревья(scene, sun, трава.ветерОбщий);
  let времяТравы = 0;
  /** Съёмка ролика ставит время сама: тогда кадры идут ровно через её шаг. */
  let времяЗадано = false;
  const кадрТравы = (): void => {
    трава.кадр(camera, времяТравы);
    деревья.кадр(camera);
    рамыРядом();
  };
  const рисовать = (): void => { кадрТравы(); if (стиль) стиль(); else renderer.render(scene, camera); };

  let flight: { from: THREE.Vector3; to: THREE.Vector3; look: THREE.Vector3; at: THREE.Vector3; fog: number; t: number } | null = null;

  /** Дымка последнего ракурса: пешеход ставит свою и обязан вернуть эту. */
  let viewFog = 480;
  const apply = (view: View, instant: boolean): void => {
    const k = view.поМиру === true ? радиусМира : 1;
    viewFog = view.fog * k;
    const to = new THREE.Vector3(...view.from).multiplyScalar(k);
    const at = new THREE.Vector3(...view.at).multiplyScalar(k);
    if (instant) {
      camera.position.copy(to);
      controls.target.copy(at);
      fog.far = viewFog;
      fog.near = viewFog * 0.42;
      controls.update();
      return;
    }
    flight = { from: camera.position.clone(), to, look: controls.target.clone(), at, fog: viewFog, t: 0 };
  };
  apply(custom ?? ВСЕ[startView] ?? ВСЕ.road, true);

  addEventListener('resize', () => {
    sight?.resize(innerWidth, innerHeight);
    camera.aspect = innerWidth / innerHeight;
    camera.updateProjectionMatrix();
    renderer.setSize(innerWidth, innerHeight);
  });
  renderer.domElement.addEventListener('contextmenu', (e) => e.preventDefault());

  const raycaster = new THREE.Raycaster();
  const pointer = new THREE.Vector2();

  let onFrameCb: ((dt: number) => void) | null = null;
  let chase = false;
  let eye: 'сзади' | 'из салона' = 'сзади';
  /** Глаза пешехода. Пока они есть, камера — это они, и больше ничего. */
  let walkEye:
    { x: number; y: number; z: number; yaw: number; pitch: number; roll: number; headRate: number }
    | null = null;
  /** Глаз: наводка, смаз, свечение, мягкие края. Заводится, когда пошли пешком. */
  let sight: Sight | null = null;
  /** Глаз выключается целиком — чтобы было с чем сравнить. */
  let sightOn = true;
  /**
   * Земля до горизонта. Мир — плита в полкилометра, и с высоты глаз видно, где
   * он кончается. Раньше это пряталось дымкой — но дымки на пятистах метрах
   * в природе нет, и она читалась как ложь. Теперь земля просто продолжается
   * до горизонта, как ей и положено, а обрыв смотреть перестало быть на что.
   */
  const horizon = new THREE.Mesh(
    // мир — квадрат 240 м; кольцо начинается внутри него и уходит за горизонт
    // мир — квадрат 240 м; кольцо начинается внутри него и уходит за горизонт.
    // Дальше полутора километров не растягиваем: с большой дальностью камеры
    // рушится точность глубины, и наводка на резкость начинает мылить всё
    // подряд — поймано снимком, а не рассуждением.
    new THREE.RingGeometry(90, 1400, 64),
    new THREE.MeshLambertMaterial({ color: COLORS.grass, side: THREE.DoubleSide }),
  );
  horizon.rotation.x = -Math.PI / 2;
  horizon.position.y = -0.35;
  horizon.visible = false;
  horizon.name = 'горизонт';
  scene.add(horizon);
  const chaseEye = new THREE.Vector3();
  const chaseAim = new THREE.Vector3();
  let chaseReady = false;

  const clock = new THREE.Clock();
  renderer.setAnimationLoop(() => {
    const dt = Math.min(0.1, clock.getDelta());
    if (!времяЗадано) времяТравы += dt;
    if (onFrameCb) onFrameCb(dt);
    if (walkEye) {
      camera.up.set(0, 1, 0);
      camera.position.set(walkEye.x, walkEye.y, walkEye.z);
      const cp = Math.cos(walkEye.pitch);
      camera.lookAt(
        walkEye.x + Math.cos(walkEye.yaw) * cp,
        walkEye.y + Math.sin(walkEye.pitch),
        walkEye.z + Math.sin(walkEye.yaw) * cp,
      );
      // крен на шаге — последним, поверх взгляда: качается голова, не мир
      camera.rotateZ(walkEye.roll);
      if (sight && sightOn) { кадрТравы(); sight.render(walkEye.headRate, dt); }
      else рисовать();
      return;
    }
    if (chase && carGroup.visible && eye === 'из салона') {
      /**
       * Из салона. Точка взгляда берётся ИЗ САМОГО КУЗОВА: он уже наклонён
       * подвеской, значит голова водителя качается вместе с машиной сама,
       * без единого отдельного коэффициента «тряски».
       */
      carGroup.updateMatrixWorld(true);
      const head = body.localToWorld(new THREE.Vector3(-0.52, 1.16, -0.38));
      const look = body.localToWorld(new THREE.Vector3(24, 1.06, -0.38));
      camera.position.copy(head);
      camera.up.copy(body.localToWorld(new THREE.Vector3(-0.52, 2.16, -0.38)).sub(head).normalize());
      camera.lookAt(look);
      рисовать();
      return;
    }
    if (chase && carGroup.visible) {
      const ahead = new THREE.Vector3(Math.cos(carGroup.userData.yaw as number), 0, Math.sin(carGroup.userData.yaw as number));
      const speed = (carGroup.userData.speed as number) ?? 0;
      // на скорости камера отъезжает назад: так виден запас дороги впереди
      const back = 7.2 + Math.min(4, Math.abs(speed) * 0.11);
      const eye = carGroup.position.clone().addScaledVector(ahead, -back).add(new THREE.Vector3(0, 2.85, 0));
      const aim = carGroup.position.clone().addScaledVector(ahead, 7).add(new THREE.Vector3(0, 0.9, 0));
      if (!chaseReady) { chaseEye.copy(eye); chaseAim.copy(aim); chaseReady = true; }
      const k = 1 - Math.exp(-dt * 7);
      chaseEye.lerp(eye, k);
      chaseAim.lerp(aim, k);
      camera.position.copy(chaseEye);
      camera.lookAt(chaseAim);
      рисовать();
      return;
    }
    if (flight) {
      flight.t = Math.min(1, flight.t + dt * 1.4);
      const e = flight.t < 0.5 ? 2 * flight.t * flight.t : 1 - Math.pow(-2 * flight.t + 2, 2) / 2;
      camera.position.lerpVectors(flight.from, flight.to, e);
      controls.target.lerpVectors(flight.look, flight.at, e);
      fog.far += (flight.fog - fog.far) * e * 0.25;
      fog.near = fog.far * 0.42;
      if (flight.t >= 1) flight = null;
    }
    controls.update();
    рисовать();
  });

  /**
   * Чего стоит кадр — проверкам из терминала.
   *
   * Меряются ВЫЗОВЫ ОТРИСОВКИ и треугольники, а не миллисекунды. В контейнере
   * рисует программный отрисовщик, и абсолютное время там ничего не значит —
   * это записано ещё в решении 053. А вызовы отрисовки значат: именно их
   * число решает, потянет ли город слабое железо, и именно ради них дома
   * и деревья разложены по пачкам.
   */
  /** Съёмке: поставить время травы, чтобы кадры ролика шли ровно через заданный шаг. */
  (window as unknown as { __времяТравы?: (t: number | null) => void }).__времяТравы = (t) => {
    времяЗадано = t !== null;
    if (t !== null) времяТравы = t;
  };
  /**
   * Съёмке: навести камеру облёта и примять траву тем же вызовом, каким мнут
   * ноги и колёса. Нужно, чтобы снять след сбоку, а не глазами идущего:
   * своего следа с уровня глаз почти не видно.
   */
  (window as unknown as { __навести?: (от: number[], на: number[]) => void }).__навести = (от, на) => {
    flight = null;
    camera.position.set(от[0], от[1], от[2]);
    controls.target.set(на[0], на[1], на[2]);
    controls.update();
  };
  (window as unknown as { __примять?: (ax: number, az: number, bx: number, bz: number, r: number, вдоль: boolean) => void })
    .__примять = (ax, az, bx, bz, r, вдоль) => трава.примятость.примять(ax, az, bx, bz, r, вдоль);
  (window as unknown as { __стоимостьКадра?: () => unknown }).__стоимостьКадра = () => ({
    вызовов: renderer.info.render.calls,
    треугольников: renderer.info.render.triangles,
    трава: трава.цена(),
    деревья: деревья.цена(),
  });

  return {
    setView(name) {
      const view = name === 'наводка' && custom ? custom : ВСЕ[name];
      if (view) apply(view, false);
    },
    ракурсы: () => ВСЕ,
    setSurface(next) {
      applySurface(next);
    },
    setGhost(mesh) {
      ghost.geometry.dispose();
      if (!mesh || mesh.indices.length === 0) {
        ghost.geometry = new THREE.BufferGeometry();
        ghost.visible = false;
        return;
      }
      const geometry = new THREE.BufferGeometry();
      geometry.setAttribute('position', new THREE.BufferAttribute(mesh.positions, 3));
      geometry.setIndex(new THREE.BufferAttribute(mesh.indices, 1));
      ghost.geometry = geometry;
      ghost.visible = true;
    },
    setBuilding(on) {
      controls.mouseButtons = on ? { ...BUILDING } : { ...LOOKING };
      renderer.domElement.style.cursor = on ? 'crosshair' : '';
      if (!on) {
        ghost.visible = false;
      }
    },
    setCar(view) {
      if (view === null) { carGroup.visible = false; return; }
      if (bodyBuilt !== view.wheels.length || wheelParts.length === 0) {
        body.geometry.dispose();
        body.geometry = buildBody(4.463, 1.941);
        for (const w of view.wheels) {
          const hub = new THREE.Group();
          const tyreGeometry = new THREE.CylinderGeometry(w.radius, w.radius, w.width, 22);
          tyreGeometry.rotateX(Math.PI / 2);
          const tyre = new THREE.Mesh(tyreGeometry, wheelMaterial);
          tyre.castShadow = true;
          const rimGeometry = new THREE.CylinderGeometry(w.radius * 0.62, w.radius * 0.62, w.width * 1.02, 16);
          rimGeometry.rotateX(Math.PI / 2);
          tyre.add(new THREE.Mesh(rimGeometry, rimMaterial));
          hub.add(tyre);
          scene.add(hub);
          wheelParts.push({ hub, tyre });
        }
        bodyBuilt = view.wheels.length;
      }
      carGroup.visible = true;
      carGroup.position.set(view.x, view.y, view.z);
      carGroup.rotation.set(0, -view.yaw, 0);
      body.rotation.set(view.roll, 0, view.pitch);
      carGroup.userData.yaw = view.yaw;
      carGroup.userData.speed = view.speed;
      // руль в салоне крутится на настоящий угол колёс × передаточное рулевой
      steering.rotation.z = -Math.PI / 9 - (view.wheels[0]?.steer ?? 0) * 16.7;
      view.wheels.forEach((w, i) => {
        const part = wheelParts[i];
        if (!part) return;
        part.hub.visible = true;
        part.hub.position.set(w.x, w.y + w.radius, w.z);
        part.hub.rotation.set(0, -(view.yaw + w.steer), 0);
        part.tyre.rotation.z = -w.spin;
      });
    },
    setTraffic(cars) {
      if (trafficBody !== null && trafficBody.count !== cars.length) {
        scene.remove(trafficBody, trafficWheels as THREE.Object3D, trafficLamps as THREE.Object3D);
        trafficBody.dispose();
        trafficWheels?.dispose();
        trafficLamps?.dispose();
        trafficBody = null;
        trafficWheels = null;
        trafficLamps = null;
      }
      if (cars.length === 0) return;
      if (trafficBody === null) {
        trafficBody = new THREE.InstancedMesh(
          buildSedan(4.4, 1.82),
          new THREE.MeshStandardMaterial({ roughness: 0.45, metalness: 0.2 }),
          cars.length,
        );
        trafficBody.castShadow = true;
        const wheel = new THREE.CylinderGeometry(0.33, 0.33, 0.23, 14);
        wheel.rotateX(Math.PI / 2);
        trafficWheels = new THREE.InstancedMesh(wheel, wheelMaterial, cars.length * 4);
        /**
         * Огни: по фонарю в каждом углу. Материал БЕЗ СВЕТА (basic) — фонарь
         * должен светиться сам, а не отражать солнце: иначе красный в тени
         * не отличить от чёрного кузова, и на общем плане фонарей просто нет.
         */
        const lamp = new THREE.BoxGeometry(0.34, 0.2, 0.12);
        trafficLamps = new THREE.InstancedMesh(
          lamp, new THREE.MeshBasicMaterial(), cars.length * 4,
        );
        scene.add(trafficBody, trafficWheels, trafficLamps);
      }
      const m = new THREE.Matrix4();
      const tint = new THREE.Color();
      const corners: [number, number][] = [[1.35, 0.78], [1.35, -0.78], [-1.35, 0.78], [-1.35, -0.78]];
      // фонари по углам кузова: перёд длиннее колёсной базы, зад тоже
      const lamps: [number, number][] = [[2.1, 0.72], [2.1, -0.72], [-2.1, 0.72], [-2.1, -0.72]];
      cars.forEach((c, i) => {
        m.makeRotationY(-c.yaw);
        m.setPosition(c.x, c.y, c.z);
        (trafficBody as THREE.InstancedMesh).setMatrixAt(i, m);
        (trafficBody as THREE.InstancedMesh).setColorAt(i, tint.setHex(c.colour));
        const cos = Math.cos(c.yaw), sin = Math.sin(c.yaw);
        corners.forEach(([ahead, left], k) => {
          const wm = new THREE.Matrix4().makeRotationY(-c.yaw);
          wm.setPosition(c.x + ahead * cos - left * sin, c.y + 0.33, c.z + ahead * sin + left * cos);
          (trafficWheels as THREE.InstancedMesh).setMatrixAt(i * 4 + k, wm);
        });
        /**
         * Угол горит жёлтым, если с ЕГО стороны включён поворотник; иначе
         * задний горит красным на торможении; иначе погашен. Право по ходу —
         * это (−fz, fx), поэтому правый угол лежит в отрицательном «влево».
         */
        lamps.forEach(([ahead, left], k) => {
          const lm = new THREE.Matrix4().makeRotationY(-c.yaw);
          lm.setPosition(c.x + ahead * cos - left * sin, c.y + 0.62, c.z + ahead * sin + left * cos);
          (trafficLamps as THREE.InstancedMesh).setMatrixAt(i * 4 + k, lm);
          const side = left > 0 ? -1 : 1;            // слева от оси — левый борт
          const turning = (c.blink ?? 0) === side;
          const lit = turning ? 0xffa415 : (c.brake === true && ahead < 0 ? 0xff2a18 : 0x2a2422);
          (trafficLamps as THREE.InstancedMesh).setColorAt(i * 4 + k, tint.setHex(lit));
        });
      });
      trafficBody.instanceMatrix.needsUpdate = true;
      if (trafficBody.instanceColor) trafficBody.instanceColor.needsUpdate = true;
      (trafficWheels as THREE.InstancedMesh).instanceMatrix.needsUpdate = true;
      (trafficLamps as THREE.InstancedMesh).instanceMatrix.needsUpdate = true;
      if (trafficLamps?.instanceColor) trafficLamps.instanceColor.needsUpdate = true;
    },
    setSignals(lamps) {
      if (signalPoles !== null && signalPoles.count !== lamps.length) {
        scene.remove(signalPoles, signalHeads as THREE.Object3D);
        signalPoles.dispose(); signalHeads?.dispose();
        signalPoles = null; signalHeads = null;
      }
      if (lamps.length === 0) return;
      if (signalPoles === null) {
        const pole = new THREE.CylinderGeometry(0.09, 0.11, 3.2, 8);
        pole.translate(0, 1.6, 0);
        signalPoles = new THREE.InstancedMesh(
          pole, new THREE.MeshStandardMaterial({ color: 0x3a4046, roughness: 0.7 }), lamps.length,
        );
        signalPoles.castShadow = true;
        // голова светофора светится сама: иначе красный в тени не отличить
        const head = new THREE.BoxGeometry(0.34, 0.9, 0.28);
        head.translate(0, 3.4, 0);
        signalHeads = new THREE.InstancedMesh(
          head, new THREE.MeshStandardMaterial({ roughness: 0.45, emissiveIntensity: 1 }), lamps.length,
        );
        scene.add(signalPoles, signalHeads);
      }
      const m = new THREE.Matrix4();
      const tint = new THREE.Color();
      lamps.forEach((l, i) => {
        m.makeRotationY(-l.yaw);
        m.setPosition(l.x, l.y, l.z);
        (signalPoles as THREE.InstancedMesh).setMatrixAt(i, m);
        (signalHeads as THREE.InstancedMesh).setMatrixAt(i, m);
        (signalHeads as THREE.InstancedMesh).setColorAt(i, tint.setHex(l.colour));
      });
      signalPoles.instanceMatrix.needsUpdate = true;
      (signalHeads as THREE.InstancedMesh).instanceMatrix.needsUpdate = true;
      if (signalHeads?.instanceColor) signalHeads.instanceColor.needsUpdate = true;
    },
    трава: () => трава,
    деревья: () => деревья,
    setSigns(signs) {
      /**
       * Знаки рисуются НЕ пачкой одинаковых: у каждого своя картинка,
       * а картинка — это и есть смысл знака. Их немного (десятки на город),
       * поэтому каждый строится отдельно, без ухищрений.
       *
       * Лицо знака рисуется на холсте и натягивается на кружок или щит.
       * Так знак выходит настоящим, с цифрой и каймой, а не цветным пятном.
       */
      if (signGroup !== null) {
        scene.remove(signGroup);
        signGroup.traverse((o) => {
          const m = o as THREE.Mesh;
          if (m.geometry) m.geometry.dispose();
        });
        signGroup = null;
      }
      if (signs.length === 0) return;

      const faces = new Map<string, THREE.Texture>();
      const faceFor = (kind: string, value: number): THREE.Texture => {
        const key = `${kind}:${value}`;
        const had = faces.get(key);
        if (had !== undefined) return had;
        const size = 128;
        const cv = document.createElement('canvas');
        cv.width = size; cv.height = size;
        const g = cv.getContext('2d') as CanvasRenderingContext2D;
        g.clearRect(0, 0, size, size);
        if (kind === '3.24') {
          // круг: белое поле, красная кайма, чёрная цифра
          g.fillStyle = '#c9302c';
          g.beginPath(); g.arc(size / 2, size / 2, size / 2 - 2, 0, Math.PI * 2); g.fill();
          g.fillStyle = '#f4f2ed';
          g.beginPath(); g.arc(size / 2, size / 2, size * 0.36, 0, Math.PI * 2); g.fill();
          g.fillStyle = '#15181c';
          g.font = 'bold 58px system-ui, sans-serif';
          g.textAlign = 'center'; g.textBaseline = 'middle';
          g.fillText(String(value), size / 2, size / 2 + 3);
        } else if (kind === '2.1') {
          // главная дорога: жёлтый ромб в белой кайме
          g.fillStyle = '#f4f2ed';
          g.beginPath();
          g.moveTo(size / 2, 2); g.lineTo(size - 2, size / 2);
          g.lineTo(size / 2, size - 2); g.lineTo(2, size / 2); g.closePath(); g.fill();
          g.fillStyle = '#f0c419';
          g.beginPath();
          g.moveTo(size / 2, 22); g.lineTo(size - 22, size / 2);
          g.lineTo(size / 2, size - 22); g.lineTo(22, size / 2); g.closePath(); g.fill();
        } else {
          // уступите дорогу: белый треугольник вершиной вниз, красная кайма
          g.fillStyle = '#c9302c';
          g.beginPath();
          g.moveTo(4, 14); g.lineTo(size - 4, 14); g.lineTo(size / 2, size - 6); g.closePath(); g.fill();
          g.fillStyle = '#f4f2ed';
          g.beginPath();
          g.moveTo(22, 28); g.lineTo(size - 22, 28); g.lineTo(size / 2, size - 24); g.closePath(); g.fill();
        }
        const tex = new THREE.CanvasTexture(cv);
        tex.colorSpace = THREE.SRGBColorSpace;
        faces.set(key, tex);
        return tex;
      };

      signGroup = new THREE.Group();
      const poleGeo = new THREE.CylinderGeometry(0.05, 0.06, 2.4, 6);
      poleGeo.translate(0, 1.2, 0);
      const poleMat = new THREE.MeshStandardMaterial({ color: 0x8d949b, roughness: 0.6 });
      const plateGeo = new THREE.PlaneGeometry(0.72, 0.72);
      for (const sg of signs) {
        const pole = new THREE.Mesh(poleGeo, poleMat);
        pole.position.set(sg.x, sg.y, sg.z);
        pole.castShadow = true;
        const plate = new THREE.Mesh(plateGeo, new THREE.MeshBasicMaterial({
          map: faceFor(sg.kind, sg.value), transparent: true, side: THREE.DoubleSide,
        }));
        plate.position.set(sg.x, sg.y + 2.2, sg.z);
        plate.rotation.set(0, -sg.yaw + Math.PI / 2, 0);
        signGroup.add(pole, plate);
      }
      scene.add(signGroup);
    },
    setРазметка(линии) {
      if (разметка !== null) { scene.remove(разметка); разметка.dispose(); разметка = null; }
      if (линии.length === 0) return;
      // краска: линия 12 см, чуть над полотном, чтобы не мерцать с асфальтом
      const g = new THREE.BoxGeometry(1, 0.01, 0.12);
      const меш = new THREE.InstancedMesh(g, new THREE.MeshStandardMaterial({ color: 0xe8e6df, roughness: 0.7 }), линии.length);
      меш.receiveShadow = true;
      const м = new THREE.Matrix4(), кв = new THREE.Quaternion(), ось = new THREE.Vector3(0, 1, 0);
      const где = new THREE.Vector3(), размер = new THREE.Vector3();
      линии.forEach((л, i) => {
        кв.setFromAxisAngle(ось, -л.курс);
        где.set(л.x, л.y + 0.012, л.z);
        размер.set(л.длина, 1, 1);
        м.compose(где, кв, размер);
        меш.setMatrixAt(i, м);
      });
      меш.instanceMatrix.needsUpdate = true;
      разметка = меш;
      scene.add(меш);
    },
    setКрыльца(плиты) {
      if (крыльца !== null) { scene.remove(крыльца); крыльца.dispose(); крыльца = null; }
      if (плиты.length === 0) return;
      // бетон: плита стоит на своём низе, до верха — сплошная, как настоящая
      const g = new THREE.BoxGeometry(1, 1, 1);
      g.translate(0, 0.5, 0);
      const меш = new THREE.InstancedMesh(g, new THREE.MeshStandardMaterial({ color: 0x9c978f, roughness: 0.9 }), плиты.length);
      меш.castShadow = true;
      меш.receiveShadow = true;
      const м = new THREE.Matrix4(), кв = new THREE.Quaternion(), ось = new THREE.Vector3(0, 1, 0);
      const где = new THREE.Vector3(), размер = new THREE.Vector3();
      плиты.forEach((п, i) => {
        кв.setFromAxisAngle(ось, -п.курс);
        где.set(п.x, п.низ, п.z);
        размер.set(п.длина, Math.max(0.02, п.верх - п.низ), п.ширина);
        м.compose(где, кв, размер);
        меш.setMatrixAt(i, м);
      });
      меш.instanceMatrix.needsUpdate = true;
      крыльца = меш;
      scene.add(меш);
    },
    setPaths(подходы) {
      if (дорожки !== null) { scene.remove(дорожки); дорожки.dispose(); дорожки = null; }
      if (подходы.length === 0) return;

      /**
       * Дорожка — плита, лежащая НА земле и наклонённая по её уклону.
       * Не вровень: настоящая дорожка тоже выступает над газоном, и это
       * не украшение — иначе её грани мерцали бы сквозь землю.
       */
      const плита = new THREE.BoxGeometry(1, 1, 1);
      плита.translate(0, -0.5, 0);           // начало координат на ВЕРХНЕЙ грани
      const пачкаДорожек = new THREE.InstancedMesh(плита,
        new THREE.MeshStandardMaterial({ roughness: 0.92 }), подходы.length);
      пачкаДорожек.receiveShadow = true;
      пачкаДорожек.count = подходы.length;
      дорожки = пачкаДорожек;
      scene.add(пачкаДорожек);

      const м = new THREE.Matrix4();
      const кв = new THREE.Quaternion();
      const эйлер = new THREE.Euler();
      const место = new THREE.Vector3();
      const размер = new THREE.Vector3();
      const тон2 = new THREE.Color();
      подходы.forEach(({ подход: п, отY, доY }, i) => {
        const dx = п.доX - п.отX, dz = п.доZ - п.отZ;
        const поЗемле = Math.hypot(dx, dz);
        const длина = Math.hypot(поЗемле, доY - отY);
        // наклон плиты по уклону земли: дорожка не висит и не тонет
        эйлер.set(0, -Math.atan2(dz, dx), Math.asin((доY - отY) / Math.max(0.001, длина)));
        кв.setFromEuler(эйлер);
        место.set((п.отX + п.доX) / 2, (отY + доY) / 2 + ПОДЪЁМ_ПОДХОДА, (п.отZ + п.доZ) / 2);
        размер.set(длина, 0.16, п.ширина);
        м.compose(место, кв, размер);
        пачкаДорожек.setMatrixAt(i, м);
        // плитка светлее асфальта и темнее тротуара: её видно, но она не кричит
        пачкаДорожек.setColorAt(i, тон2.setHSL(0.09, 0.05, 0.62));
      });
      пачкаДорожек.instanceMatrix.needsUpdate = true;
      if (пачкаДорожек.instanceColor) пачкаДорожек.instanceColor.needsUpdate = true;
    },
    /**
     * ВЕЩИ ВО ДВОРЕ — одна пачка коробок на весь город, один вызов отрисовки.
     *
     * Коробка тут не бедность, а мера: с уровня глаз двор читается не формой
     * горки, а тем, ЧТО В НЁМ ВООБЩЕ ЕСТЬ. Пустой газон и газон с площадкой,
     * лавками и баками — это разные места, и разница видна с двадцати метров
     * даже на коробках. Форму можно будет уточнить, когда она станет главным,
     * что мешает верить.
     */
    setВещи(вещи) {
      if (дворовое !== null) { scene.remove(дворовое); дворовое.dispose(); дворовое = null; }
      if (вещи.length === 0) return;
      const коробка = new THREE.BoxGeometry(1, 1, 1);
      коробка.translate(0, 0.5, 0);          // начало координат на НИЖНЕЙ грани
      const пачка = new THREE.InstancedMesh(коробка,
        new THREE.MeshStandardMaterial({ roughness: 0.85 }), вещи.length);
      пачка.castShadow = true;
      пачка.receiveShadow = true;
      дворовое = пачка;
      scene.add(пачка);

      const м = new THREE.Matrix4();
      const кв = new THREE.Quaternion();
      const эйлер = new THREE.Euler();
      const место = new THREE.Vector3();
      const размер = new THREE.Vector3();
      const тон = new THREE.Color();
      /** Цвет по назначению: песок, яркая горка, дерево лавки, зелёный бак. */
      const ЦВЕТ: Record<Вещь['что'], [number, number, number]> = {
        площадка: [0.10, 0.38, 0.66],
        горка: [0.02, 0.62, 0.48],
        качели: [0.58, 0.42, 0.44],
        лавка: [0.08, 0.34, 0.34],
        баки: [0.33, 0.30, 0.30],
      };
      вещи.forEach(({ вещь: в, низ }, i) => {
        эйлер.set(0, -в.курс, 0);
        кв.setFromEuler(эйлер);
        место.set(в.x, низ, в.z);
        размер.set(в.длина, в.высота, в.ширина);
        м.compose(место, кв, размер);
        пачка.setMatrixAt(i, м);
        const [h, s2, l] = ЦВЕТ[в.что];
        пачка.setColorAt(i, тон.setHSL(h, s2, l));
      });
      пачка.instanceMatrix.needsUpdate = true;
      if (пачка.instanceColor) пачка.instanceColor.needsUpdate = true;
    },
    setTrees(посадки) {
      /**
       * Дерево — из веток (`растения/дерево.ts`), а не многогранник на палке:
       * многогранник с листьями Алекс назвал «шаром с листьями» (23.09),
       * и был прав — форму дереву дают ветки. Вид и вариант — данные города
       * (`city/зелень.ts`); показ только растит и ставит.
       */
      деревья.поставить(посадки.map(({ дерево: д, низ }) => ({
        x: д.x, z: д.z, низ, вид: д.вид, вариант: д.вариант, курс: д.курс, масштаб: д.масштаб,
      })));
    },
    setBuildings(дома) {
      if (застройка !== null) {
        for (const меш of застройка) { scene.remove(меш); меш.dispose(); }
        застройка = null;
        рамыВсе = null;
      }
      if (дома.length === 0) return;

      const скатных = дома.filter((д) => д.дом.крыша === 'скатная').length;
      const окон = дома.reduce((n, д) => n + д.дом.окна.length, 0);
      const дверей = дома.reduce((n, д) => n + д.дом.двери.length, 0);

      /** Коробка с началом координат на нижней грани: дом СТОИТ на земле. */
      const коробка = (): THREE.BoxGeometry => {
        const g = new THREE.BoxGeometry(1, 1, 1);
        g.translate(0, 0.5, 0);
        return g;
      };
      const пачка = (
        g: THREE.BufferGeometry, n: number, m: THREE.Material,
      ): THREE.InstancedMesh => {
        const меш = new THREE.InstancedMesh(g, m, Math.max(1, n));
        меш.castShadow = true;
        меш.receiveShadow = true;
        меш.count = n;
        return меш;
      };
      const камень = (шероховатость: number): THREE.Material =>
        new THREE.MeshStandardMaterial({ roughness: шероховатость });

      const цоколь = пачка(коробка(), дома.length, камень(0.95));
      const стены = пачка(коробка(), дома.length, камень(0.9));
      const плоские = пачка(коробка(), дома.length - скатных, камень(0.85));
      const скаты = пачка(двускатная({ торцы: false }), скатных,
        new THREE.MeshStandardMaterial({ roughness: 0.8, side: THREE.DoubleSide }));
      /**
       * Фронтон: треугольник стены под торцом крыши, того же цвета, что стена,
       * вровень с ней. Без него торец крыши висел тёмным треугольником над
       * стеной — в жизни там стена, а крыша лишь нависает над ней на свес.
       */
      const фронтоны = пачка(двускатная({ торцы: true }), скатных, камень(0.9));
      /**
       * Окно и дверь СВЕТЯТСЯ САМИ (basic): стекло в тени — это не чёрное
       * пятно, а отражённое небо. С обычным материалом окна на теневой
       * стороне пропадали совсем, и дом снова становился ящиком.
       */
      const окна = пачка(стеклоОкна(), окон, new THREE.MeshBasicMaterial({ vertexColors: true }));
      const двери = пачка(коробка(), дверей, new THREE.MeshBasicMaterial());
      /**
       * Рама освещена (standard): откос в тени, лицо на солнце — по этой
       * разнице глаз и читает глубину. Тени рама не бросает: 18 тысяч рам
       * в карте теней стоили бы второй проход по ним, а тень от рамы в полметра
       * с улицы не разглядеть.
       */
      const рамы = пачка(обрамление(ОКНО.ширина, ОКНО.высота, { подоконник: true, импост: true, козырёк: false }),
        окон, камень(0.7));
      const входы = пачка(обрамление(ДВЕРЬ.ширина, ДВЕРЬ.высота, { подоконник: false, импост: false, козырёк: true }),
        дверей, камень(0.8));
      рамы.castShadow = false;
      застройка = [цоколь, стены, плоские, скаты, фронтоны, окна, двери, рамы, входы];
      scene.add(...застройка);

      const m = new THREE.Matrix4();
      const q = new THREE.Quaternion();
      const e = new THREE.Euler();
      const где = new THREE.Vector3();
      const размер = new THREE.Vector3();
      const тон = new THREE.Color();
      const небо = new THREE.Color(СТЕКЛО.вверху);
      let плоскихN = 0, скатовN = 0, оконN = 0, дверейN = 0;

      /**
       * Поставить часть: смещение в осях дома (вперёд, вбок), НИЗ части над
       * отсчётом и свой доворот. Низ, а не середина: у каждой коробки здесь
       * начало координат на нижней грани. С 15 по 24.09 окнам и дверям
       * передавали середину — и каждая дверь висела над полом на половину
       * своей высоты, 1.15 м, а верхний ряд окон залезал под крышу.
       */
      const часть = (
        меш: THREE.InstancedMesh, номер: number, д: Дом, отсчёт: number,
        вперёд: number, низ: number, вбок: number,
        глубина: number, высота: number, ширина: number, доворот: number, цвет: number,
      ): void => {
        const cos = Math.cos(д.курс), sin = Math.sin(д.курс);
        где.set(д.x + вперёд * cos - вбок * sin, отсчёт + низ, д.z + вперёд * sin + вбок * cos);
        e.set(0, -(д.курс + доворот), 0);
        q.setFromEuler(e);
        размер.set(глубина, высота, ширина);
        m.compose(где, q, размер);
        меш.setMatrixAt(номер, m);
        меш.setColorAt(номер, тон.setHex(цвет));
      };

      /**
       * Цоколь считается от ПОДОШВЫ, всё остальное — от ПОЛА. Это не две
       * системы отсчёта, а одна: пол выше подошвы ровно на цоколь, и оба
       * числа посчитаны из земли под следом в `city/площадка.ts`. Поэтому
       * «угол дома висит над землёй» здесь записать негде: подошва по
       * построению ниже самой низкой земли под домом.
       */
      дома.forEach(({ дом: д, площадка: пл }, i) => {
        // цоколь: чуть шире стен и темнее. Высота его — не постоянная,
        // а ровно то, что земля под домом требует взять на себя
        часть(цоколь, i, д, пл.подошва, 0, 0, 0, д.глубина + 0.36, пл.цоколь,
          д.ширина + 0.36, 0, тон.setHex(д.цвет).multiplyScalar(0.55).getHex());
        часть(стены, i, д, пл.пол, 0, 0, 0, д.глубина, д.высота, д.ширина, 0, д.цвет);

        if (д.крыша === 'скатная') {
          часть(фронтоны, скатовN, д, пл.пол, 0, д.высота, 0,
            д.глубина, д.подъём * 0.98, д.ширина, 0, д.цвет);
          часть(скаты, скатовN++, д, пл.пол, 0, д.высота, 0,
            д.глубина + СВЕС * 2, д.подъём, д.ширина + СВЕС * 2, 0, д.цветКрыши);
        } else {
          // парапет: тонкая плита чуть шире стен — по ней плоская крыша и читается
          часть(плоские, плоскихN++, д, пл.пол, 0, д.высота, 0,
            д.глубина + 0.3, д.подъём, д.ширина + 0.3, 0, д.цветКрыши);
        }

        /** Куда садится проём — `осиПроёма` из `city/дом.ts`, одно место на весь проект. */
        const куда = (п: Дом['двери'][number]): { вперёд: number; вбок: number; доворот: number } => осиПроёма(д, п);

        for (const п of д.двери) {
          const м = куда(п);
          часть(двери, дверейN, д, пл.пол, м.вперёд, 0, м.вбок,
            ТОЛЩИНА, ДВЕРЬ.высота, ДВЕРЬ.ширина, м.доворот, 0x3a2f28);
          часть(входы, дверейN++, д, пл.пол, м.вперёд, 0, м.вбок, 1, 1, 1, м.доворот, КОЗЫРЁК);
        }
        for (const п of д.окна) {
          const м = куда(п);
          const низ = п.этаж * ЭТАЖ + ОКНО.отПола;
          const стекло = горит(д.x, д.z, п.грань, п.вдоль, п.этаж)
            ? ГОРИТ.цвет
            : тон.setHex(СТЕКЛО.внизу).lerp(небо, Math.min(1, низ / СТЕКЛО.небоНа)).getHex();
          часть(окна, оконN, д, пл.пол, м.вперёд, низ, м.вбок,
            ТОЛЩИНА, ОКНО.высота, ОКНО.ширина, м.доворот, стекло);
          часть(рамы, оконN++, д, пл.пол, м.вперёд, низ, м.вбок, 1, 1, 1, м.доворот, РАМА);
        }
      });

      for (const меш of застройка) {
        меш.instanceMatrix.needsUpdate = true;
        if (меш.instanceColor) меш.instanceColor.needsUpdate = true;
      }
      // рамы: все места — в запас, в пачку — ближние (цвет у всех один)
      рамыВсе = { меш: рамы, матрицы: (рамы.instanceMatrix.array as Float32Array).slice(0, окон * 16), x: Infinity, z: Infinity };
      рамы.frustumCulled = false;
      рамыРядом();
    },
    setWalkers(people) {
      if (люди !== null && люди.голова.count !== people.length) {
        for (const часть of Object.values(люди)) { scene.remove(часть); часть.dispose(); }
        люди = null;
      }
      if (people.length === 0) return;
      if (люди === null) {
        люди = собратьЛюдей(people.length);
        scene.add(люди.тело, люди.голова, люди.лицо, люди.ноги, люди.руки);
      }

      const m = new THREE.Matrix4();
      const q = new THREE.Quaternion();
      const e = new THREE.Euler();
      const тон = new THREE.Color();
      const один = new THREE.Vector3(1, 1, 1);
      const где = new THREE.Vector3();

      /** Поставить часть: опора в местных осях (вперёд, вверх, вбок) + свой мах. */
      const часть = (
        меш: THREE.InstancedMesh, номер: number,
        p: { x: number; y: number; z: number; yaw: number },
        вперёд: number, вверх: number, вбок: number, мах: number, цвет: number,
      ): void => {
        const cos = Math.cos(p.yaw), sin = Math.sin(p.yaw);
        // местное «вперёд» — это (cos, sin) по земле, «вбок» — (−sin, cos)
        где.set(p.x + вперёд * cos - вбок * sin, p.y + вверх, p.z + вперёд * sin + вбок * cos);
        // сначала мах вокруг Z (вперёд-назад), потом разворот по курсу
        e.set(0, -p.yaw, мах, 'YZX');
        q.setFromEuler(e);
        m.compose(где, q, один);
        меш.setMatrixAt(номер, m);
        меш.setColorAt(номер, тон.setHex(цвет));
      };

      people.forEach((p, i) => {
        /**
         * Размах маха растёт от того, идёт человек или стоит. Стоящий фазу
         * не двигает вовсе — его путь не растёт, — поэтому «стоит и семенит
         * ногами» невыразимо: махи считаются из той же величины, что и шаг.
         */
        const мах = Math.sin(p.фаза) * РАЗМАХ_НОГИ;
        const махРук = -Math.sin(p.фаза) * РАЗМАХ_РУКИ;
        // корпус качается в такт: за один шаг — два покачивания
        const качка = Math.cos(p.фаза * 2) * 0.012;

        часть(люди!.тело, i, p, 0, БЕДРО + качка, 0, 0, p.colour);
        часть(люди!.голова, i, p, 0, ГОЛОВА.низ + качка, 0, 0, p.кожа);
        // лицо выступает на волос из передней грани, иначе грани мерцают друг сквозь друга
        часть(люди!.лицо, i, p, ГОЛОВА.ребро / 2, ЛИЦО.надЗемлёй - ЛИЦО.высота / 2 + качка, 0, 0, 0x2a2420);
        for (const бок of [0, 1]) {
          const знак = бок === 0 ? 1 : -1;
          часть(люди!.ноги, i * 2 + бок, p, 0, БЕДРО + качка, знак * РАССТАВ, знак * мах, p.штаны);
          часть(люди!.руки, i * 2 + бок, p, 0, ПЛЕЧО + качка, знак * ПЛЕЧИ, знак * махРук, p.colour);
        }
      });

      for (const меш of Object.values(люди)) {
        меш.instanceMatrix.needsUpdate = true;
        if (меш.instanceColor) меш.instanceColor.needsUpdate = true;
      }
    },
    setSight(on) { sightOn = on; },
    sight() { return sightOn; },
    setWalk(next) {
      const wasWalking = walkEye !== null;
      walkEye = next;
      horizon.visible = next !== null;
      if (next !== null && !wasWalking) {
        // пешком воздуха нет: на пятистах метрах его не видно и в жизни
        fog.near = 2200;
        fog.far = 6000;
        // поле зрения шире: у человека оно шире объектива
        camera.fov = 76;
        // земля до горизонта не влезает в дальность ракурсов — раздвигаем,
        // но умеренно: дальше начинает врать глубина, и глаз мылит весь кадр
        camera.far = 1500;
        camera.updateProjectionMatrix();
        /**
         * `?глаз-лучом=1` в адресе возвращает наводку лучом по всей сцене,
         * как было до 18.09. Это заведомо сломанный вариант для проверки,
         * и на живой странице его никто не наберёт случайно.
         */
        sight ??= createSight(renderer, scene, camera, {
          наводкаЛучом: new URLSearchParams(location.search).get('глаз-лучом') === '1',
        });
        sight.resize(innerWidth, innerHeight);
      }
      if (next === null && wasWalking) {
        fog.far = viewFog;
        fog.near = viewFog * 0.42;
        camera.fov = 48;
        camera.far = 1400;
        camera.updateProjectionMatrix();
      }
    },
    setEye(from) {
      eye = from;
      // изнутри кузов не рисуем: иначе видно его изнанку. Салон — наоборот.
      body.visible = true;
      (body.material as THREE.Material).visible = from === 'сзади';
      glass.visible = from === 'сзади';
      interior.visible = from === 'из салона';
      chaseReady = false;
      camera.up.set(0, 1, 0);
    },
    setChase(on) {
      chase = on;
      chaseReady = false;
      controls.enabled = !on;
      if (!on) {
        (body.material as THREE.Material).visible = true;
        glass.visible = true;
        interior.visible = false;
        camera.up.set(0, 1, 0);
      }
      // вышел из машины — камера смотрит на машину, а не туда, где была раньше
      if (!on && carGroup.visible) {
        const ahead = new THREE.Vector3(Math.cos(carGroup.userData.yaw as number), 0, Math.sin(carGroup.userData.yaw as number));
        const side = new THREE.Vector3(-ahead.z, 0, ahead.x);
        controls.target.copy(carGroup.position).add(new THREE.Vector3(0, 0.7, 0));
        camera.position.copy(carGroup.position)
          .addScaledVector(ahead, -6.5).addScaledVector(side, 5.5).add(new THREE.Vector3(0, 3.2, 0));
        controls.update();
      }
    },
    onFrame(cb) {
      onFrameCb = cb;
    },
    setWire(on) {
      wireOn = on;
      wire.visible = on;
      wire.geometry.dispose();
      wire.geometry = on && lastGeometry ? new THREE.WireframeGeometry(lastGeometry) : new THREE.BufferGeometry();
    },
    wire() {
      return wireOn;
    },
    project(x, z) {
      const hit = new THREE.Raycaster();
      hit.set(new THREE.Vector3(x, 400, z), new THREE.Vector3(0, -1, 0));
      const ground = hit.intersectObject(scene.children[0] as THREE.Object3D, false)[0];
      const point = new THREE.Vector3(x, ground ? ground.point.y : 0, z).project(camera);
      const rect = renderer.domElement.getBoundingClientRect();
      return {
        x: rect.left + ((point.x + 1) / 2) * rect.width,
        y: rect.top + ((1 - point.y) / 2) * rect.height,
      };
    },
    pick(event) {
      const rect = renderer.domElement.getBoundingClientRect();
      pointer.x = ((event.clientX - rect.left) / rect.width) * 2 - 1;
      pointer.y = -((event.clientY - rect.top) / rect.height) * 2 + 1;
      raycaster.setFromCamera(pointer, camera);
      const hit = raycaster.intersectObject(ground, false)[0];
      return hit ? { x: hit.point.x, z: hit.point.z } : null;
    },
  };
}
