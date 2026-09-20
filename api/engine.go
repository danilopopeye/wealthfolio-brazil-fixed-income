package main

import (
	"context"
	"errors"
	"log/slog"
	"math"
	"sync"
	"time"
)

// ErrNoRates means the CDI rates needed for the requested window are
// unavailable (source down and cache insufficient). Maps to HTTP 503.
var ErrNoRates = errors.New("CDI rates unavailable for the requested window")

// PUResult is a computed unit price for one valuation date.
type PUResult struct {
	Price float64
	// EstimatedDays is the number of trailing business days in the accrual
	// window that lack a confirmed rate (CETIP->SGS ingest lag). When it is
	// <= carryMax the last confirmed rate was carried forward for all of
	// them; when it exceeds carryMax the price simply stops accruing at the
	// last confirmed day (design D2).
	EstimatedDays int
}

type EngineConfig struct {
	CarryMax        int           // design D2, default 3
	RefreshInterval time.Duration // design item 1, default 30m
}

// Engine orchestrates cache, calendar, source and math. It knows nothing
// about investors: PU only (design D8).
type Engine struct {
	store   *RateStore
	cal     *Calendar
	fetcher Fetcher
	cfg     EngineConfig
	now     func() time.Time
	logger  *slog.Logger
	mu      sync.Mutex // guards the refresh decision
	lastAt  time.Time  // last fetch attempt
	lastOK  bool
	lastErr string
}

func NewEngine(store *RateStore, cal *Calendar, fetcher Fetcher, cfg EngineConfig, now func() time.Time, logger *slog.Logger) *Engine {
	if cfg.CarryMax <= 0 {
		cfg.CarryMax = 3
	}
	if cfg.RefreshInterval <= 0 {
		cfg.RefreshInterval = 30 * time.Minute
	}
	if now == nil {
		now = time.Now
	}
	if logger == nil {
		logger = slog.Default()
	}
	return &Engine{store: store, cal: cal, fetcher: fetcher, cfg: cfg, now: now, logger: logger}
}

// Today returns the current date (UTC midnight) in America/Sao_Paulo.
func (e *Engine) Today() time.Time {
	n := e.now().In(saoPaulo)
	return time.Date(n.Year(), n.Month(), n.Day(), 0, 0, 0, 0, time.UTC)
}

// SourceState exposes fetch diagnostics for /healthz.
type SourceState struct {
	OK      bool
	LastErr string
	LastTry time.Time
	FetchAt time.Time
}

func (e *Engine) SourceState() SourceState {
	e.mu.Lock()
	defer e.mu.Unlock()
	return SourceState{OK: e.lastOK, LastErr: e.lastErr, LastTry: e.lastAt, FetchAt: e.store.FetchedAt()}
}

// ensureRates refreshes the cache when the needed range is not covered or
// the refresh interval elapsed. A failing source never breaks the request:
// computation proceeds with the cache and surfaces the shortfall (503 via
// ErrNoRates) only if data is actually missing (design items 1 and D12).
func (e *Engine) ensureRates(ctx context.Context, needFrom time.Time) {
	e.mu.Lock()
	defer e.mu.Unlock()

	now := e.now()
	first, hasAny := e.store.First()
	var from time.Time
	need := false
	if !hasAny || needFrom.Before(first) {
		from = needFrom
		need = true
	} else if now.Sub(e.store.FetchedAt()) >= e.cfg.RefreshInterval {
		last, _, _ := e.store.Last()
		from = last.AddDate(0, 0, 1)
		need = true
	}
	if !need {
		return
	}
	// Throttle a dead source to one attempt per minute.
	if !e.lastAt.IsZero() && now.Sub(e.lastAt) < time.Minute && !e.lastOK {
		return
	}
	e.lastAt = now
	rates, err := e.fetcher.FetchCDI(ctx, from, e.Today())
	if err != nil {
		e.lastOK = false
		e.lastErr = err.Error()
		e.logger.Warn("CDI refresh failed; serving from cache", "error", err)
		return
	}
	e.lastOK = true
	e.lastErr = ""
	e.store.Merge(rates)
	e.store.MarkFetched(now)
	if err := e.store.Save(); err != nil {
		e.logger.Error("saving CDI cache failed", "error", err)
	}
}

// PU computes the gross unit price of the title at valuation date d
// (UTC midnight), with the accrual window [emission, d) [fixture].
func (e *Engine) PU(ctx context.Context, sym Symbol, d time.Time) (PUResult, error) {
	if sym.Kind == KindPRE {
		return e.preFixed(sym, d), nil
	}
	return e.postFixed(ctx, sym, d)
}

// preFixed: PU = 1000 * (1 + rate/100)^(n/252), n = business days in
// [emission, d). Needs no rates at all — only the calendar [fixture].
func (e *Engine) preFixed(sym Symbol, d time.Time) PUResult {
	n := e.cal.BusinessDaysBetween(sym.Emission, d)
	return PUResult{Price: 1000 * math.Pow(1+sym.RatePct/100, float64(n)/252)}
}

// postFixed: PU = 1000 * product of (1 + pct * cdi_k) over each business
// day k in [emission, d), using confirmed rates; trailing missing days are
// carried forward up to carryMax (design D2).
func (e *Engine) postFixed(ctx context.Context, sym Symbol, d time.Time) (PUResult, error) {
	e.ensureRates(ctx, sym.Emission)

	last, lastRate, hasAny := e.store.Last()
	if !hasAny {
		return PUResult{}, ErrNoRates
	}

	factor := 1.0
	for day := e.cal.FirstBusinessDayOnOrAfter(sym.Emission); day.Before(d); day = e.cal.NextBusinessDay(day) {
		v, ok := e.store.Get(day)
		if !ok {
			if day.After(last) {
				continue // trailing gap, handled below
			}
			return PUResult{}, ErrNoRates
		}
		factor *= 1 + (sym.RatePct/100)*(v/100)
	}

	// Trailing gap: business days inside the window that are after the
	// last confirmed rate (CETIP->SGS lag).
	gapFrom := sym.Emission
	if after := last.AddDate(0, 0, 1); after.After(gapFrom) {
		gapFrom = after
	}
	gap := e.cal.BusinessDaysBetween(gapFrom, d)
	if gap > 0 && gap <= e.cfg.CarryMax {
		factor *= math.Pow(1+(sym.RatePct/100)*(lastRate/100), float64(gap))
	}
	return PUResult{Price: 1000 * factor, EstimatedDays: gap}, nil
}

// History returns one row per business day D in [from, to] (inclusive),
// each priced with the window [emission, D). Callers must pre-clamp
// from >= emission and to <= today.
func (e *Engine) History(ctx context.Context, sym Symbol, from, to time.Time) (dates []string, prices []float64, estimated int, err error) {
	dates = []string{}
	prices = []float64{}
	for d := e.cal.FirstBusinessDayOnOrAfter(from); !d.After(to); d = e.cal.NextBusinessDay(d) {
		res, err := e.PU(ctx, sym, d)
		if err != nil {
			return nil, nil, 0, err
		}
		dates = append(dates, d.Format("2006-01-02"))
		prices = append(prices, res.Price)
		estimated = res.EstimatedDays
	}
	return dates, prices, estimated, nil
}
