import { useEffect, useMemo, useState } from 'react';
import type { AddonContext } from '@wealthfolio/addon-sdk';
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
 * CDB-<slug>, with a leading "CDB" in the name trimmed so it never
 * duplicates ("CDB Banco C…" → CDB-C6HELIX…, "Banco C Exclusivo…" →
 * CDB-C6EXCLUSIVO…). Accents stripped, uppercase alphanumerics only, one
 * hyphen (the strict activity-symbol regex allows two).
 */
export function canonicalFromName(name: string): string {
  let slug = name
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toUpperCase()
    .replace(/[^A-Z0-9]+/g, '')
    .slice(0, 60);
  if (slug.startsWith('CDB')) slug = slug.slice(3);
  if (!slug) return '';
  return `CDB-${slug}`;
}

const field =
  'w-full rounded-md border border-input bg-transparent px-2.5 py-1.5 text-sm text-foreground placeholder:text-muted-foreground focus:outline-none focus:ring-1 focus:ring-ring';
const labelCls = 'mb-1 block text-xs font-medium text-muted-foreground';

export function CdbWizardPage({ ctx }: { ctx: AddonContext }) {
  const [accounts, setAccounts] = useState<{ id: string; name: string }[]>([]);
  const [accountId, setAccountId] = useState('');
  const [providerCode, setProviderCode] = useState('cdb-brasil-bcb');
  const [kind, setKind] = useState<SymbolKind>('CDI');
  const [rate, setRate] = useState('');
  const [bank, setBank] = useState('');
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
      .catch((e) => setError(`Não consegui listar as contas: ${e}`));
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

  const canonical = useMemo(() => {
    // Friendly code from the product name when given (e.g. "Banco C Exclusivo
    // Pós-fixado 1 ano" -> CDB-C6EXCLUSIVOPOSFIXADO1ANO); falls back to the
    // bank+rate scheme when only the bank is filled.
    const fromName = canonicalFromName(name);
    if (fromName) return fromName;
    const slug = bank.trim().toUpperCase().replace(/[^A-Z0-9]/g, '');
    const r = parseFloat(rate);
    return slug && r ? `CDB-${slug}-${Math.round(r * 100)}` : '';
  }, [name, bank, rate]);

  async function calculate(): Promise<void> {
    setError('');
    setResult(null);
    setSuccess('');
    const r = parseFloat(rate);
    const value = parseFloat(invested);
    if (!r || !buyDate || !value) {
      setError('Preencha taxa, data da compra e valor aplicado.');
      return;
    }
    if (mode === 'manual' && !emission) {
      setError('Preencha a data de emissão, ou escolha outro modo.');
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
        note = 'título novo: PU de emissão 1000';
      } else if (mode === 'pu') {
        let target = parseFloat(puPaid);
        if (!target) {
          const q = parseFloat(qtyPaid);
          if (q) target = value / q;
        }
        if (!target) {
          throw new Error('Informe o PU pago ou a quantidade de títulos.');
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
        const quality = Math.abs(solved.diff) < 0.005 ? 'exata' : Math.abs(solved.diff) < 1 ? 'boa' : 'fraca — confira taxa e PU';
        note = `emissão descoberta de trás pra frente (precisão ${quality})`;
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
        note = `PU do dia útil seguinte (${settle})`;
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
      setError('Calcule primeiro e selecione a conta.');
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
        name: name.trim() || `${result.canonical} (${result.spec.kind === 'CDI' ? result.spec.ratePct + '% CDI' : result.spec.ratePct + '% a.a.'})`,
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
      const expected = result.grossToday.toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' });
      setSuccess(
        priced
          ? `CDB cadastrado e precificado: ${result.canonical}. Posição esperada: ${expected}`
          : `CDB cadastrado (${result.canonical}), mas nenhum preço chegou — confira o código do provider "${code}" e o override ${result.overrideSymbol} na aba Market Data do ativo.`
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
        <h1 className="text-2xl font-semibold">Cadastro de CDB</h1>
        <p className="text-sm text-muted-foreground">
          Calcula o PU pela série do CDI do Banco Central e cria a security + compra direto no Wealthfolio.
        </p>
      </div>

      <Card>
        <CardContent className="space-y-3 p-4">
          <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
            <div>
              <label className={labelCls}>Conta</label>
              <select className={field} value={accountId} onChange={(e) => setAccountId(e.target.value)}>
                {accounts.map((a) => (
                  <option key={a.id} value={a.id}>
                    {a.name}
                  </option>
                ))}
              </select>
            </div>
            <div>
              <label className={labelCls}>Indexador</label>
              <select className={field} value={kind} onChange={(e) => setKind(e.target.value as SymbolKind)}>
                <option value="CDI">% do CDI</option>
                <option value="PRE">% a.a. (prefixado)</option>
              </select>
            </div>
            <div>
              <label className={labelCls}>Taxa contratada</label>
              <input className={field} type="number" step="0.01" placeholder="100" value={rate} onChange={(e) => setRate(e.target.value)} />
            </div>
            <div>
              <label className={labelCls}>Banco (symbol)</label>
              <input className={field} placeholder="Banco C" value={bank} onChange={(e) => setBank(e.target.value)} />
            </div>
          </div>

          <div className="grid grid-cols-1 gap-3 md:grid-cols-3">
            <div>
              <label className={labelCls}>Como você aplicou?</label>
              <select className={field} value={mode} onChange={(e) => setMode(e.target.value as Mode)}>
                <option value="direct">Direto no banco (título novo)</option>
                <option value="pu">Título existente — sei o PU/quantidade</option>
                <option value="manual">Sei a data de emissão</option>
              </select>
            </div>
            <div>
              <label className={labelCls}>Data da compra</label>
              <input className={field} type="date" value={buyDate} onChange={(e) => setBuyDate(e.target.value)} />
            </div>
            <div>
              <label className={labelCls}>Valor aplicado (R$)</label>
              <input className={field} type="number" step="0.01" placeholder="5000.00" value={invested} onChange={(e) => setInvested(e.target.value)} />
            </div>
          </div>

          <div>
            <label className={labelCls}>Data de vencimento (opcional — cadastra o ativo como Bond, tipo correto de renda fixa)</label>
            <input className={field} type="date" value={maturityDate} onChange={(e) => setMaturityDate(e.target.value)} />
          </div>

          {mode === 'manual' && (
            <div>
              <label className={labelCls}>Data de emissão</label>
              <input className={field} type="date" value={emission} onChange={(e) => setEmission(e.target.value)} />
            </div>
          )}
          {mode === 'direct' && (
            <label className="flex items-center gap-2 text-xs text-muted-foreground">
              <input type="checkbox" checked={nextDay} onChange={(e) => setNextDay(e.target.checked)} />
              Minha aplicação começa a render só no dia útil seguinte
            </label>
          )}
          {mode === 'pu' && (
            <div className="grid grid-cols-2 gap-3">
              <div>
                <label className={labelCls}>PU pago (se souber)</label>
                <input className={field} type="number" step="0.00000001" placeholder="1023.61" value={puPaid} onChange={(e) => setPuPaid(e.target.value)} />
              </div>
              <div>
                <label className={labelCls}>…ou quantidade de títulos</label>
                <input className={field} type="number" step="0.00001" placeholder="4.88191" value={qtyPaid} onChange={(e) => setQtyPaid(e.target.value)} />
              </div>
            </div>
          )}

          <div>
            <label className={labelCls}>Nome do ativo (vira o código e o nome da security — ex.: Banco C Exclusivo Pós-fixado 1 ano)</label>
            <input className={field} placeholder="Banco C Exclusivo Pós-fixado 1 ano" value={name} onChange={(e) => setName(e.target.value)} />
          </div>

          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className={labelCls}>Provider custom (Market Data)</label>
              <input className={field} value={providerCode} onChange={(e) => setProviderCode(e.target.value)} />
            </div>
            <div>
              <label className={labelCls}>Banco (fallback do código)</label>
              <input className={field} placeholder="Banco C" value={bank} onChange={(e) => setBank(e.target.value)} />
            </div>
          </div>

          <button
            type="button"
            disabled={busy}
            onClick={() => void calculate()}
            className="rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-foreground disabled:opacity-50"
          >
            {busy ? 'Calculando…' : 'Calcular'}
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
              <span className="text-muted-foreground">Symbol canônico</span>
              <code className="font-mono">{result.canonical}</code>
            </div>
            <div className="flex justify-between">
              <span className="text-muted-foreground">Override do provider</span>
              <code className="font-mono">{result.overrideSymbol}</code>
            </div>
            <div className="flex justify-between">
              <span className="text-muted-foreground">Emissão</span>
              <span>{result.emission.split('-').reverse().join('/')}</span>
            </div>
            <div className="flex justify-between">
              <span className="text-muted-foreground">Tipo do ativo</span>
              <span>{maturityDate ? `Bond · vencimento ${maturityDate.split('-').reverse().join('/')}` : 'Equity'}</span>
            </div>
            <div className="flex justify-between">
              <span className="text-muted-foreground">PU pago</span>
              <span>{result.pu.toLocaleString('pt-BR', { maximumFractionDigits: 8 })}</span>
            </div>
            <div className="flex justify-between">
              <span className="text-muted-foreground">Quantidade de títulos</span>
              <span>{result.quantity.toFixed(5)}</span>
            </div>
            <div className="flex justify-between">
              <span className="text-muted-foreground">Valor bruto hoje (estimado)</span>
              <span>{result.grossToday.toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' })}</span>
            </div>
            <p className="text-xs text-muted-foreground">{result.note}</p>
            <button
              type="button"
              disabled={busy}
              onClick={() => void submit()}
              className="rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-foreground disabled:opacity-50"
            >
              {busy ? 'Criando…' : 'Cadastrar no Wealthfolio'}
            </button>
          </CardContent>
        </Card>
      )}
    </div>
  );
}
