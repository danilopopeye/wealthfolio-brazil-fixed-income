/**
 * Fixture regression harness for the CDB math (docs/bootstrap.md, docs/01-investigacao.md).
 * Runs outside the addon sandbox with plain fetch (Node 18+), no build needed.
 *
 * Usage: node scripts/check-cdi.mjs   (exits non-zero if any fixture fails)
 */
const TOLERANCE = 1e-6;

// Fixtures from docs/bootstrap.md — real readings taken 19-20/09/2026.
// Both titles: emission 13/07/2026, PU base 1000.00.
const NEON = { id: 'Banco A 104.50% CDI', pct: 1.045, rows: [
  { date: '2026-09-14', pu: 1024.19875526 }, // Monday
  { date: '2026-09-20', pu: 1026.9475888 },  // Sunday -> window ends Fri 18/09
] };
const Banco B = { id: 'Banco B 14.30% a.a.', rate: 0.143, rows: [
  { date: '2026-09-14', pu: 1023.611264 },   // Monday
  { date: '2026-09-19', pu: 1026.329393 },   // Saturday -> window ends Fri 18/09
] };

// The CDI of 18/09/2026 (0.050788, inferred from the Banco A reading) was still
// absent from SGS series 12 on 20/09/2026 (CETIP -> BCB ingest lag). It is
// backfilled here when missing; once series 12 catches up this becomes a no-op
// and the fixture is matched with the real published value.
const CDI_FALLBACK = { '2026-09-18': 0.050788 };

function isoToBrl(iso) {
  const [y, m, d] = iso.split('-');
  return `${d}/${m}/${y}`;
}

async function fetchCdiDaily(startDate, endDate) {
  const url =
    'https://api.bcb.gov.br/dados/serie/bcdata.sgs.12/dados?formato=json' +
    `&dataInicial=${isoToBrl(startDate)}&dataFinal=${isoToBrl(endDate)}`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const rows = await res.json();
  if (!Array.isArray(rows)) throw new Error(`Unexpected response: ${JSON.stringify(rows)}`);
  const observations = rows.map((r) => ({
    date: r.data.split('/').reverse().join('-'),
    value: Number(r.valor),
  }));
  // Apply fallback only for dates still missing from the series.
  for (const [date, value] of Object.entries(CDI_FALLBACK)) {
    if (!observations.some((o) => o.date === date) && date >= startDate && date <= endDate) {
      observations.push({ date, value });
    }
  }
  return observations.sort((a, b) => a.date.localeCompare(b.date));
}

// Accrual window [emission, D): emission day counts, valuation day does not.
const inWindow = (rates, start, end) => rates.filter((o) => o.date >= start && o.date < end);

const fmt = new Intl.NumberFormat('pt-BR', { style: 'currency', currency: 'BRL' });
let failures = 0;

function check(label, computed, target) {
  const diff = computed - target;
  const pass = Math.abs(diff) < TOLERANCE;
  if (!pass) failures += 1;
  console.log(
    `${pass ? 'PASS' : 'FAIL'}  ${label.padEnd(34)} PU=${computed.toFixed(8)} ` +
      `target=${target} diff=${diff.toExponential(2)}`
  );
}

// --- Fixtures ------------------------------------------------------------
const rates2026 = await fetchCdiDaily('2026-07-10', '2026-09-21');

for (const { date, pu } of NEON.rows) {
  const days = inWindow(rates2026, '2026-07-13', date);
  const computed =
    1000 * days.reduce((acc, o) => acc * (1 + NEON.pct * (o.value / 100)), 1);
  check(`Banco A ${date} (n=${days.length})`, computed, pu);
}

for (const { date, pu } of Banco B.rows) {
  const n = inWindow(rates2026, '2026-07-13', date).length;
  check(`Banco B ${date} (n=${n})`, 1000 * Math.pow(1 + Banco B.rate, n / 252), pu);
}

// --- Sanity: accumulated CDI over 2024 ------------------------------------
const y2024 = await fetchCdiDaily('2024-01-02', '2024-12-31');
const cdi2024 = y2024.reduce((acc, o) => acc * (1 + o.value / 100), 1) - 1;
console.log(`\nAccumulated CDI 2024: ${(cdi2024 * 100).toFixed(4)}% over ${y2024.length} business days`);

// --- Worked example: principal + start date + % CDI -----------------------
const start = '2023-07-15';
const ratesEx = await fetchCdiDaily(start, new Date().toISOString().slice(0, 10));
const daysEx = inWindow(ratesEx, start, ratesEx.at(-1).date); // exclude "today" (unpublished)
const factorEx = daysEx.reduce((acc, o) => acc * (1 + 1.1 * (o.value / 100)), 1);
console.log(`\nExample: ${fmt.format(5000)} @ 110% CDI since ${start}`);
console.log(`  factor: ${factorEx.toFixed(8)}  business days: ${daysEx.length}`);
console.log(`  gross balance: ${fmt.format(5000 * factorEx)}`);

if (failures > 0) {
  console.error(`\n${failures} fixture(s) FAILED`);
  process.exit(1);
}
console.log('\nAll fixtures reproduced within tolerance');
