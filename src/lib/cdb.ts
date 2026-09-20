/**
 * Financial math for post-fixed (CDI-indexed) and pre-fixed CDBs.
 *
 * FROZEN REFERENCE — this addon code is NOT the production path (see
 * docs/bootstrap.md: the plan is a stateless Go API behind a Wealthfolio
 * Custom Market Data Provider). These functions are kept as an executable,
 * fixture-validated reference for the Go port. The regression harness lives
 * in scripts/check-cdi.mjs.
 *
 * Conventions validated against real readings (docs/01-investigacao.md):
 * - Accrual window is [startDate, endDate): the emission day counts, the
 *   valuation day does not. All four fixture PUs (Banco B/Banco A) reproduce with
 *   error < 1e-6.
 * - Weekend/holiday valuation dates need no special casing: with a weekend
 *   endDate the window ends at the previous business day, so PU(Sat/Sun)
 *   naturally equals the PU of the next business day.
 * - The daily CDI (SGS series 12) is already the effective daily rate in
 *   percentage points: daily factor = 1 + (cdiPercent/100) * (value/100).
 *   The (1 + CDI_aa)^(1/252) - 1 form is equivalent: series 12 publishes
 *   that daily factor directly, rounded to 8 decimals.
 */
import type { SgsObservation } from './sgs';

/** Business-day observations covering the period (e.g. SGS series 12). */
export interface AccrualWindow {
  /** Deposit/emission date (YYYY-MM-DD). Counts as the first accrual day. */
  startDate: string;
  /** Valuation date (YYYY-MM-DD). Does NOT accrue. */
  endDate?: string;
  /** Business-day observations (any superset of the window works). */
  dailyRates: SgsObservation[];
}

export interface CdbCalculationInput extends AccrualWindow {
  /** Base amount in BRL (principal / PU at emission). */
  principal: number;
  /** Contracted percentage of the CDI (e.g. 104.5 for 104.50% of CDI). */
  cdiPercent: number;
}

export interface PreFixedCdbInput extends AccrualWindow {
  /** Base amount in BRL (principal / PU at emission). */
  principal: number;
  /** Contracted annual rate in % (e.g. 14.3 for 14.30% a.a.), base 252. */
  annualRate: number;
}

export interface CdbCalculationResult {
  /** Gross updated balance in BRL. */
  grossBalance: number;
  /** Accumulated profitability factor (1.0 = no yield). */
  factor: number;
  /** Accrued interest in BRL. */
  accruedInterest: number;
  /** Number of business days in [startDate, endDate). */
  businessDays: number;
  /** Total gross return in % (e.g. 8.42 means +8.42%). */
  grossReturnPct: number;
  /** Annualized gross return in % (252 business-day year). */
  annualizedReturnPct: number;
}

function todayIso(): string {
  const now = new Date();
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
}

/** Observations in [startDate, endDate) — emission counts, valuation day does not. */
function filterWindow(
  dailyRates: SgsObservation[],
  startDate: string,
  endDate: string
): SgsObservation[] {
  return dailyRates.filter((obs) => obs.date >= startDate && obs.date < endDate);
}

function buildResult(principal: number, factor: number, businessDays: number): CdbCalculationResult {
  const grossBalance = principal * factor;
  return {
    grossBalance,
    factor,
    accruedInterest: grossBalance - principal,
    businessDays,
    grossReturnPct: (factor - 1) * 100,
    annualizedReturnPct:
      businessDays > 0 ? (Math.pow(factor, 252 / businessDays) - 1) * 100 : 0,
  };
}

function validateWindow(startDate: string, endDate: string): void {
  if (endDate < startDate) {
    throw new Error('endDate must not be before startDate');
  }
}

/**
 * Post-fixed CDB indexed to the CDI.
 *
 * Gross balance = principal * product of (1 + cdiPercent/100 * cdi/100)
 * over each business day in [startDate, endDate).
 */
export function calculateCdb(input: CdbCalculationInput): CdbCalculationResult {
  const { principal, cdiPercent, startDate, endDate = todayIso(), dailyRates } = input;

  if (!(principal > 0)) {
    throw new Error('principal must be greater than zero');
  }
  if (!(cdiPercent > 0)) {
    throw new Error('cdiPercent must be greater than zero');
  }
  validateWindow(startDate, endDate);

  const applicable = filterWindow(dailyRates, startDate, endDate);
  const factor = applicable.reduce(
    (acc, obs) => acc * (1 + (cdiPercent / 100) * (obs.value / 100)),
    1
  );

  return buildResult(principal, factor, applicable.length);
}

/**
 * Pre-fixed CDB.
 *
 * Gross balance = principal * (1 + annualRate/100)^(n/252), where n is the
 * number of business days in [startDate, endDate). The business-day calendar
 * is derived from the dates present in dailyRates (SGS series 12 skips
 * weekends and holidays).
 */
export function calculatePreFixedCdb(input: PreFixedCdbInput): CdbCalculationResult {
  const { principal, annualRate, startDate, endDate = todayIso(), dailyRates } = input;

  if (!(principal > 0)) {
    throw new Error('principal must be greater than zero');
  }
  if (!(annualRate > 0)) {
    throw new Error('annualRate must be greater than zero');
  }
  validateWindow(startDate, endDate);

  const businessDays = filterWindow(dailyRates, startDate, endDate).length;
  const factor = Math.pow(1 + annualRate / 100, businessDays / 252);

  return buildResult(principal, factor, businessDays);
}
