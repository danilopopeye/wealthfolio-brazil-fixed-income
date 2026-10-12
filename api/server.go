package main

import (
	"crypto/subtle"
	"encoding/json"
	"errors"
	"log/slog"
	"net/http"
	"strconv"
	"strings"
	"time"
)

var saoPaulo = mustLoadSaoPaulo()

func mustLoadSaoPaulo() *time.Location {
	loc, err := time.LoadLocation("America/Sao_Paulo")
	if err != nil {
		panic("America/Sao_Paulo timezone unavailable (time/tzdata missing)")
	}
	return loc
}

type Server struct {
	engine *Engine
	apiKey string
	logger *slog.Logger
}

func NewServer(engine *Engine, apiKey string, logger *slog.Logger) *Server {
	if logger == nil {
		logger = slog.Default()
	}
	return &Server{engine: engine, apiKey: apiKey, logger: logger}
}

func (s *Server) Routes() http.Handler {
	mux := http.NewServeMux()
	mux.HandleFunc("GET /healthz", s.handleHealth)
	mux.Handle("GET /pu/{symbol}", s.auth(http.HandlerFunc(s.handlePU)))
	mux.Handle("GET /history/{symbol}", s.auth(http.HandlerFunc(s.handleHistory)))
	mux.Handle("GET /solve/emission", s.auth(http.HandlerFunc(s.handleSolveEmission)))
	return s.logMiddleware(mux)
}

// --- handlers ---------------------------------------------------------------

func (s *Server) handleHealth(w http.ResponseWriter, r *http.Request) {
	src := s.engine.SourceState()
	status := "ok"
	if !src.OK && src.LastErr != "" {
		status = "degraded"
	}
	lastDate, lastRate, has := s.engine.store.Last()
	resp := map[string]any{
		"status": status,
		"cdi": map[string]any{
			"lastDate": nil,
			"lastRate": nil,
		},
		"cache": map[string]any{
			"observations": s.engine.store.Count(),
			"fetchedAt":    src.FetchAt,
		},
		"source": map[string]any{
			"ok":          src.OK,
			"lastError":   src.LastErr,
			"lastAttempt": src.LastTry,
		},
	}
	if has {
		resp["cdi"] = map[string]any{
			"lastDate": lastDate.Format("2006-01-02"),
			"lastRate": lastRate,
		}
	}
	writeJSON(w, http.StatusOK, resp)
}

func (s *Server) handlePU(w http.ResponseWriter, r *http.Request) {
	sym, ok := s.parseSymbol(w, r)
	if !ok {
		return
	}
	d := s.engine.Today()
	res, err := s.engine.PU(r.Context(), sym, d)
	if err != nil {
		s.writeEngineError(w, err)
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{
		"symbol":        sym.Raw,
		"date":          d.Format("2006-01-02"),
		"price":         res.Price,
		"currency":      "BRL",
		"estimatedDays": res.EstimatedDays,
	})
}

func (s *Server) handleHistory(w http.ResponseWriter, r *http.Request) {
	sym, ok := s.parseSymbol(w, r)
	if !ok {
		return
	}
	today := s.engine.Today()

	from, to := sym.Emission, today
	var err error
	if v := r.URL.Query().Get("from"); v != "" {
		if from, err = time.Parse("2006-01-02", v); err != nil {
			writeError(w, http.StatusBadRequest, "invalid 'from' date (want YYYY-MM-DD)")
			return
		}
	}
	if v := r.URL.Query().Get("to"); v != "" {
		if to, err = time.Parse("2006-01-02", v); err != nil {
			writeError(w, http.StatusBadRequest, "invalid 'to' date (want YYYY-MM-DD)")
			return
		}
	}
	if from.After(to) {
		writeError(w, http.StatusBadRequest, "'from' after 'to'")
		return
	}
	// Clamps (design D6): pre-emission from clamps to the emission; a
	// post-clamp empty window (e.g. to < emission) is a valid empty answer.
	if from.Before(sym.Emission) {
		from = sym.Emission
	}
	if to.After(today) {
		to = today
	}

	dates, prices, estimated, err := s.engine.History(r.Context(), sym, from, to)
	if err != nil {
		s.writeEngineError(w, err)
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{
		"symbol":        sym.Raw,
		"currency":      "BRL",
		"from":          from.Format("2006-01-02"),
		"to":            to.Format("2006-01-02"),
		"dates":         dates,
		"prices":        prices,
		"estimatedDays": estimated,
	})
}

// --- helpers ----------------------------------------------------------------

func (s *Server) handleSolveEmission(w http.ResponseWriter, r *http.Request) {
	q := r.URL.Query()
	kindStr := q.Get("kind")
	if kindStr != string(KindCDI) && kindStr != string(KindPRE) {
		writeError(w, http.StatusBadRequest, "'kind' must be CDI or PRE")
		return
	}
	rate, err := strconv.ParseFloat(q.Get("rate"), 64)
	if err != nil || rate <= 0 || rate > 999.99 {
		writeError(w, http.StatusBadRequest, "invalid 'rate'")
		return
	}
	pu, err := strconv.ParseFloat(q.Get("pu"), 64)
	if err != nil || pu <= 0 {
		writeError(w, http.StatusBadRequest, "invalid 'pu'")
		return
	}
	settlement, err := time.Parse("2006-01-02", q.Get("settlement"))
	if err != nil {
		writeError(w, http.StatusBadRequest, "invalid 'settlement' (want YYYY-MM-DD)")
		return
	}
	if settlement.After(s.engine.Today()) {
		writeError(w, http.StatusBadRequest, "'settlement' in the future")
		return
	}

	res, err := s.engine.SolveEmission(r.Context(), SymbolKind(kindStr), rate, pu, settlement)
	if err != nil {
		if errors.Is(err, ErrNoRates) {
			writeError(w, http.StatusServiceUnavailable, err.Error())
			return
		}
		writeError(w, http.StatusBadRequest, err.Error())
		return
	}
	match := "poor"
	if abs(res.Diff) < 0.005 {
		match = "exact"
	} else if abs(res.Diff) < 1 {
		match = "good"
	}
	writeJSON(w, http.StatusOK, map[string]any{
		"kind":       kindStr,
		"rate":       rate,
		"settlement": settlement.Format("2006-01-02"),
		"targetPu":   pu,
		"emission":   res.Emission.Format("2006-01-02"),
		"pu":         res.PU,
		"diff":       res.Diff,
		"match":      match,
	})
}

func (s *Server) parseSymbol(w http.ResponseWriter, r *http.Request) (Symbol, bool) {
	raw := strings.TrimSpace(r.PathValue("symbol"))
	sym, err := ParseSymbol(raw, s.engine.Today())
	if err != nil {
		writeError(w, http.StatusBadRequest, err.Error())
		return Symbol{}, false
	}
	return sym, true
}

func (s *Server) writeEngineError(w http.ResponseWriter, err error) {
	if errors.Is(err, ErrNoRates) {
		writeError(w, http.StatusServiceUnavailable, err.Error())
		return
	}
	writeError(w, http.StatusInternalServerError, err.Error())
}

func (s *Server) auth(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if s.apiKey != "" {
			got := r.Header.Get("X-API-Key")
			if subtle.ConstantTimeCompare([]byte(got), []byte(s.apiKey)) != 1 {
				writeError(w, http.StatusUnauthorized, "invalid or missing X-API-Key")
				return
			}
		}
		next.ServeHTTP(w, r)
	})
}

type statusWriter struct {
	http.ResponseWriter
	status int
}

func (sw *statusWriter) WriteHeader(code int) {
	sw.status = code
	sw.ResponseWriter.WriteHeader(code)
}

func (s *Server) logMiddleware(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		sw := &statusWriter{ResponseWriter: w, status: http.StatusOK}
		start := time.Now()
		next.ServeHTTP(sw, r)
		s.logger.Info("request",
			"method", r.Method,
			"path", r.URL.Path,
			"status", sw.status,
			"duration", time.Since(start).Round(time.Microsecond),
		)
	})
}

func writeJSON(w http.ResponseWriter, status int, v any) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(v)
}

func writeError(w http.ResponseWriter, status int, msg string) {
	writeJSON(w, status, map[string]string{"error": msg})
}
