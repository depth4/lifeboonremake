/**
 * ТРАВА: ГДЕ РАСТЁТ И ГДЕ ПРИМЯТА. Про экран этот файл не знает ничего.
 *
 * Травинок здесь нет вовсе. Травинка — функция места: показ вычисляет её
 * из номера и плитки (`показ.ts`), а сюда приходит спросить две вещи —
 * можно ли расти в этой клетке и на какой высоте земля. Поэтому миллион
 * травинок не стоит ни байта памяти, и одна и та же травинка всегда растёт
 * на одном и том же месте.
 *
 * ЧТО СДЕЛАНО НЕВЫРАЗИМЫМ:
 *
 * - **травинка на асфальте, тротуаре, дорожке, под лавкой.** Клетка
 *   считается травяной, только если ВСЕ ЧЕТЫРЕ её угла лежат в траве
 *   и ни один не занят (`city/двор.ts`: дом, дорожка, вещь двора). Травинка
 *   растёт только в травяной клетке — значит её корень целиком в траве.
 *   Обратная сторона: у бордюра остаётся полоска не шире клетки без
 *   травы, и её прикрывают наклонённые соседки;
 * - **травинка над землёй или под ней.** Высота берётся в углах клетки
 *   из ТЕХ ЖЕ треугольников, по которым едет колесо и идёт нога
 *   (`car/ground.ts`). Второй земли для травы нет;
 * - **примятость, зависящая от числа кадров.** Поле живёт во времени:
 *   распрямление — точная экспонента от прошедших секунд, а примятие
 *   ложится ОТРЕЗКОМ от прошлого места до нынешнего, а не точкой. На 30
 *   и на 144 кадрах в секунду след один и тот же.
 */

import type { Surface } from '../surface/index.ts';
import { type НаЗемле, занято } from '../city/двор.ts';

/** Сторона клетки маски, м. Ширина полоски без травы у бордюра — не больше неё. */
export const КЛЕТКА = 0.25;

/** Сколько клеток работы между передышками: около миллисекунды. */
const ПОРЦИЯ = 25000;

/** Травинка растёт вплотную к стене, дорожке и лавке: запаса нет. */
const ЗАПАС_ТРАВЫ = { дом: 0, подход: 0, вещь: 0 };

/**
 * Где растёт трава в прямоугольном окне мира.
 *
 * Сетка УГЛОВ: (nx + 1) × (nz + 1) точек через `КЛЕТКА` метров, первая
 * в (x0, z0). Клеток nx × nz.
 */
export interface Поле {
  readonly x0: number;
  readonly z0: number;
  readonly nx: number;
  readonly nz: number;
  /** Высота земли в углах, м. Строка — одно z, (nx + 1) чисел. */
  readonly высоты: Float32Array;
  /** 1 — клетка целиком в траве и свободна. Строка — одно z, nx чисел. */
  readonly растёт: Uint8Array;
}

/**
 * Поле травы в окне [x0, x0 + ширина) × [z0, z0 + глубина).
 *
 * `как.маска: 'по центру'` — заведомо сломанный вариант: клетка травяная,
 * если травяной оказался ОДИН угол, а не все четыре. Так делают, когда
 * «примерно хватит», — и травинки вылезают на асфальт у каждого бордюра.
 * `как.занято: false` — не спрашивать, что стоит на земле: трава
 * прорастает сквозь дорожки и детскую площадку.
 */
export function* полеПоШагам(
  поверхность: Surface,
  наЗемле: НаЗемле | null,
  окно: { x0: number; z0: number; ширина: number; глубина: number },
  как: { маска?: 'по центру'; занято?: false } = {},
): Generator<void, Поле, void> {
  const nx = Math.max(1, Math.round(окно.ширина / КЛЕТКА));
  const nz = Math.max(1, Math.round(окно.глубина / КЛЕТКА));
  const x0 = окно.x0, z0 = окно.z0;
  const cx = nx + 1;
  const высоты = new Float32Array(cx * (nz + 1));
  /** Покрытие угла: 0 — ничего, 1 — трава, 2 — что-то другое. */
  const угол = new Uint8Array(cx * (nz + 1));

  /**
   * Сначала вся трава, потом всё остальное поверх. Угол на общем ребре
   * травы и тротуара достаётся тротуару — отсюда «все четыре угла в
   * траве» и значит «клетка целиком в траве».
   */
  const P = поверхность.positions, I = поверхность.indices;
  /**
   * Только треугольники ОКНА, а не всего города: до 25.09 окно в 176 м
   * перебирало все 470 тысяч треугольников «большого города» — 21–72 мс
   * на каждую перестройку, рывок на ходу (Алекс: «рывки при ходьбе
   * и передвижении»). Указатель по клеткам строится один раз на землю.
   */
  const свои = треугольникиОкна(поверхность, x0, z0, x0 + nx * КЛЕТКА, z0 + nz * КЛЕТКА);
  /**
   * Передышка — по ОБЪЁМУ сделанного, в клетках, а не по числу треугольников
   * или вещей: один треугольник газона бывает на десять тысяч клеток, и шаг
   * «через каждые полторы тысячи треугольников» тянулся до 10 мс.
   */
  let работа = 0;
  const у = указатель(поверхность);
  const проход = function* (трава: boolean): Generator<void, void, void> {
    for (const t of свои) {
      if ((у.трава[t] === 1) !== трава) continue;
      if (работа > ПОРЦИЯ) { работа = 0; yield; }
      {
        const k = t * 3;
        const a = I[k] * 3, b = I[k + 1] * 3, c = I[k + 2] * 3;
        const ax = P[a], az = P[a + 2], bx = P[b], bz = P[b + 2], qx = P[c], qz = P[c + 2];
        const d = (bz - qz) * (ax - qx) + (qx - bx) * (az - qz);
        // отвесная стенка бордюра сверху не видна и места на земле не занимает
        if (Math.abs(d) < 1e-9) continue;
        const i0 = Math.max(0, Math.ceil((Math.min(ax, bx, qx) - x0) / КЛЕТКА));
        const i1 = Math.min(nx, Math.floor((Math.max(ax, bx, qx) - x0) / КЛЕТКА));
        const j0 = Math.max(0, Math.ceil((Math.min(az, bz, qz) - z0) / КЛЕТКА));
        const j1 = Math.min(nz, Math.floor((Math.max(az, bz, qz) - z0) / КЛЕТКА));
        for (let j = j0; j <= j1; j++) {
          const z = z0 + j * КЛЕТКА;
          работа += i1 - i0 + 1;
          // большой треугольник газона — тысячи клеток: передышка и посреди него
          if (работа > ПОРЦИЯ) { работа = 0; yield; }
          for (let i = i0; i <= i1; i++) {
            const x = x0 + i * КЛЕТКА;
            const u = ((bz - qz) * (x - qx) + (qx - bx) * (z - qz)) / d;
            const v = ((qz - az) * (x - qx) + (ax - qx) * (z - qz)) / d;
            const w = 1 - u - v;
            if (u < -1e-7 || v < -1e-7 || w < -1e-7) continue;
            const n = j * cx + i;
            угол[n] = трава ? 1 : 2;
            высоты[n] = u * P[a + 1] + v * P[b + 1] + w * P[c + 1];
          }
        }
      }
    }
  };
  yield* проход(true);
  yield* проход(false);

  /**
   * Что стоит на земле — каждую вещь в её собственном ящике. Спрашивается
   * тем же `занято`, что и у деревьев: второго определения «под домом»
   * у травы нет.
   */
  if (наЗемле !== null && как.занято !== false) {
    const закрыть = (часть: НаЗемле, мх0: number, мх1: number, мz0: number, мz1: number): void => {
      const i0 = Math.max(0, Math.floor((мх0 - x0) / КЛЕТКА)), i1 = Math.min(nx, Math.ceil((мх1 - x0) / КЛЕТКА));
      const j0 = Math.max(0, Math.floor((мz0 - z0) / КЛЕТКА)), j1 = Math.min(nz, Math.ceil((мz1 - z0) / КЛЕТКА));
      работа += Math.max(0, (i1 - i0 + 1) * (j1 - j0 + 1)) * 4;
      for (let j = j0; j <= j1; j++)
        for (let i = i0; i <= i1; i++)
          if (угол[j * cx + i] === 1 && занято(часть, x0 + i * КЛЕТКА, z0 + j * КЛЕТКА, ЗАПАС_ТРАВЫ)) угол[j * cx + i] = 2;
    };
    const пусто: НаЗемле = { дома: [], подходы: [], вещи: [] };
    const ящик = (x: number, z: number, курс: number, вдоль: number, поперёк: number): [number, number] => {
      const c = Math.abs(Math.cos(курс)), s = Math.abs(Math.sin(курс));
      return [(вдоль * c + поперёк * s) / 2, (вдоль * s + поперёк * c) / 2];
    };
    // вне окна — мимо, не заводя ничего: вещей в городе тысячи, в окне десятки
    const мимо = (мх0: number, мх1: number, мz0: number, мz1: number): boolean =>
      мх1 < x0 || мх0 > x0 + nx * КЛЕТКА || мz1 < z0 || мz0 > z0 + nz * КЛЕТКА;
    for (const д of наЗемле.дома) {
      const [hx, hz] = ящик(д.x, д.z, д.курс, д.глубина, д.ширина);
      if (мимо(д.x - hx, д.x + hx, д.z - hz, д.z + hz)) continue;
      закрыть({ ...пусто, дома: [д] }, д.x - hx, д.x + hx, д.z - hz, д.z + hz);
      if (работа > ПОРЦИЯ) { работа = 0; yield; }
    }
    for (const п of наЗемле.подходы) {
      const r = п.ширина / 2;
      const мх0 = Math.min(п.отX, п.доX) - r, мх1 = Math.max(п.отX, п.доX) + r;
      const мz0 = Math.min(п.отZ, п.доZ) - r, мz1 = Math.max(п.отZ, п.доZ) + r;
      if (мимо(мх0, мх1, мz0, мz1)) continue;
      закрыть({ ...пусто, подходы: [п] }, мх0, мх1, мz0, мz1);
      if (работа > ПОРЦИЯ) { работа = 0; yield; }
    }
    for (const в of наЗемле.вещи) {
      const [hx, hz] = ящик(в.x, в.z, в.курс, в.длина, в.ширина);
      if (мимо(в.x - hx, в.x + hx, в.z - hz, в.z + hz)) continue;
      закрыть({ ...пусто, вещи: [в] }, в.x - hx, в.x + hx, в.z - hz, в.z + hz);
      if (работа > ПОРЦИЯ) { работа = 0; yield; }
    }
  }

  const растёт = new Uint8Array(nx * nz);
  for (let j = 0; j < nz; j++) {
    работа += nx;
    if (работа > ПОРЦИЯ) { работа = 0; yield; }
    for (let i = 0; i < nx; i++) {
      const a = угол[j * cx + i], b = угол[j * cx + i + 1];
      const c = угол[(j + 1) * cx + i], d = угол[(j + 1) * cx + i + 1];
      растёт[j * nx + i] = как.маска === 'по центру'
        ? (a === 1 || b === 1 || c === 1 || d === 1 ? 1 : 0)
        : (a === 1 && b === 1 && c === 1 && d === 1 ? 1 : 0);
    }
  }
  return { x0, z0, nx, nz, высоты, растёт };
}

/** То же поле целиком, за один раз: для проверок и для первого кадра. */
export function полеТравы(
  поверхность: Surface, наЗемле: НаЗемле | null,
  окно: { x0: number; z0: number; ширина: number; глубина: number },
  как: { маска?: 'по центру'; занято?: false } = {},
): Поле {
  const ход = полеПоШагам(поверхность, наЗемле, окно, как);
  let r = ход.next();
  while (!r.done) r = ход.next();
  return r.value;
}

/** Клетка указателя треугольников, м. */
const КЛЕТКА_УКАЗАТЕЛЯ = 16;

interface Указатель {
  readonly x0: number; readonly z0: number; readonly nx: number; readonly nz: number;
  /** Треугольники клетки c — `номера[начала[c] .. начала[c + 1])`. */
  readonly начала: Uint32Array;
  readonly номера: Uint32Array;
  /** Трава ли треугольник: 1 — да. */
  readonly трава: Uint8Array;
  /** Метка «уже взят в это окно»: чтобы треугольник на стыке клеток не брать дважды. */
  readonly метка: Uint32Array;
  проход: number;
}
const указатели = new WeakMap<Surface, Указатель>();

/** Треугольники земли по клеткам — один раз на землю. */
function указатель(п: Surface): Указатель {
  const был = указатели.get(п);
  if (был !== undefined) return был;
  const P = п.positions, I = п.indices, n = I.length / 3;
  const трава = new Uint8Array(n);
  for (const g of п.groups) if (g.material === 'grass') трава.fill(1, g.start / 3, (g.start + g.count) / 3);
  let мх0 = Infinity, мх1 = -Infinity, мz0 = Infinity, мz1 = -Infinity;
  for (let v = 0; v < P.length; v += 3) {
    мх0 = Math.min(мх0, P[v]); мх1 = Math.max(мх1, P[v]); мz0 = Math.min(мz0, P[v + 2]); мz1 = Math.max(мz1, P[v + 2]);
  }
  const Ш = КЛЕТКА_УКАЗАТЕЛЯ;
  const nx = Math.max(1, Math.ceil((мх1 - мх0) / Ш) + 1), nz = Math.max(1, Math.ceil((мz1 - мz0) / Ш) + 1);
  const клетки = (t: number): [number, number, number, number] => {
    const a = I[t * 3] * 3, b = I[t * 3 + 1] * 3, c = I[t * 3 + 2] * 3;
    return [
      Math.floor((Math.min(P[a], P[b], P[c]) - мх0) / Ш), Math.floor((Math.max(P[a], P[b], P[c]) - мх0) / Ш),
      Math.floor((Math.min(P[a + 2], P[b + 2], P[c + 2]) - мz0) / Ш), Math.floor((Math.max(P[a + 2], P[b + 2], P[c + 2]) - мz0) / Ш),
    ];
  };
  const счёт = new Uint32Array(nx * nz + 1);
  for (let t = 0; t < n; t++) {
    const [i0, i1, j0, j1] = клетки(t);
    for (let j = j0; j <= j1; j++) for (let i = i0; i <= i1; i++) счёт[j * nx + i + 1]++;
  }
  for (let c = 0; c < nx * nz; c++) счёт[c + 1] += счёт[c];
  const начала = счёт.slice();
  const номера = new Uint32Array(счёт[nx * nz]);
  const занято2 = счёт.slice(0, nx * nz);
  for (let t = 0; t < n; t++) {
    const [i0, i1, j0, j1] = клетки(t);
    for (let j = j0; j <= j1; j++) for (let i = i0; i <= i1; i++) номера[занято2[j * nx + i]++] = t;
  }
  const у: Указатель = { x0: мх0, z0: мz0, nx, nz, начала, номера, трава, метка: new Uint32Array(n), проход: 0 };
  указатели.set(п, у);
  return у;
}

/** Номера треугольников, задевающих прямоугольник, каждый по разу. */
function треугольникиОкна(п: Surface, x0: number, z0: number, x1: number, z1: number): number[] {
  const у = указатель(п);
  у.проход++;
  const Ш = КЛЕТКА_УКАЗАТЕЛЯ;
  const i0 = Math.max(0, Math.floor((x0 - у.x0) / Ш)), i1 = Math.min(у.nx - 1, Math.floor((x1 - у.x0) / Ш));
  const j0 = Math.max(0, Math.floor((z0 - у.z0) / Ш)), j1 = Math.min(у.nz - 1, Math.floor((z1 - у.z0) / Ш));
  const из: number[] = [];
  for (let j = j0; j <= j1; j++) for (let i = i0; i <= i1; i++) {
    const c = j * у.nx + i;
    for (let q = у.начала[c]; q < у.начала[c + 1]; q++) {
      const t = у.номера[q];
      if (у.метка[t] === у.проход) continue;
      у.метка[t] = у.проход;
      из.push(t);
    }
  }
  return из;
}

/** Растёт ли трава в точке: клетка, в которую точка попала. */
export function растётЛи(поле: Поле, x: number, z: number): boolean {
  const i = Math.floor((x - поле.x0) / КЛЕТКА), j = Math.floor((z - поле.z0) / КЛЕТКА);
  if (i < 0 || j < 0 || i >= поле.nx || j >= поле.nz) return false;
  return поле.растёт[j * поле.nx + i] === 1;
}

/**
 * Высота земли под травинкой: между четырьмя углами её клетки. Ровно так же
 * её считает видеокарта — по углам, с линейным смешением.
 */
export function высотаПоля(поле: Поле, x: number, z: number): number {
  const fx = (x - поле.x0) / КЛЕТКА, fz = (z - поле.z0) / КЛЕТКА;
  const i = Math.min(поле.nx - 1, Math.max(0, Math.floor(fx)));
  const j = Math.min(поле.nz - 1, Math.max(0, Math.floor(fz)));
  const tx = fx - i, tz = fz - j, cx = поле.nx + 1, h = поле.высоты;
  const a = h[j * cx + i], b = h[j * cx + i + 1], c = h[(j + 1) * cx + i], d = h[(j + 1) * cx + i + 1];
  return (a * (1 - tx) + b * tx) * (1 - tz) + (c * (1 - tx) + d * tx) * tz;
}

/* ─────────────────────────── примятость ─────────────────────────── */

/** Сторона клетки примятости, м. */
export const КЛЕТКА_СЛЕДА = 0.25;
/** Клеток по стороне окна примятости: окно 32 × 32 м вокруг игрока. */
export const СТОРОНА_СЛЕДА = 128;
/** За сколько секунд примятость спадает в e раз. Трава поднимается не сразу. */
export const РАСПРЯМЛЕНИЕ = 9;

/**
 * Где и куда примята трава вокруг игрока. Окно ходит за игроком по кругу
 * (кольцевой адрес): клетка с мировым номером (i, j) живёт в ячейке
 * (i mod N, j mod N), поэтому при шаге окна ничего не переписывается,
 * а только стираются клетки, пришедшие с другого края.
 */
export class Примятость {
  readonly сила = new Float32Array(СТОРОНА_СЛЕДА * СТОРОНА_СЛЕДА);
  /** Куда примята: единичный вектор по земле. */
  readonly кудаX = new Float32Array(СТОРОНА_СЛЕДА * СТОРОНА_СЛЕДА);
  readonly кудаZ = new Float32Array(СТОРОНА_СЛЕДА * СТОРОНА_СЛЕДА);
  /** Мировой номер клетки в левом нижнем углу окна. */
  i0 = 0;
  j0 = 0;
  /** Менялось ли поле с прошлого показа: грузить в видеокарту только тогда. */
  изменилось = true;

  /**
   * `как.поКадрам: true` — заведомо сломанный вариант: распрямляться на
   * постоянную долю за кадр и мять точкой, а не отрезком. Ровно то, что
   * пишут первым, — и на быстром компьютере трава встаёт быстрее.
   */
  private readonly как: { поКадрам?: boolean };
  constructor(как: { поКадрам?: boolean } = {}) { this.как = как; }

  private ячейка(i: number, j: number): number {
    const N = СТОРОНА_СЛЕДА;
    return (((j % N) + N) % N) * N + (((i % N) + N) % N);
  }

  /** Сдвинуть окно так, чтобы (x, z) было в середине. Ушедшие клетки стираются. */
  встать(x: number, z: number): void {
    const N = СТОРОНА_СЛЕДА;
    const ni = Math.floor(x / КЛЕТКА_СЛЕДА) - N / 2, nj = Math.floor(z / КЛЕТКА_СЛЕДА) - N / 2;
    if (ni === this.i0 && nj === this.j0) return;
    // прыжок дальше окна — стираем всё
    if (Math.abs(ni - this.i0) >= N || Math.abs(nj - this.j0) >= N) {
      this.сила.fill(0);
    } else {
      // стираем столбцы и строки, которые вошли с другой стороны
      for (let i = ni; i < ni + N; i++) {
        if (i >= this.i0 && i < this.i0 + N) continue;
        for (let j = nj; j < nj + N; j++) this.сила[this.ячейка(i, j)] = 0;
      }
      for (let j = nj; j < nj + N; j++) {
        if (j >= this.j0 && j < this.j0 + N) continue;
        for (let i = ni; i < ni + N; i++) this.сила[this.ячейка(i, j)] = 0;
      }
    }
    this.i0 = ni; this.j0 = nj;
    this.изменилось = true;
  }

  /** Прошло `dt` секунд: трава поднимается. */
  жить(dt: number): void {
    if (dt <= 0) return;
    const k = this.как.поКадрам ? 0.985 : Math.exp(-dt / РАСПРЯМЛЕНИЕ);
    const с = this.сила;
    for (let n = 0; n < с.length; n++) if (с[n] > 0.002) с[n] *= k; else с[n] = 0;
    this.изменилось = true;
  }

  /**
   * Примять полосой от (ax, az) до (bx, bz) шириной 2·радиус.
   *
   * `вдоль: true` — трава ложится по ходу движения (колесо). Иначе — прочь
   * от оси полосы и немного по ходу (нога раздвигает траву, а не катит её).
   */
  примять(ax: number, az: number, bx: number, bz: number, радиус: number, вдоль: boolean): void {
    if (this.как.поКадрам) { ax = bx; az = bz; }
    const dx = bx - ax, dz = bz - az;
    const len2 = dx * dx + dz * dz;
    const len = Math.sqrt(len2);
    const хx = len > 1e-6 ? dx / len : 0, хz = len > 1e-6 ? dz / len : 0;
    const N = СТОРОНА_СЛЕДА;
    const охват = радиус + КЛЕТКА_СЛЕДА;
    const i0 = Math.max(this.i0, Math.floor((Math.min(ax, bx) - охват) / КЛЕТКА_СЛЕДА));
    const i1 = Math.min(this.i0 + N - 1, Math.floor((Math.max(ax, bx) + охват) / КЛЕТКА_СЛЕДА));
    const j0 = Math.max(this.j0, Math.floor((Math.min(az, bz) - охват) / КЛЕТКА_СЛЕДА));
    const j1 = Math.min(this.j0 + N - 1, Math.floor((Math.max(az, bz) + охват) / КЛЕТКА_СЛЕДА));
    for (let j = j0; j <= j1; j++) {
      const z = (j + 0.5) * КЛЕТКА_СЛЕДА;
      for (let i = i0; i <= i1; i++) {
        const x = (i + 0.5) * КЛЕТКА_СЛЕДА;
        // ближайшая точка оси полосы
        let t = len2 > 1e-12 ? ((x - ax) * dx + (z - az) * dz) / len2 : 0;
        t = Math.max(0, Math.min(1, t));
        const ox = x - (ax + dx * t), oz = z - (az + dz * t);
        const r = Math.hypot(ox, oz);
        /**
         * Внутри полосы примято до земли, за краем сходит на нет за одну
         * клетку. Не «от середины к краю»: шина уже клетки, и тогда сила
         * колеи зависела бы от того, как колея легла на сетку.
         */
        const с = Math.min(1, (радиус + КЛЕТКА_СЛЕДА - r) / КЛЕТКА_СЛЕДА);
        if (с <= 0) continue;
        const n = this.ячейка(i, j);
        if (с < this.сила[n]) continue;
        let кx: number, кz: number;
        if (вдоль || r < 1e-4) { кx = хx; кz = хz; } else {
          кx = ox / r + хx * 0.6; кz = oz / r + хz * 0.6;
        }
        const кl = Math.hypot(кx, кz);
        if (кl < 1e-6) continue;
        this.сила[n] = с;
        this.кудаX[n] = кx / кl;
        this.кудаZ[n] = кz / кl;
      }
    }
    this.изменилось = true;
  }

  /** Насколько примято в точке, 0..1. За окном — 0. */
  сколько(x: number, z: number): number {
    const i = Math.floor(x / КЛЕТКА_СЛЕДА), j = Math.floor(z / КЛЕТКА_СЛЕДА);
    if (i < this.i0 || j < this.j0 || i >= this.i0 + СТОРОНА_СЛЕДА || j >= this.j0 + СТОРОНА_СЛЕДА) return 0;
    return this.сила[this.ячейка(i, j)];
  }
}
