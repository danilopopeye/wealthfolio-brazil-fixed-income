package main

import (
	"fmt"
	"regexp"
	"strconv"
	"time"
)

// Symbol kinds: CDI- (post-fixed, % of CDI) and PRE- (pre-fixed, % a.a.).
type SymbolKind string

const (
	KindCDI SymbolKind = "CDI"
	KindPRE SymbolKind = "PRE"
)

// Symbol carries only the title parameters: indexer, contracted rate and
// emission date. Purchase data (quantity, price paid) lives in Wealthfolio.
type Symbol struct {
	Raw      string
	Kind     SymbolKind
	RatePct  float64   // 104.50 -> 104.50% of CDI; 14.30 -> 14.30% a.a.
	Emission time.Time // date only, UTC midnight
}

// Grammar (design D5, relaxed in Fase 5 after real-usage friction):
// the rate accepts an integer form (CDI-100-20251226) or exactly two
// decimals (CDI-104.50-20260713); anything else is rejected as ambiguous.
var symbolRe = regexp.MustCompile(`^(CDI|PRE)-(\d{1,3})(?:\.(\d{2}))?-(\d{8})$`)

// ParseSymbol validates and parses a symbol string. today must be the
// current date (UTC midnight) in America/Sao_Paulo; emissions in the
// future are rejected.
func ParseSymbol(raw string, today time.Time) (Symbol, error) {
	m := symbolRe.FindStringSubmatch(raw)
	if m == nil {
		return Symbol{}, fmt.Errorf(
			"invalid symbol %q: want CDI-100-20251226, CDI-104.50-20260713 or PRE-14.30-20260713", raw,
		)
	}
	emission, err := time.Parse("20060102", m[4])
	if err != nil {
		return Symbol{}, fmt.Errorf("invalid emission date in symbol %q", raw)
	}
	intPart, _ := strconv.Atoi(m[2])
	frac := 0
	if m[3] != "" {
		frac, _ = strconv.Atoi(m[3])
	}
	rate := float64(intPart) + float64(frac)/100
	if rate <= 0 {
		return Symbol{}, fmt.Errorf("rate must be positive in symbol %q", raw)
	}
	if emission.After(today) {
		return Symbol{}, fmt.Errorf("emission date in the future in symbol %q", raw)
	}
	return Symbol{Raw: raw, Kind: SymbolKind(m[1]), RatePct: rate, Emission: emission}, nil
}
