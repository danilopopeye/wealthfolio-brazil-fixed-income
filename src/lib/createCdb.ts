/**
 * Wealthfolio creation wiring: one BUY activity creates the security
 * (AssetResolutionInput), then the asset profile receives the custom
 * provider override, then a market sync prices it. The date goes in as an
 * ISO string — no manual date field, no MM/DD trap.
 */
import type { AddonContext } from '@wealthfolio/addon-sdk';
import type { TitleSpec } from './engine';

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
  /** Maturity date (YYYY-MM-DD). When present the asset is registered as a
   *  Bond (correct type for renda fixa) with its spec — face value 1000,
   *  zero coupon — and the provider override under both resolver keys, so
   *  the custom provider still receives an equity symbol. */
  maturityDate?: string;
  /** Parametrization of the title, persisted in addon storage so
   *  "aplicação adicional" can rebuild the PU curve without re-deriving it
   *  from the provider override. */
  spec: TitleSpec;
}

export interface CreateCdbResult {
  assetId: string;
}

export async function createCdb(input: CreateCdbInput): Promise<CreateCdbResult> {
  const { ctx, accountId, providerCode, symbol, name, overrideSymbol, buyDate, quantity, unitPrice, maturityDate, spec } = input;
  const instrumentType = maturityDate ? 'BOND' : 'EQUITY';

  const activity = await ctx.api.activities.create({
    accountId,
    activityType: 'BUY',
    // RFC3339 requires an explicit timezone: bare "YYYY-MM-DDTHH:mm:ss"
    // is rejected by the host validator.
    activityDate: `${buyDate}T12:00:00Z`,
    quantity: quantity.toFixed(5),
    unitPrice: unitPrice.toFixed(8),
    currency: 'BRL',
    fee: 0,
    tax: 0,
    asset: {
      symbol,
      name,
      instrumentType,
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

  // The SDK type omits metadata, but both adapters pass the payload through
  // verbatim and the backend UpdateAssetProfile accepts it (BondSpec lives
  // in Asset.metadata["bond"]).
  type ProfileUpdate = Parameters<typeof ctx.api.assets.updateProfile>[0] & {
    metadata?: Record<string, unknown>;
  };
  const profile: ProfileUpdate = {
    id: assetId,
    // The backend struct requires `notes` (non-optional String); omitting
    // it fails deserialization with 422 Unprocessable Entity.
    notes: '',
    // AssetResolutionInput.name is not honored by the activity-creation
    // path (assets end up named by a generated UUID); the profile update is
    // the reliable place to set it.
    name,
    providerConfig: {
      custom_provider_code: providerCode,
      preferred_provider: 'CUSTOM_SCRAPER',
      overrides: {
        // The resolver chain looks the override up by the provider id
        // ("CUSTOM_SCRAPER") — this key makes a Bond-typed asset resolve to
        // an equity symbol before reaching the custom provider.
        CUSTOM_SCRAPER: { symbol: overrideSymbol, type: 'equity_symbol' },
        // The custom scraper itself swaps the symbol via this per-source key.
        [`CUSTOM:${providerCode}`]: { symbol: overrideSymbol, type: 'equity_symbol' },
      },
    },
  };
  if (maturityDate) {
    profile.metadata = {
      bond: {
        maturityDate,
        faceValue: 1000,
        // No coupon field: CDBs accrue to maturity (zero-coupon, the
        // backend default).
      },
    };
  }
  await ctx.api.assets.updateProfile(profile);

  // Persist the parametrization (primary source for the wizard's
  // "aplicação adicional" mode; the provider override is the fallback).
  // Best effort — the override remains a working fallback.
  await ctx.api.storage.set(`title-spec:${assetId}`, JSON.stringify(spec)).catch(() => undefined);

  // Best effort: price it right away so the position shows immediately.
  await ctx.api.market.sync([assetId], false).catch(() => undefined);

  return { assetId };
}
