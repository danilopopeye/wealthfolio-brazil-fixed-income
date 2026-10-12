import { useEffect, useMemo, useState } from 'react';
import { useAddonTranslation, type AddonContext } from '@wealthfolio/addon-sdk';
import { Card, CardContent } from '@wealthfolio/ui';
import { fetchCdiSeries } from '../lib/cdi-source';
import { buildSymbol, solveEmission, unitPrice, type RateMap, type SymbolKind, type TitleSpec } from '../lib/engine';
import { createCdb } from '../lib/createCdb';
import { nextBusinessDay, todaySaoPaulo } from '../lib/calendar';

const PROVIDER_CODE_KEY = 'providerCode';

type Mode = 'direct' | 'pu' | 'manual';

interface CalcResult {
  spec: TitleSpec;
  overrideSymbol: string;
  canonical: string;
  emission: string;
  pu: number;
  quantity: number;
  grossToday: number;
  note: string;
}

/**
 * Friendly canonical symbol derived from the product name — the same idea
 * the Wealthfolio UI applied to manually created assets. Standard format:
 * TYPE-<slug> (TYPE = CDB, LCI, LCA or LCDA), with a leading type name in
 * the slug trimmed so it never duplicates ("LCI Banco D…" + LCI →
 * LCI-BANCOD). Accents stripped, uppercase alphanumerics
 * only, one hyphen (the strict activity-symbol regex allows two).
 */
export type ProductType = 'CDB' | 'LCI' | 'LCA' | 'LCDA';

const PRODUCT_PREFIXES = ['LCDA', 'CDB', 'LCI', 'LCA'];

export function canonicalFromName(name: string, productType: ProductType = 'CDB'): string {
  let slug = name
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toUpperCase()
    .replace(/[^A-Z0-9]+/g, '')
    .slice(0, 60);
  for (const prefix of PRODUCT_PREFIXES) {
    if (slug.startsWith(prefix)) {
      slug = slug.slice(prefix.length);
      break;
    }
  }
  if (!slug) return '';
  return `${productType}-${slug}`;
}

const field =
  'w-full rounded-md border border-input bg-transparent px-2.5 py-1.5 text-sm text-foreground placeholder:text-muted-foreground focus:outline-none focus:ring-1 focus:ring-ring';
const labelCls = 'mb-1 block text-xs font-medium text-muted-foreground';

export function CdbWizardPage({ ctx }: { ctx: AddonContext }) {
  const { t, language } = useAddonTranslation();
  const locale = language === 'pt' ? 'pt-BR' : 'en-US';
  const fmtDate = (iso: string) => (language === 'pt' ? iso.split('-').reverse().join('/') : iso);
  const [accounts, setAccounts] = useState<{ id: string; name: string }[]>([]);
  const [accountId, setAccountId] = useState('');
  const [providerCode, setProviderCode] = useState('cdb-brasil-bcb');
  const [productType, setProductType] = useState<ProductType>('CDB');
  const [kind, setKind] = useState<SymbolKind>('CDI');
  const [rate, setRate] = useState('');
  const [emission, setEmission] = useState('');
  const [mode, setMode] = useState<Mode>('direct');
  const [nextDay, setNextDay] = useState(false);
  const [puPaid, setPuPaid] = useState('');
  const [qtyPaid, setQtyPaid] = useState('');
  const [buyDate, setBuyDate] = useState('');
  const [invested, setInvested] = useState('');
  const [maturityDate, setMaturityDate] = useState('');
  const [name, setName] = useState('');

  const [result, setResult] = useState<CalcResult | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [success, setSuccess] = useState('');

  useEffect(() => {
    ctx.api.accounts
      .getAll()
      .then((all) => {
        const list = all.map((a) => ({ id: a.id, name: a.name }));
        setAccounts(list);
        if (list.length > 0) setAccountId((current) => current || list[0].id);
      })
      .catch((e) => setError(t('err.accounts', { error: String(e) })));
    // Remember the last custom provider code used (the SDK cannot enumerate
    // individual custom providers — market.getProviders only exposes the
    // aggregate CUSTOM_SCRAPER entry).
    ctx.api.storage
      .get(PROVIDER_CODE_KEY)
      .then((saved) => {
        if (saved) setProviderCode(saved);
      })
      .catch(() => undefined);
  }, [ctx]);

  const canonical = useMemo(() => canonicalFromName(name, productType), [name, productType]);

  async function calculate(): Promise<void> {
    setError('');
    setResult(null);
    setSuccess('');
    const r = parseFloat(rate);
    const value = parseFloat(invested);
    if (!name.trim()) {
      setError(t('err.needName'));
      return;
    }
    if (!r || !buyDate || !value) {
      setError(t('err.needBase'));
      return;
    }
    if (mode === 'manual' && !emission) {
      setError(t('err.needEmission'));
      return;
    }
    setBusy(true);
    try {
      const today = todaySaoPaulo();
      const rates: RateMap = new Map();
      let spec: TitleSpec;
      let pu: number;
      let note = '';

      if (mode === 'direct') {
        const em = nextDay ? nextBusinessDay(buyDate) : buyDate;
        spec = { kind, ratePct: r, emission: em };
        pu = 1000;
        note = t('note.direct');
      } else if (mode === 'pu') {
        let target = parseFloat(puPaid);
        if (!target) {
          const q = parseFloat(qtyPaid);
          if (q) target = value / q;
        }
        if (!target) {
          throw new Error(t('err.needPu'));
        }
        const settlement = nextBusinessDay(buyDate);
        const from = new Date(Date.UTC(Number(settlement.slice(0, 4)) - 15, Number(settlement.slice(5, 7)) - 1, Number(settlement.slice(8, 10))))
          .toISOString()
          .slice(0, 10);
        for (const obs of await fetchCdiSeries(ctx.api.network, from, today)) {
          rates.set(obs.date, obs.value);
        }
        const solved = solveEmission(kind, r, target, settlement, rates);
        spec = { kind, ratePct: r, emission: solved.emission };
        pu = target;
        const quality =
          Math.abs(solved.diff) < 0.005 ? t('quality.exact') : Math.abs(solved.diff) < 1 ? t('quality.good') : t('quality.poor');
        note = t('note.solved', { quality });
      } else {
        spec = { kind, ratePct: r, emission };
        pu = NaN;
      }

      // Ensure rates cover [emission, today] for valuation.
      const firstCached = [...rates.keys()].sort()[0];
      if (!firstCached || spec.emission < firstCached) {
        for (const obs of await fetchCdiSeries(ctx.api.network, spec.emission, today)) {
          rates.set(obs.date, obs.value);
        }
      }
      if (Number.isNaN(pu)) {
        // Manual mode: PU paid = PU of the settlement date (D+1).
        const settle = nextBusinessDay(buyDate);
        pu = unitPrice(spec, settle, rates).price;
        note = t('note.settlement', { date: settle });
      }

      const current = unitPrice(spec, today, rates);
      setResult({
        spec,
        overrideSymbol: buildSymbol(spec),
        canonical,
        emission: spec.emission,
        pu,
        quantity: value / pu,
        grossToday: (value / pu) * current.price,
        note,
      });
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  async function submit(): Promise<void> {
    if (!result || !accountId) {
      setError(t('err.needCalc'));
      return;
    }
    setBusy(true);
    setError('');
    try {
      const code = providerCode.trim();
      const { assetId } = await createCdb({
        ctx,
        accountId,
        providerCode: code,
        symbol: result.canonical,
        name: name.trim() || result.canonical,
        overrideSymbol: result.overrideSymbol,
        buyDate,
        quantity: result.quantity,
        unitPrice: result.pu,
        maturityDate: maturityDate || undefined,
      });
      await ctx.api.storage.set(PROVIDER_CODE_KEY, code).catch(() => undefined);

      // Validate the wiring: the market sync above is asynchronous, so poll
      // briefly for the first quote before warning. An empty history after
      // the retries means the provider code or the override symbol is wrong
      // (position exists but will never price).
      let priced = false;
      for (let attempt = 0; attempt < 4 && !priced; attempt++) {
        if (attempt > 0) await new Promise((resolve) => setTimeout(resolve, 1500));
        try {
          const history = await ctx.api.quotes.getHistory(assetId);
          priced = Array.isArray(history) && history.length > 0;
        } catch {
          priced = false;
        }
      }
      const expected = result.grossToday.toLocaleString(locale, { style: 'currency', currency: 'BRL' });
      setSuccess(
        priced
          ? t('ok.created', { type: productType, symbol: result.canonical, value: expected })
          : t('ok.notPriced', { type: productType, symbol: result.canonical, provider: code, override: result.overrideSymbol })
      );
      setResult(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="mx-auto max-w-2xl space-y-4 p-6">
      <div>
        <h1 className="text-2xl font-semibold">{t('title')}</h1>
        <p className="text-sm text-muted-foreground">
          {t('subtitle')}
        </p>
      </div>

      <Card>
        <CardContent className="space-y-3 p-4">
          <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
            <div>
              <label className={labelCls}>{t('account')}</label>
              <select className={field} value={accountId} onChange={(e) => setAccountId(e.target.value)}>
                {accounts.map((a) => (
                  <option key={a.id} value={a.id}>
                    {a.name}
                  </option>
                ))}
              </select>
            </div>
            <div>
              <label className={labelCls}>{t('type')}</label>
              <select className={field} value={productType} onChange={(e) => setProductType(e.target.value as ProductType)}>
                <option value="CDB">CDB</option>
                <option value="LCI">LCI</option>
                <option value="LCA">LCA</option>
                <option value="LCDA">LCDA</option>
              </select>
            </div>
            <div>
              <label className={labelCls}>{t('indexer')}</label>
              <select className={field} value={kind} onChange={(e) => setKind(e.target.value as SymbolKind)}>
                <option value="CDI">{t('indexer.cdi')}</option>
                <option value="PRE">{t('indexer.pre')}</option>
              </select>
            </div>
            <div>
              <label className={labelCls}>{t('rate')}</label>
              <input className={field} type="number" step="0.01" placeholder="100" value={rate} onChange={(e) => setRate(e.target.value)} />
            </div>
          </div>

          <div className="grid grid-cols-1 gap-3 md:grid-cols-3">
            <div>
              <label className={labelCls}>{t('mode')}</label>
              <select className={field} value={mode} onChange={(e) => setMode(e.target.value as Mode)}>
                <option value="direct">{t('mode.direct')}</option>
                <option value="pu">{t('mode.pu')}</option>
                <option value="manual">{t('mode.manual')}</option>
              </select>
            </div>
            <div>
              <label className={labelCls}>{t('buyDate')}</label>
              <input className={field} type="date" value={buyDate} onChange={(e) => setBuyDate(e.target.value)} />
            </div>
            <div>
              <label className={labelCls}>{t('invested')}</label>
              <input className={field} type="number" step="0.01" placeholder="5000.00" value={invested} onChange={(e) => setInvested(e.target.value)} />
            </div>
          </div>

          <div>
            <label className={labelCls}>{t('maturity')}</label>
            <input className={field} type="date" value={maturityDate} onChange={(e) => setMaturityDate(e.target.value)} />
          </div>

          {mode === 'manual' && (
            <div>
              <label className={labelCls}>{t('emission')}</label>
              <input className={field} type="date" value={emission} onChange={(e) => setEmission(e.target.value)} />
            </div>
          )}
          {mode === 'direct' && (
            <label className="flex items-center gap-2 text-xs text-muted-foreground">
              <input type="checkbox" checked={nextDay} onChange={(e) => setNextDay(e.target.checked)} />
              {t('nextDay')}
            </label>
          )}
          {mode === 'pu' && (
            <div className="grid grid-cols-2 gap-3">
              <div>
                <label className={labelCls}>{t('puPaid')}</label>
                <input className={field} type="number" step="0.00000001" placeholder="1023.61" value={puPaid} onChange={(e) => setPuPaid(e.target.value)} />
              </div>
              <div>
                <label className={labelCls}>{t('qtyPaid')}</label>
                <input className={field} type="number" step="0.00001" placeholder="4.88191" value={qtyPaid} onChange={(e) => setQtyPaid(e.target.value)} />
              </div>
            </div>
          )}

          <div>
            <label className={labelCls}>{t('assetName')}</label>
            <input className={field} placeholder="Banco C Exclusivo Pós-fixado 1 ano" value={name} onChange={(e) => setName(e.target.value)} />
          </div>

          <div>
            <label className={labelCls}>{t('providerCode')}</label>
            <input className={field} value={providerCode} onChange={(e) => setProviderCode(e.target.value)} />
          </div>

          <button
            type="button"
            disabled={busy}
            onClick={() => void calculate()}
            className="rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-foreground disabled:opacity-50"
          >
            {busy ? t('calculating') : t('calc')}
          </button>
        </CardContent>
      </Card>

      {error && (
        <Card>
          <CardContent className="p-4 text-sm text-red-600 dark:text-red-400">{error}</CardContent>
        </Card>
      )}
      {success && (
        <Card>
          <CardContent className="p-4 text-sm text-green-600 dark:text-green-400">{success}</CardContent>
        </Card>
      )}

      {result && (
        <Card>
          <CardContent className="space-y-2 p-4 text-sm">
            <div className="flex justify-between">
              <span className="text-muted-foreground">{t('result.canonical')}</span>
              <code className="font-mono">{result.canonical}</code>
            </div>
            <div className="flex justify-between">
              <span className="text-muted-foreground">{t('result.override')}</span>
              <code className="font-mono">{result.overrideSymbol}</code>
            </div>
            <div className="flex justify-between">
              <span className="text-muted-foreground">{t('result.emission')}</span>
              <span>{fmtDate(result.emission)}</span>
            </div>
            <div className="flex justify-between">
              <span className="text-muted-foreground">{t('result.assetType')}</span>
              <span>{maturityDate ? t('result.bond', { date: fmtDate(maturityDate) }) : t('result.equity')}</span>
            </div>
            <div className="flex justify-between">
              <span className="text-muted-foreground">{t('result.pu')}</span>
              <span>{result.pu.toLocaleString(locale, { maximumFractionDigits: 8 })}</span>
            </div>
            <div className="flex justify-between">
              <span className="text-muted-foreground">{t('result.qty')}</span>
              <span>{result.quantity.toFixed(5)}</span>
            </div>
            <div className="flex justify-between">
              <span className="text-muted-foreground">{t('result.gross')}</span>
              <span>{result.grossToday.toLocaleString(locale, { style: 'currency', currency: 'BRL' })}</span>
            </div>
            <p className="text-xs text-muted-foreground">{result.note}</p>
            <button
              type="button"
              disabled={busy}
              onClick={() => void submit()}
              className="rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-foreground disabled:opacity-50"
            >
              {busy ? t('creating') : t('create')}
            </button>
          </CardContent>
        </Card>
      )}
    </div>
  );
}
