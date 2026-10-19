/**
 * PU engine — TypeScript port of api/engine.go (fixture-validated against
 * the four real readings in docs/bootstrap.md). Runs entirely inside the
 * addon: the CDI series comes from api.bcb.gov.br via the host network
 * broker (localhost/private hosts are blocked for addons by design).
 *
 * Conventions (docs/01-investigacao.md):
 * - Accrual window [emission, D): emission day counts, D does not.
 * - PU(Sat/Sun) = PU of the next business day (falls out of the window).
 * - Trailing missing rates (CETIP->SGS lag): carry-forward up to K days.
 */
import { businessDaysBetween, firstBusinessDayOnOrAfter, nextBusinessDay, prevBusinessDay } from './calendar';

export type SymbolKind = 'CDI' | 'PRE';

export interface TitleSpec {
  kind: SymbolKind;
  /** Contracted rate: 104.5 for 104.50% of CDI, or 14.3 for 14.30% a.a. */
  ratePct: number;
  /** Emission date (YYYY-MM-DD). */
  emission: string;
}

export interface PUResult {
  price: number;
  /** Trailing business days lacking a confirmed rate (carry-forward used). */
  estimatedDays: number;
}

export const CARRY_FORWARD_MAX = 3;

/** Daily CDI rates keyed by ISO date, in % per business day (e.g. 0.050788). */
export type RateMap = Map<string, number>;

export function postFixedPU(spec: TitleSpec, d: string, rates: RateMap, carryMax = CARRY_FORWARD_MAX): PUResult {
  // Empty accrual window (valuation at/before emission): PU is the 1000
  // emission base and no CDI rates are needed — a title bought today with
  // D+1 settlement is valued at par before it starts accruing.
  if (d <= spec.emission) return { price: 1000, estimatedDays: 0 };

  const lastDate = [...rates.keys()].sort().pop() as string | undefined;
  if (lastDate === undefined) throw new Error('CDI rates unavailable');

  let factor = 1;
  for (let day = firstBusinessDayOnOrAfter(spec.emission); day < d; day = nextBusinessDay(day)) {
    const v = rates.get(day);
    if (v === undefined) {
      if (day > lastDate) continue; // trailing gap, handled below
      throw new Error(`CDI rate missing for ${day}`);
    }
    factor *= 1 + (spec.ratePct / 100) * (v / 100);
  }

  const gapFrom = [spec.emission, nextBusinessDay(lastDate)].sort().pop()!;
  const gap = businessDaysBetween(gapFrom, d);
  if (gap > 0 && gap <= carryMax) {
    factor *= Math.pow(1 + (spec.ratePct / 100) * (rates.get(lastDate)! / 100), gap);
  }
  return { price: 1000 * factor, estimatedDays: gap };
}

export function preFixedPU(spec: TitleSpec, d: string): PUResult {
  const n = businessDaysBetween(spec.emission, d);
  return { price: 1000 * Math.pow(1 + spec.ratePct / 100, n / 252), estimatedDays: 0 };
}

export function unitPrice(spec: TitleSpec, d: string, rates: RateMap): PUResult {
  return spec.kind === 'PRE' ? preFixedPU(spec, d) : postFixedPU(spec, d, rates);
}

export interface EmissionSolve {
  emission: string;
  pu: number;
  diff: number;
}

/**
 * Reverse-engineers the emission date from a known purchase PU (banks show
 * the PU paid or the quantity of titles, rarely the emission date). PU is
 * monotone in the emission, so it can be inverted against the series.
 */
export function solveEmission(
  kind: SymbolKind,
  ratePct: number,
  targetPU: number,
  settlement: string,
  rates: RateMap
): EmissionSolve {
  if (!(targetPU >= 1000)) throw new Error('target PU is below the 1000.00 emission base');

  if (kind === 'PRE') {
    const nStar = (252 * Math.log(targetPU / 1000)) / Math.log(1 + ratePct / 100);
    const n = Math.max(0, Math.round(nStar));
    let em = settlement;
    for (let i = 0; i < n; i++) em = prevBusinessDay(em);
    const pu = 1000 * Math.pow(1 + ratePct / 100, n / 252);
    return { emission: em, pu, diff: pu - targetPU };
  }

  let em = settlement;
  let factor = 1;
  let best: EmissionSolve = { emission: em, pu: 1000, diff: 1000 - targetPU };
  for (let i = 0; i < 4000; i++) {
    const next = prevBusinessDay(em);
    const v = rates.get(next);
    if (v === undefined) {
      if (best.pu <= 1000) throw new Error('CDI rates unavailable');
      break; // ran out of series; return best found
    }
    factor *= 1 + (ratePct / 100) * (v / 100);
    em = next;
    const pu = 1000 * factor;
    const diff = pu - targetPU;
    if (Math.abs(diff) < Math.abs(best.diff)) best = { emission: em, pu, diff };
    if (pu >= targetPU) break;
  }
  return best;
}

/** Builds the parametrized symbol, e.g. CDI-104.50-20260713 / PRE-14.30-20260713. */
export function buildSymbol(spec: TitleSpec): string {
  return `${spec.kind}-${spec.ratePct.toFixed(2)}-${spec.emission.split('-').join('')}`;
}
