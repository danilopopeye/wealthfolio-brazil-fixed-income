package main

import (
	"context"
	"errors"
	"path/filepath"
	"strconv"
	"strings"
	"testing"
	"time"
)

// Real CDI rates (SGS series 12) for [2026-07-13, 2026-09-17] captured on
// 2026-09-20, plus the retro-inferred 2026-09-18 (0.050788) that the
// series had not published yet (docs/01-investigacao.md, H1). These are
// the acceptance fixtures from docs/bootstrap.md.
const fixtureRates2026Raw = `2026-07-13 0.052531
2026-07-14 0.052531
2026-07-15 0.052531
2026-07-16 0.052531
2026-07-17 0.052531
2026-07-20 0.052531
2026-07-21 0.052531
2026-07-22 0.052531
2026-07-23 0.052531
2026-07-24 0.052531
2026-07-27 0.052531
2026-07-28 0.052531
2026-07-29 0.052531
2026-07-30 0.052531
2026-07-31 0.052531
2026-08-03 0.052531
2026-08-04 0.052531
2026-08-05 0.052531
2026-08-06 0.051660
2026-08-07 0.051660
2026-08-10 0.051660
2026-08-11 0.051660
2026-08-12 0.051660
2026-08-13 0.051660
2026-08-14 0.051660
2026-08-17 0.051660
2026-08-18 0.051660
2026-08-19 0.051660
2026-08-20 0.051660
2026-08-21 0.051660
2026-08-24 0.051660
2026-08-25 0.051660
2026-08-26 0.051660
2026-08-27 0.051660
2026-08-28 0.051660
2026-08-31 0.051660
2026-09-01 0.051660
2026-09-02 0.051660
2026-09-03 0.051660
2026-09-04 0.051660
2026-09-08 0.051660
2026-09-09 0.051660
2026-09-10 0.051660
2026-09-11 0.051660
2026-09-14 0.051660
2026-09-15 0.051660
2026-09-16 0.051660
2026-09-17 0.050788
2026-09-18 0.050788`

func fixtureRates(includeSep18 bool) []Rate {
	var out []Rate
	for _, line := range strings.Split(fixtureRates2026Raw, "\n") {
		if !includeSep18 && strings.HasPrefix(line, "2026-09-18") {
			continue
		}
		parts := strings.Fields(line)
		d, err := time.Parse("2006-01-02", parts[0])
		if err != nil {
			panic(err)
		}
		v, err := strconv.ParseFloat(parts[1], 64)
		if err != nil {
			panic(err)
		}
		out = append(out, Rate{Date: d, Value: v})
	}
	return out
}

// fakeFetcher simulates the SGS source (offline by default).
type fakeFetcher struct {
	err   error
	rates []Rate
	calls int
}

func (f *fakeFetcher) FetchCDI(_ context.Context, _, _ time.Time) ([]Rate, error) {
	f.calls++
	if f.err != nil {
		return nil, f.err
	}
	return f.rates, nil
}

var testNow = time.Date(2026, 9, 20, 12, 0, 0, 0, time.UTC) // Sunday

func testEngine(tb testing.TB, rates []Rate) *Engine {
	tb.Helper()
	store := LoadRateStore(filepath.Join(tb.TempDir(), "cdi.json"))
	store.Merge(rates)
	store.MarkFetched(testNow)
	cal, err := NewCalendar("")
	if err != nil {
		tb.Fatal(err)
	}
	return NewEngine(store, cal, &fakeFetcher{err: errors.New("offline")},
		EngineConfig{CarryMax: 3, RefreshInterval: 30 * time.Minute},
		func() time.Time { return testNow }, nil)
}

const tol = 1e-6

func mustSymbol(tb testing.TB, raw string) Symbol {
	tb.Helper()
	sym, err := ParseSymbol(raw, testNow.In(saoPaulo))
	if err != nil {
		tb.Fatal(err)
	}
	return sym
}

// The four real readings from docs/bootstrap.md.
func TestFixtureNeonPostFixed(t *testing.T) {
	e := testEngine(t, fixtureRates(true))
	neon := mustSymbol(t, "CDI-104.50-20260713")

	cases := []struct {
		d    string
		want float64
	}{
		{"2026-09-14", 1024.19875526},
		{"2026-09-20", 1026.9475888},
	}
	for _, c := range cases {
		d, _ := time.Parse("2006-01-02", c.d)
		res, err := e.PU(context.Background(), neon, d)
		if err != nil {
			t.Fatalf("PU(%s): %v", c.d, err)
		}
		if diff := res.Price - c.want; diff > tol || diff < -tol {
			t.Errorf("PU(%s) = %.8f, want %.8f (diff %g)", c.d, res.Price, c.want, diff)
		}
	}
}

func TestFixtureNeonCarryForward(t *testing.T) {
	// Cache ending at 2026-09-17 (what series 12 actually served on
	// Sunday 2026-09-20): the trailing 18/09 must be carried forward.
	e := testEngine(t, fixtureRates(false))
	neon := mustSymbol(t, "CDI-104.50-20260713")

	d, _ := time.Parse("2006-01-02", "2026-09-20")
	res, err := e.PU(context.Background(), neon, d)
	if err != nil {
		t.Fatal(err)
	}
	if diff := res.Price - 1026.9475888; diff > tol || diff < -tol {
		t.Errorf("carried PU = %.8f, want 1026.9475888 (diff %g)", res.Price, diff)
	}
	if res.EstimatedDays != 1 {
		t.Errorf("EstimatedDays = %d, want 1", res.EstimatedDays)
	}
}

func TestFixtureXPPreFixed(t *testing.T) {
	e := testEngine(t, nil) // pre-fixed needs no rates at all
	xp := mustSymbol(t, "PRE-14.30-20260713")

	cases := []struct {
		d    string
		want float64
	}{
		{"2026-09-14", 1023.611264},
		{"2026-09-19", 1026.329393},
	}
	for _, c := range cases {
		d, _ := time.Parse("2006-01-02", c.d)
		res, err := e.PU(context.Background(), xp, d)
		if err != nil {
			t.Fatalf("PU(%s): %v", c.d, err)
		}
		if diff := res.Price - c.want; diff > tol || diff < -tol {
			t.Errorf("PU(%s) = %.8f, want %.8f (diff %g)", c.d, res.Price, c.want, diff)
		}
	}
}

func TestPUAtEmissionAndBefore(t *testing.T) {
	e := testEngine(t, fixtureRates(true))
	neon := mustSymbol(t, "CDI-104.50-20260713")

	em, _ := time.Parse("2006-01-02", "2026-07-13")
	res, err := e.PU(context.Background(), neon, em)
	if err != nil {
		t.Fatal(err)
	}
	if res.Price != 1000 {
		t.Errorf("PU(emission) = %v, want 1000", res.Price)
	}
}

func TestPostFixedNoRatesIs503(t *testing.T) {
	e := testEngine(t, nil)
	neon := mustSymbol(t, "CDI-104.50-20260713")
	d, _ := time.Parse("2006-01-02", "2026-09-14")
	if _, err := e.PU(context.Background(), neon, d); !errors.Is(err, ErrNoRates) {
		t.Errorf("err = %v, want ErrNoRates", err)
	}
}
