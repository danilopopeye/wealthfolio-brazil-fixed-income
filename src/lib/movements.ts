/**
 * Additional applications on an existing title ("aplicação adicional").
 *
 * A bank title may accept new applications after its emission: each one
 * restarts at PU 1000 on its own date, while the addon models ONE symbol
 * with ONE PU curve anchored at the emission. Both views reconcile exactly
 * because same-rate curves are proportional:
 *
 *   F(emission -> t) = F(emission -> d) * F(d -> t)
 *
 * So the extra application is booked as a BUY at the symbol's PU on the
 * application date (quantity = valor / PU(d)): the position's market value
 * matches the bank on every date, forever — at the cost of quantity and
 * unit price being normalized units instead of the bank's literal lot.
 *
 * Redemptions (daily-liquidity CDBs) need no helper: a plain SELL at the
 * PU of the redemption day is already exact, since money leaves at market
 * price and the remaining quantity keeps the same curve.
 */
import type { AddonContext } from '@wealthfolio/addon-sdk';
import { parseSymbol, unitPrice, type RateMap, type TitleSpec } from './engine';
import { fetchCdiSeries } from './cdi-source';
import { todaySaoPaulo } from './calendar';

const SPEC_KEY_PREFIX = 'title-spec:';

export interface ExistingTitle {
  assetId: string;
  /** Canonical symbol, e.g. CDB-BANCOC. */
  symbol: string;
  name: string;
  quantity: number;
  marketValue: number;
  /** Current price (PU), when the position is already priced. */
  price: number | null;
  spec: TitleSpec;
}

export interface ApplicationPreview {
  /** Symbol PU on the application date — the normalized BUY price. */
  pu: number;
  /** valor / pu, in normalized units. */
  quantity: number;
  /** Gross value of this application today (quantity x PU today). */
  grossToday: number;
  /** Carry-forward days used by the valuation (trailing unpublished CDI). */
  estimatedDays: number;
}

function isTitleSpec(value: unknown): value is TitleSpec {
  if (typeof value !== 'object' || value === null) return false;
  const v = value as Record<string, unknown>;
  return (
    (v.kind === 'CDI' || v.kind === 'PRE') &&
    typeof v.ratePct === 'number' &&
    v.ratePct > 0 &&
    typeof v.emission === 'string' &&
    /^\d{4}-\d{2}-\d{2}$/.test(v.emission)
  );
}

/** Spec persisted at creation time (primary source). */
async function storedSpec(ctx: AddonContext, assetId: string): Promise<TitleSpec | null> {
  const raw = await ctx.api.storage.get(SPEC_KEY_PREFIX + assetId).catch(() => null);
  if (!raw) return null;
  try {
    const parsed: unknown = JSON.parse(raw);
    return isTitleSpec(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

/** Spec re-derived from the asset profile's provider override (fallback for
 *  titles registered before spec persistence existed). */
function overrideSpec(profile: { providerConfig?: Record<string, unknown> | null } | null): TitleSpec | null {
  const overrides = profile?.providerConfig?.overrides;
  if (typeof overrides !== 'object' || overrides === null) return null;
  for (const entry of Object.values(overrides as Record<string, unknown>)) {
    if (typeof entry === 'object' && entry !== null) {
      const symbol = (entry as { symbol?: unknown }).symbol;
      if (typeof symbol === 'string') {
        const spec = parseSymbol(symbol);
        if (spec) return spec;
      }
    }
  }
  return null;
}

/** Holdings of the account that resolve to one of our parametrized titles. */
export async function listTitles(ctx: AddonContext, accountId: string): Promise<ExistingTitle[]> {
  const holdings = await ctx.api.portfolio.getHoldings(accountId);
  const titles: ExistingTitle[] = [];
  for (const h of holdings) {
    if (!(h.quantity > 0)) continue;
    const assetId = h.instrument?.id ?? h.id;
    if (!assetId) continue;
    const spec = (await storedSpec(ctx, assetId)) ?? overrideSpec(await ctx.api.assets.getProfile(assetId).catch(() => null));
    if (!spec) continue;
    titles.push({
      assetId,
      symbol: h.instrument?.symbol ?? assetId,
      name: h.instrument?.name ?? h.instrument?.symbol ?? assetId,
      quantity: h.quantity,
      marketValue: h.marketValue?.local ?? 0,
      price: h.price ?? null,
      spec,
    });
  }
  // Alphabetical so the picker reads predictably as the position count grows.
  return titles.sort(
    (a, b) =>
      a.name.localeCompare(b.name, 'pt-BR', { sensitivity: 'base' }) || a.symbol.localeCompare(b.symbol)
  );
}

/** Loads CDI rates covering [emission, today] (post-fixed only; the PU of a
 *  pre-fixed title is calendar-only and needs no series). */
async function loadRates(ctx: AddonContext, spec: TitleSpec, date: string): Promise<RateMap> {
  const rates: RateMap = new Map();
  if (spec.kind !== 'CDI') return rates;
  const today = todaySaoPaulo();
  const from = spec.emission < date ? spec.emission : date;
  for (const obs of await fetchCdiSeries(ctx.api.network, from, today)) {
    rates.set(obs.date, obs.value);
  }
  return rates;
}

/** PU and normalized quantity for an additional application of `valor` on
 *  `date`, plus its estimated gross value today. */
export async function previewApplication(
  ctx: AddonContext,
  spec: TitleSpec,
  date: string,
  valor: number
): Promise<ApplicationPreview> {
  if (date < spec.emission) {
    throw new Error(`application date ${date} is before the title emission ${spec.emission}`);
  }
  if (!(valor > 0)) throw new Error('valor must be positive');
  const rates = await loadRates(ctx, spec, date);
  const atDate = unitPrice(spec, date, rates);
  const todayPu = unitPrice(spec, todaySaoPaulo(), rates);
  const pu = atDate.price;
  if (!(pu > 0)) throw new Error(`PU on ${date} is not positive`);
  return {
    pu,
    quantity: valor / pu,
    grossToday: (valor / pu) * todayPu.price,
    estimatedDays: Math.max(atDate.estimatedDays, todayPu.estimatedDays),
  };
}
