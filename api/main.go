// cdbapi serves unit prices (PU) of Brazilian CDBs to the Wealthfolio
// custom market data provider. Stateless regarding investments: symbol
// parameters plus the CDI series become a PU (docs/bootstrap.md).
package main

import (
	"context"
	"flag"
	"fmt"
	"log/slog"
	"net/http"
	"os"
	"os/signal"
	"strconv"
	"syscall"
	"time"
	_ "time/tzdata" // embed tz database (America/Sao_Paulo)
)

type config struct {
	ListenAddr      string
	APIKey          string
	CachePath       string
	SGSBaseURL      string
	RefreshInterval time.Duration
	CarryMax        int
	HolidaysPath    string
}

func loadConfig() config {
	return config{
		ListenAddr:      envOr("LISTEN_ADDR", ":8080"),
		APIKey:          os.Getenv("API_KEY"),
		CachePath:       envOr("CACHE_PATH", "cache/cdi.json"),
		SGSBaseURL:      envOr("SGS_BASE_URL", defaultSGSBaseURL),
		RefreshInterval: envDurationOr("REFRESH_MIN_INTERVAL", 30*time.Minute),
		CarryMax:        envIntOr("CARRY_FORWARD_MAX", 3),
		HolidaysPath:    os.Getenv("HOLIDAYS_PATH"),
	}
}

func envOr(name, def string) string {
	if v := os.Getenv(name); v != "" {
		return v
	}
	return def
}

func envDurationOr(name string, def time.Duration) time.Duration {
	if v := os.Getenv(name); v != "" {
		if d, err := time.ParseDuration(v); err == nil {
			return d
		}
	}
	return def
}

func envIntOr(name string, def int) int {
	if v := os.Getenv(name); v != "" {
		if n, err := strconv.Atoi(v); err == nil {
			return n
		}
	}
	return def
}

func main() {
	logger := slog.New(slog.NewTextHandler(os.Stderr, nil))
	slog.SetDefault(logger)

	// Subcommand: holidays-check FROM TO — diffs the computed calendar
	// against the real series 12 (maintenance tool for design D3).
	if len(os.Args) > 1 && os.Args[1] == "holidays-check" {
		fs := flag.NewFlagSet("holidays-check", flag.ExitOnError)
		from := fs.String("from", time.Now().AddDate(-3, 0, 0).Format("2006-01-02"), "start date YYYY-MM-DD")
		to := fs.String("to", time.Now().Format("2006-01-02"), "end date YYYY-MM-DD")
		_ = fs.Parse(os.Args[2:])
		os.Exit(runHolidaysCheck(*from, *to))
	}

	cfg := loadConfig()

	cal, err := NewCalendar(cfg.HolidaysPath)
	if err != nil {
		logger.Error("loading holidays", "error", err)
		os.Exit(1)
	}
	store := LoadRateStore(cfg.CachePath)
	fetcher := NewSGSFetcher(cfg.SGSBaseURL, 5*time.Second)
	engine := NewEngine(store, cal, fetcher, EngineConfig{
		CarryMax:        cfg.CarryMax,
		RefreshInterval: cfg.RefreshInterval,
	}, time.Now, logger)

	srv := &http.Server{
		Addr:              cfg.ListenAddr,
		Handler:           NewServer(engine, cfg.APIKey, logger).Routes(),
		ReadHeaderTimeout: 5 * time.Second,
	}

	go func() {
		logger.Info("cdbapi listening",
			"addr", cfg.ListenAddr,
			"cache", cfg.CachePath,
			"observations", store.Count(),
			"apiKey", cfg.APIKey != "",
		)
		if err := srv.ListenAndServe(); err != nil && err != http.ErrServerClosed {
			logger.Error("server error", "error", err)
			os.Exit(1)
		}
	}()

	stop := make(chan os.Signal, 1)
	signal.Notify(stop, os.Interrupt, syscall.SIGTERM)
	<-stop
	logger.Info("shutting down")
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	_ = srv.Shutdown(ctx)
}

// runHolidaysCheck reports any day where the computed calendar disagrees
// with the published CDI series: "missing obs" (calendar says business day
// but no observation) and "extra obs" (calendar says holiday/weekend but
// an observation exists).
func runHolidaysCheck(fromStr, toStr string) int {
	from, err1 := time.Parse("2006-01-02", fromStr)
	to, err2 := time.Parse("2006-01-02", toStr)
	if err1 != nil || err2 != nil {
		fmt.Fprintln(os.Stderr, "usage: cdbapi holidays-check -from YYYY-MM-DD -to YYYY-MM-DD")
		return 2
	}
	cal, err := NewCalendar("")
	if err != nil {
		fmt.Fprintln(os.Stderr, "calendar:", err)
		return 2
	}
	fetcher := NewSGSFetcher("", 10*time.Second)
	rates, err := fetcher.FetchCDI(context.Background(), from, to)
	if err != nil {
		fmt.Fprintln(os.Stderr, "fetch:", err)
		return 2
	}
	obs := make(map[string]bool, len(rates))
	for _, r := range rates {
		obs[r.Date.Format("2006-01-02")] = true
	}
	bad := 0
	for d := from; !d.After(to); d = d.AddDate(0, 0, 1) {
		key := d.Format("2006-01-02")
		has := obs[key]
		expect := cal.IsBusinessDay(d)
		if expect && !has {
			fmt.Printf("missing obs %s (calendar says business day)\n", key)
			bad++
		}
		if !expect && has {
			fmt.Printf("extra obs %s (calendar says non-business day)\n", key)
			bad++
		}
	}
	fmt.Printf("checked %s..%s: %d observations, %d mismatches\n",
		fromStr, toStr, len(rates), bad)
	if bad > 0 {
		return 1
	}
	return 0
}
