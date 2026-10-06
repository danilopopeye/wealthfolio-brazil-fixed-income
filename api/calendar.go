package main

import (
	"bufio"
	"os"
	"strings"
	"time"
)

// Calendar answers "is this a business day?" for the CDI market:
// Saturdays/Sundays plus the Brazilian national/ANBIMA banking holidays.
//
// Holidays are computed for every year in [2000, 2100] from the holiday law
// (fixed dates plus the Easter-based movable ones) — empirically validated
// against SGS series 12 for 2023-2026 (docs/03-validacao.md, fixture 3, and
// the holidays-check subcommand). Notable banking convention discovered in
// that diff: carnaval is Monday+Tuesday (Easter-48/Easter-47); Ash
// Wednesday is a business day for the CDI market.
//
// An optional extras file (one YYYY-MM-DD per line, # comments allowed)
// merges additional dates for future ANBIMA changes without a rebuild.
type Calendar struct {
	holidays map[string]struct{}
}

const calendarMinYear = 2000
const calendarMaxYear = 2100

func NewCalendar(extrasPath string) (*Calendar, error) {
	c := &Calendar{holidays: make(map[string]struct{})}
	for y := calendarMinYear; y <= calendarMaxYear; y++ {
		for _, d := range nationalHolidays(y) {
			c.holidays[d] = struct{}{}
		}
	}
	if extrasPath != "" {
		f, err := os.Open(extrasPath)
		if err != nil {
			if !os.IsNotExist(err) {
				return nil, err
			}
		} else {
			defer f.Close()
			sc := bufio.NewScanner(f)
			for sc.Scan() {
				line := strings.TrimSpace(sc.Text())
				if line == "" || strings.HasPrefix(line, "#") {
					continue
				}
				if _, err := time.Parse("2006-01-02", line); err == nil {
					c.holidays[line] = struct{}{}
				}
			}
			if err := sc.Err(); err != nil {
				return nil, err
			}
		}
	}
	return c, nil
}

// nationalHolidays returns the Mon-Fri relevant national holidays for a
// year as YYYY-MM-DD strings (weekend occurrences are harmless: the
// weekday check already excludes them).
func nationalHolidays(year int) []string {
	e := easter(year)
	fixed := []string{
		"01-01", // Confraternizacao Universal
		"04-21", // Tiradentes
		"05-01", // Trabalho
		"09-07", // Independencia
		"10-12", // Nossa Senhora Aparecida
		"11-02", // Finados
		"11-15", // Proclamacao da Republica
		"12-25", // Natal
	}
	if year >= 2024 { // Lei 14.759/2023 (Consciencia Negra)
		fixed = append(fixed, "11-20")
	}
	out := make([]string, 0, len(fixed)+4)
	ys := itoa4(year)
	for _, md := range fixed {
		out = append(out, ys+"-"+md)
	}
	out = append(out,
		ys+"-"+md(easterShift(e, -48)), // carnaval Monday
		ys+"-"+md(easterShift(e, -47)), // carnaval Tuesday
		ys+"-"+md(easterShift(e, -2)),  // Sexta-feira Santa
		ys+"-"+md(easterShift(e, 60)),  // Corpus Christi
	)
	return out
}

func easterShift(e time.Time, days int) time.Time { return e.AddDate(0, 0, days) }

func itoa4(y int) string {
	b := []byte{
		byte('0' + y/1000%10),
		byte('0' + y/100%10),
		byte('0' + y/10%10),
		byte('0' + y%10),
	}
	return string(b)
}

func md(t time.Time) string { return t.Format("01-02") }

// easter computes Easter Sunday (Anonymous Gregorian algorithm).
func easter(year int) time.Time {
	a := year % 19
	b := year / 100
	c := year % 100
	d := b / 4
	e := b % 4
	f := (b + 8) / 25
	g := (b - f + 1) / 3
	h := (19*a + b - d - g + 15) % 30
	i := c / 4
	k := c % 4
	l := (32 + 2*e + 2*i - h - k) % 7
	m := (a + 11*h + 22*l) / 451
	month := (h + l - 7*m + 114) / 31
	day := (h+l-7*m+114)%31 + 1
	return time.Date(year, time.Month(month), day, 0, 0, 0, 0, time.UTC)
}

func (c *Calendar) IsBusinessDay(d time.Time) bool {
	switch d.Weekday() {
	case time.Saturday, time.Sunday:
		return false
	}
	_, holiday := c.holidays[d.Format("2006-01-02")]
	return !holiday
}

// FirstBusinessDayOnOrAfter returns the first business day >= d.
func (c *Calendar) FirstBusinessDayOnOrAfter(d time.Time) time.Time {
	for !c.IsBusinessDay(d) {
		d = d.AddDate(0, 0, 1)
	}
	return d
}

// NextBusinessDay returns the first business day strictly after d.
func (c *Calendar) NextBusinessDay(d time.Time) time.Time {
	return c.FirstBusinessDayOnOrAfter(d.AddDate(0, 0, 1))
}

// PrevBusinessDay returns the last business day strictly before d.
func (c *Calendar) PrevBusinessDay(d time.Time) time.Time {
	t := d.AddDate(0, 0, -1)
	for !c.IsBusinessDay(t) {
		t = t.AddDate(0, 0, -1)
	}
	return t
}

// BusinessDaysBetween counts business days in [a, b).
func (c *Calendar) BusinessDaysBetween(a, b time.Time) int {
	if !b.After(a) {
		return 0
	}
	n := 0
	for d := c.FirstBusinessDayOnOrAfter(a); d.Before(b); d = c.NextBusinessDay(d) {
		n++
	}
	return n
}
