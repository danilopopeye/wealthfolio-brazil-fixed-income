/**
 * Client for the Banco Central do Brasil (BCB) SGS API
 * (Sistema Gerencador de Series Temporais).
 *
 * The addon sandbox has no direct network access: requests must go through
 * the host network broker (`ctx.api.network.request`). The broker only allows
 * hosts declared in `manifest.json` under `network.allowedHosts`.
 *
 * Docs: https://www3.bcb.gov.br/sgs/port/fachada.wiki
 */
import type { NetworkAPI } from '@wealthfolio/addon-sdk';

/** SGS series for the daily CDI overnight rate, in % points per business day. */
export const CDI_SERIES_CODE = 12;

const SGS_BASE_URL = 'https://api.bcb.gov.br/dados/serie/bcdata.sgs.';

/** A single SGS observation. `date` is an ISO date string (YYYY-MM-DD). */
export interface SgsObservation {
  date: string;
  /** Rate value in percentage points (e.g. 0.043739 means 0.043739% per day). */
  value: number;
}

/** Minimal broker interface, so plain-fetch adapters work outside the sandbox. */
export type NetworkBroker = Pick<NetworkAPI, 'request'>;

/** Converts 'YYYY-MM-DD' to 'DD/MM/YYYY' (format the SGS API expects). */
export function isoToBrlDate(isoDate: string): string {
  const [year, month, day] = isoDate.split('-');
  if (!year || !month || !day) {
    throw new Error(`Invalid ISO date: ${isoDate} (expected YYYY-MM-DD)`);
  }
  return `${day}/${month}/${year}`;
}

/** Converts 'DD/MM/YYYY' to 'YYYY-MM-DD'. */
export function brlToIsoDate(brlDate: string): string {
  const [day, month, year] = brlDate.split('/');
  return `${year}-${month}-${day}`;
}

/**
 * Fetches a daily SGS series between two dates (inclusive).
 *
 * The API only returns business days with published values, so no weekend or
 * holiday filtering is needed on our side.
 */
export async function fetchSgsSeries(
  network: NetworkBroker,
  seriesCode: number,
  params: { startDate: string; endDate: string }
): Promise<SgsObservation[]> {
  const url =
    `${SGS_BASE_URL}${seriesCode}/dados?formato=json` +
    `&dataInicial=${isoToBrlDate(params.startDate)}` +
    `&dataFinal=${isoToBrlDate(params.endDate)}`;

  const response = await network.request({ url, method: 'GET' });

  if (response.status !== 200) {
    throw new Error(
      `SGS request failed (HTTP ${response.status}): ${response.body.slice(0, 200)}`
    );
  }

  const payload: unknown = JSON.parse(response.body);

  // On failures the SGS API answers with a JSON error object instead of an array.
  if (!Array.isArray(payload)) {
    throw new Error(`Unexpected SGS response: ${JSON.stringify(payload).slice(0, 200)}`);
  }

  return payload.map((entry) => {
    const { data, valor } = entry as { data: string; valor: string };
    return {
      date: brlToIsoDate(data),
      value: Number(valor),
    };
  });
}

/**
 * Fetches the daily CDI rate (SGS series 12) between two dates (inclusive).
 */
export function fetchCdiDailyRates(
  network: NetworkBroker,
  startDate: string,
  endDate: string
): Promise<SgsObservation[]> {
  return fetchSgsSeries(network, CDI_SERIES_CODE, { startDate, endDate });
}
