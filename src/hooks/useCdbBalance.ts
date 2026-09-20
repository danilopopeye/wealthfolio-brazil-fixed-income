/**
 * React Query hooks for CDI-indexed CDB valuation.
 */
import { useQuery, type UseQueryResult } from '@tanstack/react-query';
import type { AddonContext } from '@wealthfolio/addon-sdk';
import { fetchCdiDailyRates, type SgsObservation } from '../lib/sgs';
import { calculateCdb, type CdbCalculationResult } from '../lib/cdb';

export interface CdbBalanceParams {
  /** Invested amount in BRL. */
  principal: number;
  /** Deposit date (YYYY-MM-DD). */
  startDate: string;
  /** Contracted rate as a percentage of the CDI (e.g. 110 for 110%). */
  cdiPercent: number;
  /** Valuation date (YYYY-MM-DD). Defaults to today when omitted. */
  endDate?: string;
}

/** The CDI is published once per business day, so a 6h cache is plenty. */
const STALE_TIME_MS = 6 * 60 * 60 * 1000;

/** Fetches daily CDI observations for a period via the host network broker. */
export function useCdiDailyRates(
  ctx: AddonContext,
  params: { startDate: string; endDate: string }
): UseQueryResult<SgsObservation[], Error> {
  return useQuery({
    queryKey: ['cdb', 'cdi-daily', params.startDate, params.endDate],
    queryFn: () => fetchCdiDailyRates(ctx.api.network, params.startDate, params.endDate),
    staleTime: STALE_TIME_MS,
  });
}

/**
 * Computes the gross balance of a CDB position: fetches the CDI daily rates
 * from the BCB SGS API and compounds them over the principal.
 */
export function useCdbBalance(
  ctx: AddonContext,
  params: CdbBalanceParams
): UseQueryResult<CdbCalculationResult, Error> {
  const { principal, startDate, cdiPercent, endDate } = params;

  return useQuery({
    queryKey: ['cdb', 'balance', principal, startDate, cdiPercent, endDate ?? 'today'],
    queryFn: async () => {
      const end = endDate ?? new Date().toISOString().slice(0, 10);
      const dailyRates = await fetchCdiDailyRates(ctx.api.network, startDate, end);
      return calculateCdb({ principal, startDate, endDate: end, cdiPercent, dailyRates });
    },
    // The start date is fixed, so only the refetch of the latest CDI rate matters.
    staleTime: STALE_TIME_MS,
    enabled: principal > 0 && cdiPercent > 0 && !!startDate,
  });
}
