package main

import (
	"context"
	"testing"
	"time"
)

// The solver must invert the fixtures: given the PU actually paid at the
// settlement date, it recovers the known emission (2026-07-13).
func TestSolveEmissionNeon(t *testing.T) {
	e := testEngine(t, fixtureRates(true))

	settlement, _ := time.Parse("2006-01-02", "2026-09-14")
	res, err := e.SolveEmission(context.Background(), KindCDI, 104.50, 1024.19875526, settlement)
	if err != nil {
		t.Fatal(err)
	}
	if res.Emission.Format("2006-01-02") != "2026-07-13" {
		t.Errorf("emission = %s, want 2026-07-13 (diff %g)", res.Emission.Format("2006-01-02"), res.Diff)
	}
	if abs(res.Diff) > 1e-6 {
		t.Errorf("diff = %g, want ~0", res.Diff)
	}
}

func TestSolveEmissionNeonTwoDecimalsInput(t *testing.T) {
	// Banks often show the PU with 2 decimals; the best match must still be
	// the right day (a daily step is ~0.5 PU).
	e := testEngine(t, fixtureRates(true))
	settlement, _ := time.Parse("2006-01-02", "2026-09-14")
	res, err := e.SolveEmission(context.Background(), KindCDI, 104.50, 1024.20, settlement)
	if err != nil {
		t.Fatal(err)
	}
	if res.Emission.Format("2006-01-02") != "2026-07-13" {
		t.Errorf("emission = %s, want 2026-07-13 (diff %g)", res.Emission.Format("2006-01-02"), res.Diff)
	}
}

func TestSolveEmissionXPPreFixed(t *testing.T) {
	e := testEngine(t, nil) // pre-fixed needs only the calendar
	settlement, _ := time.Parse("2006-01-02", "2026-09-14")
	res, err := e.SolveEmission(context.Background(), KindPRE, 14.30, 1023.611264, settlement)
	if err != nil {
		t.Fatal(err)
	}
	if res.Emission.Format("2006-01-02") != "2026-07-13" {
		t.Errorf("emission = %s, want 2026-07-13 (diff %g)", res.Emission.Format("2006-01-02"), res.Diff)
	}
}

func TestSolveEmissionEdgeCases(t *testing.T) {
	e := testEngine(t, fixtureRates(true))
	settlement, _ := time.Parse("2006-01-02", "2026-09-14")

	// PU == base: emission is the settlement date itself.
	res, err := e.SolveEmission(context.Background(), KindCDI, 104.50, 1000, settlement)
	if err != nil || !res.Emission.Equal(settlement) || res.Diff != 0 {
		t.Errorf("PU 1000 -> %+v err %v, want emission = settlement", res, err)
	}

	// Below base: rejected.
	if _, err := e.SolveEmission(context.Background(), KindCDI, 104.50, 999.5, settlement); err == nil {
		t.Error("PU below base accepted, want rejected")
	}
}
