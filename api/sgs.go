package main

import (
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"strconv"
	"time"
)

// Fetcher pulls daily CDI observations for a date range (inclusive).
type Fetcher interface {
	FetchCDI(ctx context.Context, from, to time.Time) ([]Rate, error)
}

const defaultSGSBaseURL = "https://api.bcb.gov.br/dados/serie/bcdata.sgs.12"

// SGSFetcher fetches BCB SGS series 12 (daily CDI). Public endpoint, no
// auth, business days only, values as strings in % a.d. [fixture].
type SGSFetcher struct {
	baseURL string
	client  *http.Client
}

func NewSGSFetcher(baseURL string, timeout time.Duration) *SGSFetcher {
	if baseURL == "" {
		baseURL = defaultSGSBaseURL
	}
	return &SGSFetcher{
		baseURL: baseURL,
		client:  &http.Client{Timeout: timeout},
	}
}

type sgsRow struct {
	Data  string `json:"data"`  // DD/MM/YYYY
	Valor string `json:"valor"` // "0.050788"
}

func (f *SGSFetcher) FetchCDI(ctx context.Context, from, to time.Time) ([]Rate, error) {
	// The SGS API rejects windows longer than 10 years for daily series
	// (HTTP 406 "janela de consulta de, no máximo, 10 anos"), so long
	// backfills are fetched in 9-year chunks.
	var all []Rate
	segFrom := from
	for !segFrom.After(to) {
		segTo := to
		if limit := segFrom.AddDate(9, 0, 0); limit.Before(segTo) {
			segTo = limit
		}
		rates, err := f.fetchRange(ctx, segFrom, segTo)
		if err != nil {
			return all, err // partial results: caller keeps what arrived
		}
		all = append(all, rates...)
		segFrom = segTo.AddDate(0, 0, 1)
	}
	return all, nil
}

func (f *SGSFetcher) fetchRange(ctx context.Context, from, to time.Time) ([]Rate, error) {
	url := fmt.Sprintf(
		"%s/dados?formato=json&dataInicial=%02d/%02d/%04d&dataFinal=%02d/%02d/%04d",
		f.baseURL, from.Day(), int(from.Month()), from.Year(),
		to.Day(), int(to.Month()), to.Year(),
	)

	body, status, err := f.fetchWithRetry(ctx, url)
	if err != nil {
		return nil, err
	}
	if status == http.StatusNotFound {
		// SGS answers 404 "Value(s) not found" for windows without any
		// published observation (weekend tails, pre-publication hours) —
		// that is an empty window, not a failure.
		return []Rate{}, nil
	}
	if status != http.StatusOK {
		return nil, fmt.Errorf("SGS HTTP %d: %.200s", status, body)
	}

	var rows []sgsRow
	if err := json.Unmarshal(body, &rows); err != nil {
		return nil, fmt.Errorf("unexpected SGS response from %s: %.200s", url, body)
	}

	rates := make([]Rate, 0, len(rows))
	for _, row := range rows {
		d, err := time.Parse("02/01/2006", row.Data)
		if err != nil {
			continue
		}
		v, err := strconv.ParseFloat(row.Valor, 64)
		if err != nil {
			continue
		}
		rates = append(rates, Rate{Date: d, Value: v})
	}
	return rates, nil
}

// fetchWithRetry performs the GET with a single retry on network errors or
// 5xx responses (mirrors the resilience posture of design item 1). It
// returns the body and status for non-5xx responses; interpretation of the
// status is left to the caller.
func (f *SGSFetcher) fetchWithRetry(ctx context.Context, url string) ([]byte, int, error) {
	var lastErr error
	for attempt := 0; attempt < 2; attempt++ {
		if attempt > 0 {
			select {
			case <-time.After(500 * time.Millisecond):
			case <-ctx.Done():
				return nil, 0, ctx.Err()
			}
		}
		req, err := http.NewRequestWithContext(ctx, http.MethodGet, url, nil)
		if err != nil {
			return nil, 0, err
		}
		resp, err := f.client.Do(req)
		if err != nil {
			lastErr = fmt.Errorf("SGS request failed: %w", err)
			continue
		}
		body, err := io.ReadAll(io.LimitReader(resp.Body, 1<<20))
		resp.Body.Close()
		if err != nil {
			lastErr = fmt.Errorf("reading SGS response: %w", err)
			continue
		}
		if resp.StatusCode >= 500 {
			lastErr = fmt.Errorf("SGS HTTP %d", resp.StatusCode)
			continue
		}
		return body, resp.StatusCode, nil
	}
	return nil, 0, lastErr
}

func parseDotFloat(s string) (float64, error) {
	return strconv.ParseFloat(s, 64)
}
