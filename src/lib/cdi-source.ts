/**
 * Client for the BCB SGS series 12 (daily CDI) via the Wealthfolio addon
 * network broker. The addon sandbox cannot reach localhost/private hosts
 * (SSRF protection), so the addon fetches the public BCB endpoint directly
 * and computes the math client-side (see engine.ts).
 */
import { SGS_TIMEOUT_SECS, SGS_USER_AGENT, type BrokerRequest, type NetworkBroker } from './sgs';

export interface SgsObservation {
  date: string; // YYYY-MM-DD
  value: number; // % per business day
}

const SGS_URL = 'https://api.bcb.gov.br/dados/serie/bcdata.sgs.12/dados';

export function isoToBrl(iso: string): string {
  const [y, m, d] = iso.split('-');
  return `${d}/${m}/${y}`;
}

function addYearsIso(iso: string, years: number): string {
  const [y, m, d] = iso.split('-').map(Number);
  return new Date(Date.UTC(y + years, m - 1, d)).toISOString().slice(0, 10);
}

async function fetchRange(network: NetworkBroker, from: string, to: string): Promise<SgsObservation[]> {
  const url = `${SGS_URL}?formato=json&dataInicial=${isoToBrl(from)}&dataFinal=${isoToBrl(to)}`;
  const response = await network.request({
    url,
    method: 'GET',
    timeoutSecs: SGS_TIMEOUT_SECS,
    headers: { 'User-Agent': SGS_USER_AGENT },
  } as BrokerRequest);
  if (response.status !== 200) {
    throw new Error(`SGS HTTP ${response.status}: ${response.body.slice(0, 120)}`);
  }
  const payload: unknown = JSON.parse(response.body);
  if (!Array.isArray(payload)) {
    throw new Error(`Unexpected SGS response: ${JSON.stringify(payload).slice(0, 120)}`);
  }
  return payload.map((row) => {
    const { data, valor } = row as { data: string; valor: string };
    return {
      date: data.split('/').reverse().join('-'),
      value: Number(valor),
    };
  });
}

/**
 * Fetches the daily CDI between two dates (inclusive), transparently
 * chunking long windows: the SGS API rejects spans over 10 years for daily
 * series (HTTP 406), so we fetch in 9-year blocks.
 */
export async function fetchCdiSeries(network: NetworkBroker, from: string, to: string): Promise<SgsObservation[]> {
  const all: SgsObservation[] = [];
  let segFrom = from;
  while (segFrom <= to) {
    const limit = addYearsIso(segFrom, 9);
    const segTo = limit < to ? limit : to;
    const rows = await fetchRange(network, segFrom, segTo);
    all.push(...rows);
    // Advance past segTo (one calendar day).
    const [y, m, d] = segTo.split('-').map(Number);
    segFrom = new Date(Date.UTC(y, m - 1, d + 1)).toISOString().slice(0, 10);
  }
  return all;
}
