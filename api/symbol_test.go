package main

import (
	"testing"
	"time"
)

var today2026 = time.Date(2026, 9, 20, 0, 0, 0, 0, time.UTC)

func TestParseSymbolValid(t *testing.T) {
	sym, err := ParseSymbol("CDI-104.50-20260713", today2026)
	if err != nil {
		t.Fatal(err)
	}
	if sym.Kind != KindCDI || sym.RatePct != 104.5 {
		t.Errorf("got %v %v", sym.Kind, sym.RatePct)
	}
	want := time.Date(2026, 7, 13, 0, 0, 0, 0, time.UTC)
	if !sym.Emission.Equal(want) {
		t.Errorf("emission = %v, want %v", sym.Emission, want)
	}

	sym, err = ParseSymbol("PRE-14.30-20260713", today2026)
	if err != nil {
		t.Fatal(err)
	}
	if sym.Kind != KindPRE || sym.RatePct != 14.3 {
		t.Errorf("got %v %v", sym.Kind, sym.RatePct)
	}

	if _, err := ParseSymbol("PRE-999.99-20200101", today2026); err != nil {
		t.Errorf("edge max rate rejected: %v", err)
	}
}

func TestParseSymbolInvalid(t *testing.T) {
	bad := []string{
		"cdi-104.50-20260713",   // lowercase
		"CDI-104.5-20260713",    // one decimal
		"CDI-104.500-20260713",  // three decimals
		"CDI-10450-20260713",    // no decimals
		"CDI-000.00-20260713",   // zero rate
		"LCA-104.50-20260713",   // unknown prefix
		"CDI-104.50-20260231",   // impossible date (Feb 31)
		"CDI-104.50-20270101",   // emission in the future
		"CDI-104.50-202607130",  // 9-digit date
		" CDI-104.50-20260713 ", // spaces are trimmed by the handler, not here
		"",
	}
	for _, s := range bad {
		if _, err := ParseSymbol(s, today2026); err == nil {
			t.Errorf("ParseSymbol(%q) accepted, want rejected", s)
		}
	}
}
