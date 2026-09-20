package main

import (
	"os"
	"testing"
	"time"
)

func d(s string) time.Time {
	p, err := time.Parse("2006-01-02", s)
	if err != nil {
		panic(err)
	}
	return p
}

func TestCalendarHolidays(t *testing.T) {
	cal, err := NewCalendar("")
	if err != nil {
		t.Fatal(err)
	}

	business := []string{
		"2026-09-14", // Monday
		"2026-09-18", // Friday
		"2026-02-18", // Ash Wednesday 2026 — CDI operates (empirical)
		"2023-11-20", // before Lei 14.759/2023
		"2024-11-21", // day after the new holiday
	}
	nonBusiness := []string{
		"2026-09-19", // Saturday
		"2026-09-20", // Sunday
		"2026-09-07", // Independence Day (Monday, fixture)
		"2026-02-16", // carnaval Monday 2026 (empirical)
		"2026-02-17", // carnaval Tuesday 2026
		"2025-03-03", // carnaval Monday 2025
		"2025-03-04", // carnaval Tuesday 2025
		"2024-02-12", // carnaval Monday 2024
		"2024-02-13", // carnaval Tuesday 2024
		"2024-03-29", // Good Friday 2024
		"2024-05-30", // Corpus Christi 2024
		"2024-11-20", // Consciencia Negra (national from 2024)
		"2023-04-07", // Good Friday 2023
	}
	for _, s := range business {
		if !cal.IsBusinessDay(d(s)) {
			t.Errorf("%s should be a business day", s)
		}
	}
	for _, s := range nonBusiness {
		if cal.IsBusinessDay(d(s)) {
			t.Errorf("%s should NOT be a business day", s)
		}
	}
}

func TestCalendarExtrasFile(t *testing.T) {
	dir := t.TempDir()
	path := dir + "/extras.txt"
	if err := os.WriteFile(path, []byte("# extra holiday\n2026-10-15\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	cal, err := NewCalendar(path)
	if err != nil {
		t.Fatal(err)
	}
	if cal.IsBusinessDay(d("2026-10-15")) {
		t.Error("extra holiday from file not applied")
	}
	if !cal.IsBusinessDay(d("2026-10-16")) {
		t.Error("day after extra holiday must remain a business day")
	}
}

func TestBusinessDaysBetween(t *testing.T) {
	cal, _ := NewCalendar("")
	cases := []struct {
		a, b string
		want int
	}{
		{"2026-07-13", "2026-09-14", 44}, // Banco B/Banco A fixture count
		{"2026-07-13", "2026-09-19", 49}, // through Friday 18/09
		{"2026-07-13", "2026-07-13", 0},  // empty window
		{"2026-09-18", "2026-09-21", 1},  // Fri -> Mon over weekend
		{"2026-09-18", "2026-09-20", 1},  // carry-gap reference: BDs in (last, D)
	}
	for _, c := range cases {
		if got := cal.BusinessDaysBetween(d(c.a), d(c.b)); got != c.want {
			t.Errorf("BusinessDaysBetween(%s, %s) = %d, want %d", c.a, c.b, got, c.want)
		}
	}
}
