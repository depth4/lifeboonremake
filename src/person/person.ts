/**
 * Человек на своих двоих: тело, шаг, шея, глаза.
 *
 * Главное устройство: **камера — это не человек, а его глаза в его голове**.
 * Порядок один и только один: ноги ставят тело, тело несёт голову, голова
 * держит глаза, глаза и есть камера. Поэтому «камера уехала отдельно от тела»
 * невыразимо — камеры как самостоятельной вещи тут просто нет.
 *
 * Числа взяты не с потолка, они в `docs/how-presence-works.md`:
 *
 * - **глаза ведут, голова догоняет.** Мышь уводит взгляд мгновенно — это глаза;
 *   голова тянется следом за доли секунды, а глаз в это время возвращается
 *   к середине глазницы. Быстрый рывок мышью читается как «стрельнул глазами»,
 *   долгое ведение — как «повернул голову». Одно движение, два ощущения.
 * - **шея кончается на 80°**, дальше поворот доводится телом, и тело медленнее
 *   головы. Отсюда и невозможность крутнуться на 360°, не переставляя ног.
 * - **тряска шага держится маленькой**, а ходьбу рассказывает крен: от крена
 *   не укачивает, от вертикальной качки укачивает.
 * - **моргание** 15–20 раз в минуту по четверти секунды.
 *
 * Про экран этот файл не знает ничего: считается без браузера, как и весь мир.
 */

/** Опора под ногами: столько же, сколько знает колесо машины. */
export interface Footing {
  sample(x: number, z: number): { height: number; nx: number; ny: number; nz: number };
}

export interface Wish {
  /** Куда идти относительно взгляда: вперёд, вбок. Каждое −1..1. */
  forward: number;
  side: number;
  /** Бежать. */
  run: boolean;
}

export interface Person {
  x: number;
  z: number;
  /** Высота земли под ногами, м. */
  ground: number;
  /** На какой высоте стоит голова: ноги гасят ступеньки, и это их работа. */
  stand: number;
  /** Скорость по земле, м/с. */
  vx: number;
  vz: number;
  /** Куда развёрнуто ТЕЛО, радианы. */
  body: number;
  /** Поворот головы относительно тела, радианы. Ограничен шеей. */
  neck: number;
  /** Наклон головы, радианы. */
  headPitch: number;
  /** Глаза в глазнице относительно головы, радианы. Быстрые и малые. */
  eyeYaw: number;
  eyePitch: number;
  /** Куда просят смотреть — сглаженное движение мыши, радианы. */
  wantYaw: number;
  wantPitch: number;
  /** Мышь уже дёрнулась, а взгляд ещё не забрал: сырое движение ждёт здесь. */
  pendingYaw: number;
  pendingPitch: number;
  /** С какой скоростью сейчас поворачивается ТЕЛО, рад/с. У него есть разгон. */
  bodyRate: number;
  /** Скорость поворота ГОЛОВЫ (тело + шея), рад/с. По ней считается смаз. */
  headRate: number;
  /** Фаза шага, 0..1 по кругу. */
  stride: number;
  /** Сколько прошли ногами, м — по ней и считается шаг. */
  walked: number;
  /** Веки: 0 открыты, 1 закрыты. */
  lids: number;
  /** Сколько осталось от текущего моргания, с. Ноль — глаза открыты. */
  blinking: number;
  /** Через сколько секунд следующее моргание. */
  toBlink: number;
}

/** Рост глаз над землёй, м. */
export const EYE_HEIGHT = 1.62;
/** Скорость шага и бега, м/с. */
const WALK = 1.4;
const RUN = 3.6;
/** Разгон и торможение ног, м/с². Мгновенная остановка ломает ощущение веса. */
const PUSH = 9;
const STOP = 11;
/** Длина шага, м: при 1.4 м/с даёт около двух шагов в секунду. */
const STEP = 0.75;
/** Предел поворота шеи, радианы (80°). */
const NECK = 1.4;
/** Предел отклонения глаз в глазнице, радианы (30°). */
const EYES = 0.52;
/**
 * Сглаживание мыши, с. Сырое движение мыши рваное: браузер присылает его
 * кусками, а под захватом указателя ещё и скачками. Без сглаживания взгляд
 * дёргается на каждый кусок — это и читается как «слишком резко».
 */
const MOUSE_SMOOTH = 0.07;
/** За сколько ГЛАЗ доходит до того, куда просят. Быстро, но не мгновенно. */
const EYE_LAG = 0.045;
/** За сколько ШЕЯ догоняет глаза, с. */
const HEAD_LAG = 0.16;
/**
 * Тело. У него есть разгон и торможение: живое тело не начинает и не
 * прекращает поворот мгновенно, и именно это читается как вес.
 */
const BODY_MAX = 1.9;
const BODY_ACC = 5.5;
/** За сколько тело хочет закрыть оставшийся угол, с. */
const BODY_CLOSE = 0.42;
/** Как быстро тело подтягивается к взгляду на ходу, рад/с. Медленно. */
const ALIGN = 0.9;
/** За сколько ноги гасят ступеньку под ногами, с. */
const ABSORB = 0.11;
/** Наклон головы вверх-вниз, предел. */
const PITCH_LIMIT = 1.3;
/** Тряска шага: вверх-вниз, вбок, крен. Меньше «настоящего» — иначе укачивает. */
const BOB_UP = 0.022;
const BOB_SIDE = 0.014;
const BOB_ROLL = 0.012;
/**
 * Моргание СИМВОЛИЧЕСКОЕ — так просил Алекс, и это его вкус, а не замер.
 * У человека 15–20 раз в минуту по 285 мс, но на экране такое читается как
 * мигающий свет: в жизни своё моргание не видишь, а тут оно чужое.
 * Поэтому реже и вдвое короче — намёк, а не затвор.
 */
const BLINK = 0.15;
const BLINK_SHUT = 0.06;
/** Между морганиями, с. */
const BLINK_GAP = 7;
const BLINK_SPREAD = 4;

const clamp = (v: number, lo: number, hi: number): number => (v < lo ? lo : v > hi ? hi : v);

export function createPerson(x: number, z: number, ground: Footing, facing = 0): Person {
  return {
    x, z,
    ground: ground.sample(x, z).height,
    stand: ground.sample(x, z).height,
    vx: 0, vz: 0,
    body: facing,
    neck: 0, headPitch: 0,
    eyeYaw: 0, eyePitch: 0,
    wantYaw: facing, wantPitch: 0,
    pendingYaw: 0, pendingPitch: 0,
    bodyRate: 0, headRate: 0,
    stride: 0, walked: 0,
    lids: 0, blinking: 0, toBlink: BLINK_GAP,
  };
}

/**
 * Мышь двигает ВЗГЛЯД, а не камеру. Всё остальное — тело, шея, глаза —
 * догоняет взгляд каждое со своей скоростью, и в этом вся разница
 * между «повернул голову» и «камера повернулась».
 */
export function look(person: Person, dx: number, dy: number, perRadian: number): void {
  // движение не попадает во взгляд сразу: оно копится и разбирается плавно
  person.pendingYaw += dx / perRadian;
  person.pendingPitch -= dy / perRadian;
}

/** Куда человек смотрит на самом деле: тело + шея + глаза. */
export function gaze(person: Person): { yaw: number; pitch: number } {
  return {
    yaw: person.body + person.neck + person.eyeYaw,
    pitch: person.headPitch + person.eyePitch,
  };
}

/**
 * Где глаза и как повёрнута голова — всё, что нужно камере.
 * Тряска живёт ЗДЕСЬ, а не в камере: трясётся голова человека, а не мир.
 */
export function eyes(person: Person): {
  x: number; y: number; z: number; yaw: number; pitch: number; roll: number; headRate: number;
} {
  const speed = Math.hypot(person.vx, person.vz);
  // качка затухает на месте и не растёт бесконечно на бегу
  const swing = Math.min(1, speed / WALK);
  const up = Math.sin(person.stride * 4 * Math.PI) * BOB_UP * swing;
  const side = Math.sin(person.stride * 2 * Math.PI) * BOB_SIDE * swing;
  const g = gaze(person);
  return {
    headRate: person.headRate,
    x: person.x + Math.cos(g.yaw + Math.PI / 2) * side,
    y: person.stand + EYE_HEIGHT + up,
    z: person.z + Math.sin(g.yaw + Math.PI / 2) * side,
    yaw: g.yaw,
    pitch: g.pitch,
    roll: Math.sin(person.stride * 2 * Math.PI) * BOB_ROLL * swing,
  };
}

export function step(
  person: Person, ground: Footing, wish: Wish, dt: number,
  /** `neck: false` — снять предел шеи. Заведомо сломанный вариант для проверки. */
  options: { neck?: boolean } = {},
): void {
  const limit = options.neck === false ? Math.PI : NECK;
  const headWas = person.body + person.neck;

  // ── МЫШЬ. Сырое движение разбирается постепенно, а не залпом.
  const take = 1 - Math.exp(-dt / MOUSE_SMOOTH);
  person.wantYaw += person.pendingYaw * take;
  person.pendingYaw *= 1 - take;
  person.wantPitch = clamp(person.wantPitch + person.pendingPitch * take, -PITCH_LIMIT, PITCH_LIMIT);
  person.pendingPitch *= 1 - take;

  // ── ТЕЛО. Поворачивается, когда шея упёрлась, — с разгоном и торможением.
  const beyond = person.wantYaw - person.body;
  const over = beyond > limit ? beyond - limit : beyond < -limit ? beyond + limit : 0;
  const wantRate = clamp(over / BODY_CLOSE, -BODY_MAX, BODY_MAX);
  person.bodyRate += clamp(wantRate - person.bodyRate, -BODY_ACC * dt, BODY_ACC * dt);
  person.body += person.bodyRate * dt;

  // ── ШЕЯ. Догоняет взгляд, дальше предела не идёт.
  const neckWant = clamp(person.wantYaw - person.body, -limit, limit);
  const k = 1 - Math.exp(-dt / HEAD_LAG);
  person.neck += (neckWant - person.neck) * k;
  person.headPitch += (person.wantPitch - person.headPitch) * k;

  // ── ГЛАЗА. Быстрые и малые: доходят за 45 мс и возвращаются, когда шея дошла.
  const eyeWant = clamp(person.wantYaw - person.body - person.neck, -EYES, EYES);
  const eyeK = 1 - Math.exp(-dt / EYE_LAG);
  person.eyeYaw += (eyeWant - person.eyeYaw) * eyeK;
  const eyePitchWant = clamp(person.wantPitch - person.headPitch, -EYES, EYES);
  person.eyePitch += (eyePitchWant - person.eyePitch) * eyeK;

  // смаз считается от ГОЛОВЫ и только от неё: глаз при скачке не смазывает
  person.headRate = Math.abs(person.body + person.neck - headWas) / Math.max(dt, 1e-4);

  // ── НОГИ. Идут туда, куда смотрят, а тело доворачивается по ходу.
  const g = gaze(person);
  const want = Math.hypot(wish.forward, wish.side);
  const speedWant = (wish.run ? RUN : WALK) * Math.min(1, want);
  let wx = 0, wz = 0;
  if (want > 0.001) {
    const ahead = { x: Math.cos(g.yaw), z: Math.sin(g.yaw) };
    const right = { x: -ahead.z, z: ahead.x };
    wx = (ahead.x * wish.forward + right.x * wish.side) / want * speedWant;
    wz = (ahead.z * wish.forward + right.z * wish.side) / want * speedWant;
    /**
     * На ходу тело подтягивается К ВЗГЛЯДУ, а НЕ к направлению шага.
     *
     * Первая редакция разворачивала тело по ходу движения — и это была петля:
     * шаг считается от взгляда, взгляд считается от тела, тело гналось за
     * шагом. Шаг вбок разворачивал тело на 83° за полсекунды, хотя игрок
     * мышь не трогал. Идти боком — нормальная человеческая вещь: тело смотрит
     * туда же, куда голова, ноги приставляются вбок.
     */
    let turn = person.wantYaw - person.body;
    while (turn > Math.PI) turn -= 2 * Math.PI;
    while (turn < -Math.PI) turn += 2 * Math.PI;
    person.body += clamp(turn, -ALIGN * dt, ALIGN * dt);
    person.neck = clamp(person.wantYaw - person.body, -limit, limit);
  }

  // разгон и гашение: мгновенная остановка читается как отсутствие веса
  const rate = (want > 0.001 ? PUSH : STOP) * dt;
  person.vx += clamp(wx - person.vx, -rate, rate);
  person.vz += clamp(wz - person.vz, -rate, rate);

  person.x += person.vx * dt;
  person.z += person.vz * dt;
  person.ground = ground.sample(person.x, person.z).height;
  /**
   * Ноги гасят ступеньку. Бордюр — это 15 см за один кадр; если посадить
   * голову прямо на землю, он бьёт по глазам ударом, которого в жизни нет:
   * колено складывается, и голова проходит ступеньку плавно.
   */
  person.stand += (person.ground - person.stand) * (1 - Math.exp(-dt / ABSORB));

  // ── ШАГ. Считается пройденным путём, а не временем: стоя не шагаем.
  const moved = Math.hypot(person.vx, person.vz) * dt;
  person.walked += moved;
  person.stride = (person.walked / (STEP * 2)) % 1;

  // ── МОРГАНИЕ. Раз в три-четыре секунды, около 280 мс: веко падает быстрее,
  // чем поднимается, — так оно и есть у человека.
  person.toBlink -= dt;
  if (person.toBlink <= 0 && person.blinking <= 0) {
    person.blinking = BLINK;
    person.toBlink = BLINK_GAP + Math.random() * BLINK_SPREAD;
  }
  if (person.blinking > 0) {
    person.blinking = Math.max(0, person.blinking - dt);
    const gone = BLINK - person.blinking;
    person.lids = gone < BLINK_SHUT
      ? gone / BLINK_SHUT
      : Math.max(0, 1 - (gone - BLINK_SHUT) / (BLINK - BLINK_SHUT));
  } else person.lids = 0;
}
