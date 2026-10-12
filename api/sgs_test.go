package main

import (
	"context"
	"net/http"
	"net/http/httptest"
	"testing"
	"time"
)

func TestSGSNotFoundIsEmptyWindow(t *testing.T) {
	ts := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusNotFound)
		_, _ = w.Write([]byte(`{"erro":{"statusCode":404,"detail":"SGSNegocioException: Value(s) not found"}}`))
	}))
	defer ts.Close()

	f := NewSGSFetcher(ts.URL, 2*time.Second)
	rates, err := f.FetchCDI(context.Background(), d("2026-10-10"), d("2026-10-12"))
	if err != nil {
		t.Fatalf("404 must be an empty window, got error: %v", err)
	}
	if len(rates) != 0 {
		t.Errorf("want no rates, got %d", len(rates))
	}
}

func TestSGSHappyPathParsesRows(t *testing.T) {
	ts := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		_, _ = w.Write([]byte(`[{"data":"06/10/2026","valor":"0.050788"},{"data":"07/10/2026","valor":"0.050788"}]`))
	}))
	defer ts.Close()

	f := NewSGSFetcher(ts.URL, 2*time.Second)
	rates, err := f.FetchCDI(context.Background(), d("2026-10-06"), d("2026-10-07"))
	if err != nil {
		t.Fatal(err)
	}
	if len(rates) != 2 {
		t.Fatalf("want 2 rates, got %d", len(rates))
	}
	if rates[0].Date.Format("2006-01-02") != "2026-10-06" || rates[0].Value != 0.050788 {
		t.Errorf("bad parse: %+v", rates[0])
	}
}

func TestSGSRetriesOn500(t *testing.T) {
	calls := 0
	ts := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		calls++
		if calls == 1 {
			w.WriteHeader(http.StatusInternalServerError)
			return
		}
		_, _ = w.Write([]byte(`[{"data":"07/10/2026","valor":"0.050788"}]`))
	}))
	defer ts.Close()

	f := NewSGSFetcher(ts.URL, 2*time.Second)
	rates, err := f.FetchCDI(context.Background(), d("2026-10-07"), d("2026-10-07"))
	if err != nil {
		t.Fatalf("expected retry to succeed, got %v", err)
	}
	if calls != 2 || len(rates) != 1 {
		t.Errorf("calls=%d rates=%d, want 2 calls 1 rate", calls, len(rates))
	}
}
