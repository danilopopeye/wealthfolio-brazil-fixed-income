/**
 * Wealthfolio creation wiring: one BUY activity creates the security
 * (AssetResolutionInput), then the asset profile receives the custom
 * provider override, then a market sync prices it. The date goes in as an
 * ISO string — no manual date field, no MM/DD trap.
 */
import type { AddonContext } from '@wealthfolio/addon-sdk';

export interface CreateCdbInput {
  ctx: AddonContext;
  accountId: string;
  /** Custom provider code registered in Settings → Market Data. */
  providerCode: string;
  /** Clean canonical symbol, e.g. CDB-BANCOC-10000. */
  symbol: string;
  name: string;
  /** Parametrized symbol, e.g. CDI-100.00-20251205. */
  overrideSymbol: string;
  /** Purchase date, YYYY-MM-DD. */
  buyDate: string;
  quantity: number;
  unitPrice: number;
}

export interface CreateCdbResult {
  assetId: string;
}

export async function createCdb(input: CreateCdbInput): Promise<CreateCdbResult> {
  const { ctx, accountId, providerCode, symbol, name, overrideSymbol, buyDate, quantity, unitPrice } = input;

  const activity = await ctx.api.activities.create({
    accountId,
    activityType: 'BUY',
    activityDate: `${buyDate}T12:00:00`,
    quantity: quantity.toFixed(5),
    unitPrice: unitPrice.toFixed(8),
    currency: 'BRL',
    fee: 0,
    tax: 0,
    asset: {
      symbol,
      name,
      instrumentType: 'EQUITY',
      quoteCcy: 'BRL',
      quoteMode: 'MARKET',
    },
  });

  const assetId = activity.assetId;
  if (!assetId) {
    throw new Error(
      'Atividade criada, mas o assetId não veio na resposta — configure o override ' +
        `manualmente na aba Market Data do ativo ${symbol} (provider ${providerCode}, symbol ${overrideSymbol}).`
    );
  }

  await ctx.api.assets.updateProfile({
    id: assetId,
    providerConfig: {
      custom_provider_code: providerCode,
      preferred_provider: 'CUSTOM_SCRAPER',
      overrides: {
        [`CUSTOM:${providerCode}`]: { symbol: overrideSymbol, type: 'equity_symbol' },
      },
    },
  });

  // Best effort: price it right away so the position shows immediately.
  await ctx.api.market.sync([assetId], false).catch(() => undefined);

  return { assetId };
}
