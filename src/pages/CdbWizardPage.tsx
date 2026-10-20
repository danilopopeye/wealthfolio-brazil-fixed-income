import { useEffect, useMemo, useState } from 'react';
import { useAddonTranslation, type AddonContext } from '@wealthfolio/addon-sdk';
import {
  Button,
  Card,
  CardContent,
  Checkbox,
  Command,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
  Input,
  Label,
  Popover,
  PopoverContent,
  PopoverTrigger,
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@wealthfolio/ui';
import { Check, ChevronsUpDown } from 'lucide-react';
import { fetchCdiSeries } from '../lib/cdi-source';
import { parseDecimal } from '../lib/decimal';
import { buildSymbol, solveEmission, unitPrice, type RateMap, type SymbolKind, type TitleSpec } from '../lib/engine';
import { createCdb } from '../lib/createCdb';
import { listTitles, previewApplication, type ApplicationPreview, type ExistingTitle } from '../lib/movements';
import { nextBusinessDay, todaySaoPaulo } from '../lib/calendar';

const PROVIDER_CODE_KEY = 'providerCode';
const DEFAULT_PROVIDER_CODE = 'brazil-fixed-income';

type Mode = 'direct' | 'pu' | 'manual' | 'existing';

interface CalcResult {
  spec: TitleSpec;
  overrideSymbol: string;
  canonical: string;
  emission: string;
  pu: number;
  quantity: number;
  grossToday: number;
  /** CDI series was unavailable: no valuation for today, market sync will price. */
  degraded: boolean;
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

const labelCls = 'text-xs font-medium text-muted-foreground';

/** WF-styled labeled form field (Label + control). */
function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="space-y-1">
      <Label className={labelCls}>{label}</Label>
      {children}
    </div>
  );
}

export function CdbWizardPage({ ctx }: { ctx: AddonContext }) {
  const { t, language } = useAddonTranslation();
  const locale = language === 'pt' ? 'pt-BR' : 'en-US';
  const fmtDate = (iso: string) => (language === 'pt' ? iso.split('-').reverse().join('/') : iso);
  const [accounts, setAccounts] = useState<{ id: string; name: string }[]>([]);
  const [accountId, setAccountId] = useState('');
  const [providerCode, setProviderCode] = useState(DEFAULT_PROVIDER_CODE);
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

  // "Aplicação adicional" state: existing titles of the account + preview.
  const [titles, setTitles] = useState<ExistingTitle[]>([]);
  const [titleId, setTitleId] = useState('');
  const [mov, setMov] = useState<ApplicationPreview | null>(null);
  const [comboOpen, setComboOpen] = useState(false);
  const selectedTitle = titles.find((x) => x.assetId === titleId) ?? null;

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

  // Existing titles for the "aplicação adicional" mode.
  useEffect(() => {
    if (mode !== 'existing' || !accountId) return;
    setTitles([]);
    setTitleId('');
    setMov(null);
    listTitles(ctx, accountId)
      .then((list) => {
        setTitles(list);
        if (list.length > 0) setTitleId((current) => (list.some((x) => x.assetId === current) ? current : list[0].assetId));
      })
      .catch((e) => setError(t('err.titles', { error: String(e) })));
    // eslint-disable-next-line react-hooks/exhaustive-deps -- refetch on account/mode change only
  }, [ctx, mode, accountId]);

  const canonical = useMemo(() => canonicalFromName(name, productType), [name, productType]);

  async function calculate(): Promise<void> {
    setError('');
    setResult(null);
    setSuccess('');
    setMov(null);
    const value = parseDecimal(invested);

    if (mode === 'existing') {
      const title = titles.find((x) => x.assetId === titleId);
      if (!title) {
        setError(t('err.needTitle'));
        return;
      }
      const missing: string[] = [];
      if (!buyDate) missing.push(t('move.date'));
      if (!value) missing.push(t('move.invested'));
      if (missing.length > 0) {
        setError(t('err.needBase', { fields: missing.join(', ') }));
        return;
      }
      if (buyDate < title.spec.emission) {
        setError(t('err.move.date', { date: fmtDate(title.spec.emission) }));
        return;
      }
      setBusy(true);
      try {
        setMov(await previewApplication(ctx, title.spec, buyDate, value));
      } catch (e) {
        setError(e instanceof Error ? e.message : String(e));
      } finally {
        setBusy(false);
      }
      return;
    }

    const r = parseDecimal(rate);
    if (!name.trim()) {
      setError(t('err.needName'));
      return;
    }
    if (!r || !buyDate || !value) {
      const missing: string[] = [];
      if (!r) missing.push(t('field.rate'));
      if (!buyDate) missing.push(t('field.buyDate'));
      if (!value) missing.push(t('field.invested'));
      setError(t('err.needBase', { fields: missing.join(', ') }));
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
        let target = parseDecimal(puPaid);
        if (!target) {
          const q = parseDecimal(qtyPaid);
          if (q) target = value / q;
        }
        if (!target) {
          throw new Error(t('err.needPu'));
        }
        const settlement = nextBusinessDay(buyDate);
        const from = new Date(Date.UTC(Number(settlement.slice(0, 4)) - 15, Number(settlement.slice(5, 7)) - 1, Number(settlement.slice(8, 10))))
          .toISOString()
          .slice(0, 10);
        // Pre-fixed math is calendar-only; the CDI series is only needed
        // by the post-fixed solver.
        if (kind === 'CDI') {
          for (const obs of await fetchCdiSeries(ctx.api.network, from, today)) {
            rates.set(obs.date, obs.value);
          }
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

      // Ensure rates cover [emission, today] for valuation (post-fixed only;
      // pre-fixed PU is calendar-only and needs no CDI at all).
      let degraded = false;
      const firstCached = [...rates.keys()].sort()[0];
      if (kind === 'CDI' && (!firstCached || spec.emission < firstCached)) {
        try {
          for (const obs of await fetchCdiSeries(ctx.api.network, spec.emission, today)) {
            rates.set(obs.date, obs.value);
          }
        } catch (e) {
          // Direct mode is exact without the series (PU at emission = 1000):
          // register anyway and let the market sync price it later.
          if (mode !== 'direct') throw e;
          degraded = true;
        }
      }
      if (Number.isNaN(pu)) {
        // Manual mode: PU paid = PU of the settlement date (D+1).
        const settle = nextBusinessDay(buyDate);
        pu = unitPrice(spec, settle, rates).price;
        note = t('note.settlement', { date: settle });
      }

      // Degraded (series unavailable): no valuation for today — report the
      // invested value itself; the market sync will supply the real price.
      const grossToday = degraded ? value : (value / pu) * unitPrice(spec, today, rates).price;
      setResult({
        spec,
        overrideSymbol: buildSymbol(spec),
        canonical,
        emission: spec.emission,
        pu,
        quantity: value / pu,
        grossToday,
        degraded,
        note: degraded ? `${note} — ${t('note.degraded')}` : note,
      });
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  async function submit(): Promise<void> {
    if (!accountId) {
      setError(t('err.needCalc'));
      return;
    }

    if (mode === 'existing') {
      const title = titles.find((x) => x.assetId === titleId);
      if (!title || !mov) {
        setError(t('err.needCalc'));
        return;
      }
      setBusy(true);
      setError('');
      try {
        // Normalized-units BUY: quantity = valor / PU(day) at the symbol's
        // own PU — the position curve stays exact on every date.
        await ctx.api.activities.create({
          accountId,
          activityType: 'BUY',
          activityDate: `${buyDate}T12:00:00Z`,
          quantity: mov.quantity.toFixed(8),
          unitPrice: mov.pu.toFixed(8),
          currency: 'BRL',
          fee: 0,
          tax: 0,
          asset: { id: title.assetId },
        });
        await ctx.api.market.sync([title.assetId], false).catch(() => undefined);
        setSuccess(
          t('ok.applied', {
            qty: mov.quantity.toFixed(8),
            pu: mov.pu.toLocaleString(locale, { maximumFractionDigits: 8 }),
            value: mov.grossToday.toLocaleString(locale, { style: 'currency', currency: 'BRL' }),
          })
        );
        setMov(null);
      } catch (e) {
        setError(e instanceof Error ? e.message : String(e));
      } finally {
        setBusy(false);
      }
      return;
    }

    if (!result) {
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
        spec: result.spec,
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
          ? result.degraded
            ? t('ok.createdNoEstimate', { type: productType, symbol: result.canonical })
            : t('ok.created', { type: productType, symbol: result.canonical, value: expected })
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
          <div className={`grid grid-cols-2 gap-3 ${mode === 'existing' ? '' : 'md:grid-cols-4'}`}>
            <Field label={t('account')}>
              <Select value={accountId} onValueChange={setAccountId}>
                <SelectTrigger className="w-full">
                  <SelectValue placeholder={t('account')} />
                </SelectTrigger>
                <SelectContent>
                  {accounts.map((a) => (
                    <SelectItem key={a.id} value={a.id}>
                      {a.name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </Field>
            {mode !== 'existing' && (
              <>
                <Field label={t('type')}>
                  <Select value={productType} onValueChange={(v) => setProductType(v as ProductType)}>
                    <SelectTrigger className="w-full">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="CDB">CDB</SelectItem>
                      <SelectItem value="LCI">LCI</SelectItem>
                      <SelectItem value="LCA">LCA</SelectItem>
                      <SelectItem value="LCDA">LCDA</SelectItem>
                    </SelectContent>
                  </Select>
                </Field>
                <Field label={t('indexer')}>
                  <Select value={kind} onValueChange={(v) => setKind(v as SymbolKind)}>
                    <SelectTrigger className="w-full">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="CDI">{t('indexer.cdi')}</SelectItem>
                      <SelectItem value="PRE">{t('indexer.pre')}</SelectItem>
                    </SelectContent>
                  </Select>
                </Field>
                <Field label={t('rate')}>
                  <Input type="text" inputMode="decimal" placeholder="100" value={rate} onChange={(e) => setRate(e.target.value)} />
                </Field>
              </>
            )}
          </div>

          <div className="grid grid-cols-1 gap-3 md:grid-cols-3">
            <Field label={t('mode')}>
              <Select value={mode} onValueChange={(v) => setMode(v as Mode)}>
                <SelectTrigger className="w-full">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="direct">{t('mode.direct')}</SelectItem>
                  <SelectItem value="existing">{t('mode.existing')}</SelectItem>
                  <SelectItem value="pu">{t('mode.pu')}</SelectItem>
                  <SelectItem value="manual">{t('mode.manual')}</SelectItem>
                </SelectContent>
              </Select>
            </Field>
            <Field label={mode === 'existing' ? t('move.date') : t('buyDate')}>
              <Input type="date" value={buyDate} onChange={(e) => setBuyDate(e.target.value)} />
            </Field>
            <Field label={mode === 'existing' ? t('move.invested') : t('invested')}>
              <Input type="text" inputMode="decimal" placeholder="5000" value={invested} onChange={(e) => setInvested(e.target.value)} />
            </Field>
          </div>

          {mode === 'existing' && (
            <div className="space-y-1">
              <Label className={labelCls}>{t('move.title')}</Label>
              {titles.length === 0 ? (
                <p className="text-xs text-muted-foreground">{t('move.none')}</p>
              ) : (
                <Popover open={comboOpen} onOpenChange={setComboOpen}>
                  <PopoverTrigger asChild>
                    <Button variant="outline" role="combobox" aria-expanded={comboOpen} className="w-full justify-between font-normal">
                      <span
                        className="min-w-0 truncate"
                        title={selectedTitle ? `${selectedTitle.name} (${selectedTitle.symbol})` : undefined}
                      >
                        {selectedTitle ? `${selectedTitle.name} (${selectedTitle.symbol})` : t('move.pick')}
                      </span>
                      <ChevronsUpDown className="ml-2 size-4 shrink-0 opacity-50" />
                    </Button>
                  </PopoverTrigger>
                  <PopoverContent className="w-full p-0" align="start">
                    <Command>
                      <CommandInput placeholder={t('move.search')} />
                      <CommandList>
                        <CommandEmpty>{t('move.searchEmpty')}</CommandEmpty>
                        <CommandGroup>
                          {titles.map((x) => (
                            <CommandItem
                              key={x.assetId}
                              value={`${x.symbol} ${x.name}`}
                              onSelect={() => {
                                setTitleId(x.assetId);
                                setComboOpen(false);
                              }}
                            >
                              <Check className={`mr-2 size-4 ${x.assetId === titleId ? '' : 'opacity-0'}`} />
                              <span className="min-w-0 truncate">{x.name}</span>
                              <span className="text-muted-foreground ml-auto shrink-0 font-mono text-xs">{x.symbol}</span>
                            </CommandItem>
                          ))}
                        </CommandGroup>
                      </CommandList>
                    </Command>
                  </PopoverContent>
                </Popover>
              )}
              {selectedTitle && (
                <p className="text-xs text-muted-foreground">
                  {t('move.spec', {
                    kind: selectedTitle.spec.kind === 'CDI' ? '% CDI' : '% a.a.',
                    rate: selectedTitle.spec.ratePct.toFixed(2),
                    date: fmtDate(selectedTitle.spec.emission),
                    qty: selectedTitle.quantity.toLocaleString(locale, { maximumFractionDigits: 5 }),
                  })}
                </p>
              )}
            </div>
          )}

          {mode !== 'existing' && (
            <>
              <Field label={t('maturity')}>
                <Input type="date" value={maturityDate} onChange={(e) => setMaturityDate(e.target.value)} />
              </Field>

              {mode === 'manual' && (
                <Field label={t('emission')}>
                  <Input type="date" value={emission} onChange={(e) => setEmission(e.target.value)} />
                </Field>
              )}
              {mode === 'direct' && (
                <label className="flex items-center gap-2 text-xs text-muted-foreground">
                  <Checkbox checked={nextDay} onCheckedChange={(v) => setNextDay(v === true)} />
                  {t('nextDay')}
                </label>
              )}
              {mode === 'pu' && (
                <div className="grid grid-cols-2 gap-3">
                  <Field label={t('puPaid')}>
                    <Input type="text" inputMode="decimal" placeholder="1023.61" value={puPaid} onChange={(e) => setPuPaid(e.target.value)} />
                  </Field>
                  <Field label={t('qtyPaid')}>
                    <Input type="text" inputMode="decimal" placeholder="4.88191" value={qtyPaid} onChange={(e) => setQtyPaid(e.target.value)} />
                  </Field>
                </div>
              )}

              <Field label={t('assetName')}>
                <Input placeholder="Banco C Exclusivo Pós-fixado 1 ano" value={name} onChange={(e) => setName(e.target.value)} />
              </Field>

              <Field label={t('providerCode')}>
                <Input value={providerCode} onChange={(e) => setProviderCode(e.target.value)} />
              </Field>
            </>
          )}

          <Button type="button" disabled={busy} onClick={() => void calculate()}>
            {busy ? t('calculating') : t('calc')}
          </Button>
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

      {mode === 'existing' && mov && selectedTitle && (
        <Card>
          <CardContent className="space-y-2 p-4 text-sm">
            <div className="flex justify-between">
              <span className="text-muted-foreground">{t('result.move.pu')}</span>
              <span>{mov.pu.toLocaleString(locale, { maximumFractionDigits: 8 })}</span>
            </div>
            <div className="flex justify-between">
              <span className="text-muted-foreground">{t('result.move.qty')}</span>
              <span>{mov.quantity.toFixed(8)}</span>
            </div>
            <div className="flex justify-between">
              <span className="text-muted-foreground">{t('result.move.gross')}</span>
              <span>{mov.grossToday.toLocaleString(locale, { style: 'currency', currency: 'BRL' })}</span>
            </div>
            <p className="text-xs text-muted-foreground">
              {t('move.note')}
              {mov.estimatedDays > 0 ? ` — ${t('note.carry', { days: mov.estimatedDays })}` : ''}
            </p>
            <Button type="button" disabled={busy} onClick={() => void submit()}>
              {busy ? t('creating') : t('create')}
            </Button>
          </CardContent>
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
            <Button type="button" disabled={busy} onClick={() => void submit()}>
              {busy ? t('creating') : t('create')}
            </Button>
          </CardContent>
        </Card>
      )}
    </div>
  );
}
