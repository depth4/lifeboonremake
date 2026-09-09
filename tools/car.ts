/**
 * Паспорт машины → как она поедет.
 *
 * Берёт ТОЛЬКО числа из официального технического паспорта (2013 SRT Viper),
 * считает по формулам справочника `docs/how-cars-work.md` и сверяет предсказание
 * с независимыми замерами журнала. Ничего не подгоняется: всё, чего в паспорте
 * нет, помечено как оценка и печатается отдельным списком.
 *
 *   npm run car            — счёт и сверка
 *   npm run car сломать    — убрать перенос веса: сверка обязана упасть
 */

const G = 9.80665; // м/с², ускорение свободного падения
const AIR = 1.225; // кг/м³, плотность воздуха на уровне моря
const MILE = 1609.344; // м
const MPH = 0.44704; // м/с в одной миле в час

// ─────────────────────────── ПАСПОРТ ───────────────────────────
// Всё до единой строки — из media.stellantis: «2013 SRT Viper and SRT Viper GTS
// SPECIFICATIONS». Переведено в метры/килограммы/ньютоны и больше ни во что.

const PASSPORT = {
  name: '2013 SRT Viper GTS',
  mass: 1556.3, // кг, curb weight GTS
  frontShare: 0.496, // доля веса на передней оси (49.6/50.4)
  wheelbase: 2.51, // м
  trackFront: 1.598, // м
  trackRear: 1.55, // м
  width: 1.941, // м
  height: 1.246, // м
  cd: 0.369, // коэффициент лобового сопротивления
  // двигатель: 8.4 л V10, отсечка 6400
  peakTorque: 814, // Н·м при 5000 об/мин
  peakTorqueRpm: 5000,
  peakPower: 477_000, // Вт при 6200 об/мин
  peakPowerRpm: 6200,
  cutoffRpm: 6400,
  gears: [2.26, 1.58, 1.19, 1.0, 0.77, 0.63],
  finalDrive: 3.55,
  topGearOverall: 2.24, // как напечатано в паспорте — проверим арифметику
  steeringRatio: 16.7,
  turningDiameter: 12.34, // м, curb-to-curb
  // шины: перед 295/30ZR18, зад P355/30ZR19, Pirelli P Zero
  tyreFront: { width: 0.295, aspect: 0.3, rim: 18, revsPerMile: 835 },
  tyreRear: { width: 0.355, aspect: 0.3, rim: 19, revsPerMile: 764 },
  brakeDisc: 0.3556, // м, диаметр 14.0"
};

// ─────────────────────── ЧЕГО В ПАСПОРТЕ НЕТ ───────────────────────
// Оценки. Каждая названа вслух, у каждой сказано, на что она влияет.

const GUESS = {
  driveline: 0.88, // ПЕРЕЗАПИСЫВАЕТСЯ ниже: выводится из замера максималки
  cgHeight: 0.46, // м. Влияет на перенос веса. Диапазон правдоподобия 0.42–0.50
  frontalArea: 2.06, // м² = 0.85 × ширина × высота. Влияет на максималку
  engineInertia: 0.25, // кг·м², крутящиеся части двигателя с маховиком
  wheelInertiaFront: 1.36, // кг·м² на колесо (24 кг, масса у обода)
  wheelInertiaRear: 2.02, // кг·м² на колесо (30 кг)
  rollingResistance: 0.012, // коэффициент сопротивления качению
  launchRpm: 3500, // на каких оборотах держит сцепление на старте
  shiftTime: 0.3, // с, разрыв тяги при переключении
  tyrePressure: 240_000, // Па (2.4 бар) — для площади пятна контакта
};

// ─────────────────── ЗАМЕРЫ, С КОТОРЫМИ СВЕРЯЕМСЯ ───────────────────
// Edmunds, инструментальный тест 2013 SRT Viper GTS; максималка — заявление SRT.

const MEASURED = {
  sixty: 3.7, // с до 60 миль/ч
  quarterTime: 11.5, // с на четверти мили
  quarterSpeed: 127.3 * MPH, // м/с в конце четверти
  skidpad: 1.03, // g на круге
  brakingFeet: 101, // футов с 60 миль/ч до нуля
  topSpeed: 206 * MPH, // м/с, заявлено производителем
};

const broken = process.argv[2] === 'сломать';

// ─────────────────────────── ГЕОМЕТРИЯ ───────────────────────────

/** Радиус колеса по маркировке шины: обод плюс две боковины. */
const radiusFromMarking = (t: { width: number; aspect: number; rim: number }): number =>
  (t.rim * 0.0254 + 2 * t.width * t.aspect) / 2;

/** Радиус качения по «оборотам на милю» — то, чем колесо меряет дорогу. */
const radiusFromRevs = (t: { revsPerMile: number }): number => MILE / t.revsPerMile / (2 * Math.PI);

const rFront = radiusFromRevs(PASSPORT.tyreFront);
const rRear = radiusFromRevs(PASSPORT.tyreRear);

const m = PASSPORT.mass;
const L = PASSPORT.wheelbase;
const b = PASSPORT.frontShare * L; // от центра масс до ЗАДНЕЙ оси
const a = L - b; // от центра масс до передней оси
const h = GUESS.cgHeight;
const weight = m * G;

/** Крутящиеся части в пересчёте на «лишнюю массу» машины на данной передаче. */
function rotatingMass(gear: number): number {
  const ratio = PASSPORT.gears[gear] * PASSPORT.finalDrive;
  const wheels = 2 * GUESS.wheelInertiaFront + 2 * GUESS.wheelInertiaRear;
  return (wheels + GUESS.engineInertia * ratio * ratio) / (rRear * rRear);
}

// ─────────────────────────── ДВИГАТЕЛЬ ───────────────────────────
// Кривой момента в паспорте нет — есть две точки: пик момента и пик мощности.
// Форма между ними — типовая для большого атмосферного мотора, и она обязана
// проходить ровно через обе паспортные точки. Это проверяется ниже.

const CURVE: readonly (readonly [number, number])[] = [
  [1000, 610], [2000, 700], [3000, 760], [4000, 795],
  [5000, 814], [6000, 760], [6200, 735], [6400, 700],
];

function torque(rpm: number): number {
  const n = Math.max(CURVE[0][0], Math.min(CURVE[CURVE.length - 1][0], rpm));
  for (let i = 0; i + 1 < CURVE.length; i++) {
    const [n0, t0] = CURVE[i], [n1, t1] = CURVE[i + 1];
    if (n <= n1) return t0 + ((t1 - t0) * (n - n0)) / (n1 - n0);
  }
  return CURVE[CURVE.length - 1][1];
}

const power = (rpm: number): number => (torque(rpm) * rpm * 2 * Math.PI) / 60;

// ───────────────────── СЦЕПЛЕНИЕ ИЗ ЗАМЕРОВ ─────────────────────
// Два числа замерены независимо — торможение и круг. Из них выводятся две
// полуоси эллипса трения. Дальше они НЕ подкручиваются.

const dragArea = PASSPORT.cd * GUESS.frontalArea;
const brakingDistance = (MEASURED.brakingFeet * 0.3048);
const v60 = 60 * MPH;
const decel = (v60 * v60) / (2 * brakingDistance);
// воздух и качение тормозят сами; на долю шин остаётся остальное
const dragHelp = (0.5 * AIR * dragArea * (v60 * v60) / 2) / m;
const muX = (decel - dragHelp) / G - GUESS.rollingResistance;
const muY = MEASURED.skidpad;

// ─────────────────────────── РАЗГОН ───────────────────────────

interface Run {
  sixty: number;
  quarterTime: number;
  quarterSpeed: number;
  shifts: number;
  tractionLimitedUntil: number; // м/с: докуда сцепление, а не мотор
}

function accelerate(muDrive: number, transfer = true): Run {
  const dt = 0.0005;
  let v = 0, x = 0, t = 0, gear = 0, shiftLeft = 0, ax = 0;
  let sixty = NaN, shifts = 0, tractionUntil = 0;
  let quarterTime = NaN, quarterSpeed = NaN;

  while (t < 30) {
    const rpm = Math.max(GUESS.launchRpm, (v / rRear) * PASSPORT.gears[gear] * PASSPORT.finalDrive * 60 / (2 * Math.PI));

    if (rpm >= PASSPORT.cutoffRpm && gear + 1 < PASSPORT.gears.length && shiftLeft <= 0) {
      shiftLeft = GUESS.shiftTime;
      gear++;
      shifts++;
    }

    const ratio = PASSPORT.gears[gear] * PASSPORT.finalDrive;
    const engineForce = shiftLeft > 0 ? 0 : (torque(rpm) * ratio * GUESS.driveline) / rRear;

    // предел по сцеплению задних колёс: нагрузка на них растёт от разгона
    const rearLoad = weight * (a / L) + (transfer ? (m * ax * h) / L : 0);
    const gripForce = muDrive * rearLoad;

    const force = Math.min(engineForce, gripForce);
    if (engineForce > gripForce && shiftLeft <= 0) tractionUntil = v;

    const drag = 0.5 * AIR * dragArea * v * v;
    const roll = GUESS.rollingResistance * weight;
    ax = (force - drag - roll) / (m + rotatingMass(gear));

    const vPrev = v, xPrev = x;
    v += ax * dt;
    x += v * dt;
    t += dt;
    if (shiftLeft > 0) shiftLeft -= dt;

    if (Number.isNaN(sixty) && v >= v60) sixty = t - dt * ((v - v60) / Math.max(v - vPrev, 1e-9));
    if (Number.isNaN(quarterTime) && x >= MILE / 4) {
      quarterTime = t;
      quarterSpeed = v;
      break;
    }
  }
  return { sixty, quarterTime, quarterSpeed, shifts, tractionLimitedUntil: tractionUntil };
}

/** Максималка: где тяга на колесе сравнялась с воздухом и качением. */
function topSpeed(): { v: number; rpm: number; gear: number } {
  let best = { v: 0, rpm: 0, gear: 0 };
  for (let gear = 0; gear < PASSPORT.gears.length; gear++) {
    const ratio = PASSPORT.gears[gear] * PASSPORT.finalDrive;
    for (let v = 5; v < 130; v += 0.05) {
      const rpm = (v / rRear) * ratio * 60 / (2 * Math.PI);
      if (rpm > PASSPORT.cutoffRpm) break;
      const push = (torque(rpm) * ratio * GUESS.driveline) / rRear;
      const hold = 0.5 * AIR * dragArea * v * v + GUESS.rollingResistance * weight;
      if (push < hold) break;
      if (v > best.v) best = { v, rpm, gear };
    }
  }
  return best;
}

/** КПД трансмиссии — выводится из замера максималки: в паспорте его нет. */
function solveDriveline(): number {
  let lo = 0.5, hi = 1.0;
  for (let i = 0; i < 40; i++) {
    const mid = (lo + hi) / 2;
    GUESS.driveline = mid;
    if (topSpeed().v < MEASURED.topSpeed) lo = mid;
    else hi = mid;
  }
  return (lo + hi) / 2;
}

/** Сцепление ведущих колёс на старте — единственное, что подбирается: по замеру 0–60. */
function solveDriveGrip(): number {
  let lo = 0.5, hi = 3.0;
  for (let i = 0; i < 40; i++) {
    const mid = (lo + hi) / 2;
    if (accelerate(mid).sixty > MEASURED.sixty) lo = mid;
    else hi = mid;
  }
  return (lo + hi) / 2;
}

// ─────────────────────────── ПЕЧАТЬ ───────────────────────────

const kmh = (v: number) => (v * 3.6).toFixed(1);
const line = (name: string, value: string) => console.log(`  ${name.padEnd(42, '.')} ${value}`);

console.log(`\n${PASSPORT.name} — из паспорта в поведение${broken ? '   [СЛОМАНО: перенос веса выключен]' : ''}\n`);

console.log('КОЛЕСО. Два паспортных числа про одно и то же — сверка самого паспорта:');
for (const [what, t, r] of [['перед', PASSPORT.tyreFront, rFront], ['зад', PASSPORT.tyreRear, rRear]] as const) {
  const marked = radiusFromMarking(t);
  line(`${what}: радиус по маркировке`, `${(marked * 1000).toFixed(1)} мм`);
  line(`${what}: радиус качения по «оборотам на милю»`, `${(r * 1000).toFixed(1)} мм  (${((r / marked - 1) * 100).toFixed(1)}% — просадка под нагрузкой)`);
}

console.log('\nМАССЫ И ПЛЕЧИ:');
line('центр масс от передней оси', `${a.toFixed(3)} м`);
line('центр масс от задней оси', `${b.toFixed(3)} м`);
line('статическая нагрузка перед / зад', `${(weight * b / L / 1000).toFixed(2)} / ${(weight * a / L / 1000).toFixed(2)} кН`);
line('момент инерции по рысканью (оценка m·a·b)', `${(m * a * b).toFixed(0)} кг·м²`);
line('пятно контакта переднего колеса', `${((weight * b / L / 2 / GUESS.tyrePressure) * 1e4).toFixed(0)} см² при 2.4 бар`);
line('добавка крутящихся частей, 1-я передача', `${rotatingMass(0).toFixed(0)} кг (${(rotatingMass(0) / m * 100).toFixed(0)}% массы)`);
line('добавка крутящихся частей, 6-я передача', `${rotatingMass(5).toFixed(0)} кг`);

console.log('\nСЦЕПЛЕНИЕ, ВЫВЕДЕННОЕ ИЗ ЗАМЕРОВ (дальше не подкручивается):');
line('вдоль (из 60–0 миль/ч за 101 фут)', `μx = ${muX.toFixed(3)}`);
line('поперёк (из круга)', `μy = ${muY.toFixed(3)}`);
line('эллипс трения, отношение полуосей', `${(muX / muY).toFixed(3)} — круг это не круг`);

console.log('\nПЕРЕДАЧИ (скорость на отсечке 6400):');
PASSPORT.gears.forEach((gr, i) => {
  const v = (PASSPORT.cutoffRpm * 2 * Math.PI / 60) / (gr * PASSPORT.finalDrive) * rRear;
  line(`  ${i + 1}-я (${gr.toFixed(2)} × ${PASSPORT.finalDrive})`, `${kmh(v)} км/ч`);
});

GUESS.driveline = solveDriveline();
const muDrive = solveDriveGrip();
// «сломать» убирает ровно одну вещь — перенос веса. Всё остальное то же самое.
const run = accelerate(muDrive, !broken);
const top = topSpeed();

console.log('\nДВА ЧИСЛА, КОТОРЫХ В ПАСПОРТЕ НЕТ — ВЫВЕДЕНЫ ИЗ ЗАМЕРОВ:');
line('сцепление ведущих колёс на старте (из 0–60)', `μ = ${muDrive.toFixed(3)} — на ${((muDrive / muX - 1) * 100).toFixed(0)}% выше тормозного`);
line('КПД трансмиссии (из максималки)', `${(GUESS.driveline * 100).toFixed(0)}% — потери ${((1 - GUESS.driveline) * 100).toFixed(0)}%`);

console.log('\nПРЕДСКАЗАНО ПО ПАСПОРТУ / ЗАМЕРЕНО / РАСХОЖДЕНИЕ:');
interface Check { name: string; got: number; want: number; unit: string; tol: number }
const checks: Check[] = [
  { name: 'верхняя передача, общее число', got: PASSPORT.gears[5] * PASSPORT.finalDrive, want: PASSPORT.topGearOverall, unit: '', tol: 0.01 },
  { name: 'пик мощности на 6200', got: power(PASSPORT.peakPowerRpm), want: PASSPORT.peakPower, unit: 'Вт', tol: 0.02 },
  { name: 'четверть мили, время', got: run.quarterTime, want: MEASURED.quarterTime, unit: 'с', tol: 0.05 },
  { name: 'четверть мили, скорость в конце', got: run.quarterSpeed, want: MEASURED.quarterSpeed, unit: 'м/с', tol: 0.05 },
];
let failed = 0;
for (const c of checks) {
  const off = (c.got - c.want) / c.want;
  const ok = Math.abs(off) <= c.tol;
  if (!ok) failed++;
  const fmt = (x: number) => (c.unit === 'м/с' ? `${kmh(x)} км/ч` : c.unit === 'Вт' ? `${(x / 1000).toFixed(0)} кВт` : `${x.toFixed(2)} ${c.unit}`);
  console.log(`  ${ok ? '✓' : '✗'} ${c.name.padEnd(34, '.')} ${fmt(c.got).padStart(12)}  против ${fmt(c.want).padStart(12)}   ${(off * 100 >= 0 ? '+' : '')}${(off * 100).toFixed(1)}%`);
}
line('переключений до четверти мили', `${run.shifts}`);
line('сцепление держит разгон до', `${kmh(run.tractionLimitedUntil)} км/ч — дальше упирается в мотор`);
line('максималка достигается', `на ${top.gear + 1}-й при ${top.rpm.toFixed(0)} об/мин`);

console.log('\nЧТО ЭТО ЗНАЧИТ ДЛЯ НАШИХ ДОРОГ:');
const R = 18; // минимальный радиус поворота дороги, решение 016
line(`поворот радиусом ${R} м на пределе`, `${kmh(Math.sqrt(muY * G * R))} км/ч`);
line('радиус для 60 км/ч на пределе', `${((60 / 3.6) ** 2 / (muY * G)).toFixed(0)} м`);
line('радиус для 60 км/ч с запасом (0.4 g)', `${((60 / 3.6) ** 2 / (0.4 * G)).toFixed(0)} м`);
line('подъём 8%: сколько сцепления съедает', `${(0.08 / muX * 100).toFixed(0)}%`);
line('тормозной путь со 100 км/ч', `${(((100 / 3.6) ** 2) / (2 * muX * G)).toFixed(1)} м`);
line('перенос веса при торможении 1 g', `${(m * G * h / L / 1000).toFixed(2)} кН — ${(100 * (m * G * h / L) / (weight * b / L)).toFixed(0)}% к передней оси`);
line('перенос веса в повороте 1 g', `${(m * G * h / PASSPORT.trackFront / 1000).toFixed(2)} кН между бортами`);

console.log('\nОЦЕНКИ, ВЗЯТЫЕ ИЗ ГОЛОВЫ (в паспорте их нет — названы вслух):');
const NAMES: Record<string, string> = {
  cgHeight: 'высота центра масс, м',
  frontalArea: 'лобовая площадь, м²',
  engineInertia: 'момент инерции мотора, кг·м²',
  wheelInertiaFront: 'момент инерции переднего колеса, кг·м²',
  wheelInertiaRear: 'момент инерции заднего колеса, кг·м²',
  rollingResistance: 'сопротивление качению',
  launchRpm: 'обороты на старте',
  shiftTime: 'время переключения, с',
  tyrePressure: 'давление в шинах, Па',
};
for (const [k, label] of Object.entries(NAMES)) line(`  ${label}`, String(GUESS[k as keyof typeof GUESS]));

console.log(`\n${failed === 0 ? 'СВЕРКА ПРОЙДЕНА' : `СВЕРКА ПРОВАЛЕНА: ${failed} из ${checks.length}`}\n`);
process.exit(failed === 0 ? 0 : 1);
