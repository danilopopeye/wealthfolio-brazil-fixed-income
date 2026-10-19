/**
 * Fixture regression for the TypeScript PU engine (same acceptance criteria
 * as scripts/check-cdi.mjs and the Go tests): the four real readings from
 * docs/bootstrap.md plus the emission-solver inversion.
 *
 * Usage: pnpm exec tsx scripts/check-engine.ts
 */
import { businessDaysBetween, prevBusinessDay } from '../src/lib/calendar';
import { postFixedPU, preFixedPU, solveEmission, buildSymbol, type RateMap } from '../src/lib/engine';
import { parseDecimal } from '../src/lib/decimal';

const TOL = 1e-6;

const FIXTURE_RATES_2026 = `2026-07-13 0.052531
2026-07-14 0.052531
2026-07-15 0.052531
2026-07-16 0.052531
2026-07-17 0.052531
2026-07-20 0.052531
2026-07-21 0.052531
2026-07-22 0.052531
2026-07-23 0.052531
2026-07-24 0.052531
2026-07-27 0.052531
2026-07-28 0.052531
2026-07-29 0.052531
2026-07-30 0.052531
2026-07-31 0.052531
2026-08-03 0.052531
2026-08-04 0.052531
2026-08-05 0.052531
2026-08-06 0.051660
2026-08-07 0.051660
2026-08-10 0.051660
2026-08-11 0.051660
2026-08-12 0.051660
2026-08-13 0.051660
2026-08-14 0.051660
2026-08-17 0.051660
2026-08-18 0.051660
2026-08-19 0.051660
2026-08-20 0.051660
2026-08-21 0.051660
2026-08-24 0.051660
2026-08-25 0.051660
2026-08-26 0.051660
2026-08-27 0.051660
2026-08-28 0.051660
2026-08-31 0.051660
2026-09-01 0.051660
2026-09-02 0.051660
2026-09-03 0.051660
2026-09-04 0.051660
2026-09-08 0.051660
2026-09-09 0.051660
2026-09-10 0.051660
2026-09-11 0.051660
2026-09-14 0.051660
2026-09-15 0.051660
2026-09-16 0.051660
2026-09-17 0.050788
2026-09-18 0.050788`;

function rates(includeSep18: boolean): RateMap {
  const map: RateMap = new Map();
  for (const line of FIXTURE_RATES_2026.split('\n')) {
    if (!includeSep18 && line.startsWith('2026-09-18')) continue;
    const [date, value] = line.split(' ');
    map.set(date, Number(value));
  }
  return map;
}

let failures = 0;

function check(label: string, got: number, want: number): void {
  const diff = got - want;
  const pass = Math.abs(diff) < TOL;
  if (!pass) failures++;
  console.log(
    `${pass ? 'PASS' : 'FAIL'}  ${label.padEnd(36)} got=${got.toFixed(8)} want=${want} diff=${diff.toExponential(2)}`
  );
}

// Calendar sanity: the empirically corrected carnaval + holiday rules.
if (businessDaysBetween('2026-07-13', '2026-09-14') !== 44) {
  failures++;
  console.log('FAIL  calendar n(13/07 -> 14/09) != 44');
} else {
  console.log('PASS  calendar n(13/07 -> 14/09) = 44');
}
if (prevBusinessDay('2026-09-14') !== '2026-09-11') {
  failures++;
  console.log('FAIL  prevBusinessDay(14/09) != 11/09 (07/09 holiday)');
}

// The four fixtures.
const neon = { kind: 'CDI' as const, ratePct: 104.5, emission: '2026-07-13' };
const xp = { kind: 'PRE' as const, ratePct: 14.3, emission: '2026-07-13' };

check('Banco A PU 2026-09-14', postFixedPU(neon, '2026-09-14', rates(true)).price, 1024.19875526);
check('Banco A PU 2026-09-20', postFixedPU(neon, '2026-09-20', rates(true)).price, 1026.9475888);
const carried = postFixedPU(neon, '2026-09-20', rates(false));
check('Banco A PU 2026-09-20 (carry)', carried.price, 1026.9475888);
if (carried.estimatedDays !== 1) {
  failures++;
  console.log('FAIL  carry estimatedDays != 1');
}
check('Banco B PU 2026-09-14', preFixedPU(xp, '2026-09-14').price, 1023.611264);
check('Banco B PU 2026-09-19', preFixedPU(xp, '2026-09-19').price, 1026.329393);

// Valuation at/before emission with an EMPTY rate map: a title bought today
// (D+1 emission in the future) has an empty accrual window, so PU is the
// 1000 emission base and no CDI rates are required.
for (const [label, d] of [['before emission', '2026-07-12'], ['at emission', '2026-07-13']] as const) {
  try {
    const pu = postFixedPU(neon, d, new Map());
    check(`PU ${label} (no rates)`, pu.price, 1000);
    if (pu.estimatedDays !== 0) {
      failures++;
      console.log(`FAIL  PU ${label} (no rates): estimatedDays ${pu.estimatedDays} != 0`);
    }
  } catch (e) {
    failures++;
    console.log(`FAIL  PU ${label} (no rates): threw ${(e as Error).message}`);
  }
}

// Solver inversion (8 and 2 decimal inputs).
const solved8 = solveEmission('CDI', 104.5, 1024.19875526, '2026-09-14', rates(true));
const solved2 = solveEmission('CDI', 104.5, 1024.2, '2026-09-14', rates(true));
const solvedPre = solveEmission('PRE', 14.3, 1023.61, '2026-09-14', rates(true));
for (const [label, s] of [['solver CDI 8 dec', solved8], ['solver CDI 2 dec', solved2], ['solver PRE', solvedPre]] as const) {
  if (s.emission !== '2026-07-13') {
    failures++;
    console.log(`FAIL  ${label}: emission ${s.emission} != 2026-07-13`);
  } else {
    console.log(`PASS  ${label}: emission 2026-07-13 (diff ${s.diff.toExponential(2)})`);
  }
}

// Symbol grammar.
const sym = buildSymbol(neon);
if (sym !== 'CDI-104.50-20260713') {
  failures++;
  console.log(`FAIL  buildSymbol -> ${sym}`);
} else {
  console.log('PASS  buildSymbol -> CDI-104.50-20260713');
}

// Locale-tolerant decimal parsing (user-typed values with , or .).
{
  const cases: [string, number][] = [
    ['104,5', 104.5],
    ['1.045,32', 1045.32],
    ['1,045.32', 1045.32],
    ['104.5', 104.5],
    ['5000', 5000],
    [' 1 023,61 ', 1023.61],
  ];
  for (const [raw, want] of cases) {
    check(`parseDecimal(${JSON.stringify(raw)})`, parseDecimal(raw), want);
  }
  for (const bad of ['', '  ', 'abc']) {
    if (!Number.isNaN(parseDecimal(bad))) {
      failures++;
      console.log(`FAIL  parseDecimal(${JSON.stringify(bad)}) should be NaN`);
    } else {
      console.log(`PASS  parseDecimal(${JSON.stringify(bad)}) = NaN`);
    }
  }
}

if (failures > 0) {
  console.error(`\n${failures} check(s) FAILED`);
  process.exit(1);
}
console.log('\nAll engine fixtures reproduced within tolerance');
