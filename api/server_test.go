package main

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"
)

func testServer(t *testing.T, rates []Rate, apiKey string) *httptest.Server {
	t.Helper()
	engine := testEngine(t, rates)
	srv := NewServer(engine, apiKey, nil)
	ts := httptest.NewServer(srv.Routes())
	t.Cleanup(ts.Close)
	return ts
}

func getJSON(t *testing.T, url, apiKey string) (int, map[string]any) {
	t.Helper()
	req, err := http.NewRequest(http.MethodGet, url, nil)
	if err != nil {
		t.Fatal(err)
	}
	if apiKey != "" {
		req.Header.Set("X-API-Key", apiKey)
	}
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	defer resp.Body.Close()
	var body map[string]any
	if err := json.NewDecoder(resp.Body).Decode(&body); err != nil {
		t.Fatalf("decoding response: %v", err)
	}
	return resp.StatusCode, body
}

func wantFloat(t *testing.T, body map[string]any, field string, want, tol float64) {
	t.Helper()
	got, ok := body[field].(float64)
	if !ok {
		t.Fatalf("field %q missing or not numeric: %v", field, body[field])
	}
	if diff := got - want; diff > tol || diff < -tol {
		t.Errorf("%s = %.8f, want %.8f (diff %g)", field, got, want, diff)
	}
}

func TestPUEndpoint(t *testing.T) {
	ts := testServer(t, fixtureRates(true), "")

	status, body := getJSON(t, ts.URL+"/pu/CDI-104.50-20260713", "")
	if status != 200 {
		t.Fatalf("status = %d, body = %v", status, body)
	}
	wantFloat(t, body, "price", 1026.9475888, tol)
	if body["currency"] != "BRL" {
		t.Errorf("currency = %v", body["currency"])
	}
	if body["date"] != "2026-09-20" {
		t.Errorf("date = %v (today in America/Sao_Paulo)", body["date"])
	}

	status, body = getJSON(t, ts.URL+"/pu/PRE-14.30-20260713", "")
	if status != 200 {
		t.Fatalf("status = %d", status)
	}
	wantFloat(t, body, "price", 1026.329393, tol) // Sunday = next business day PU
}

func TestPUErrors(t *testing.T) {
	ts := testServer(t, fixtureRates(true), "")

	cases := []struct {
		url    string
		status int
	}{
		{ts.URL + "/pu/garbage", 400},
		{ts.URL + "/pu/CDI-104.5-20260713", 400},
		{ts.URL + "/pu/CDI-104.50-20270101", 400},
	}
	for _, c := range cases {
		if status, _ := getJSON(t, c.url, ""); status != c.status {
			t.Errorf("%s -> %d, want %d", c.url, status, c.status)
		}
	}
}

func TestHistoryEndpoint(t *testing.T) {
	ts := testServer(t, fixtureRates(true), "")

	status, body := getJSON(t, ts.URL+"/history/CDI-104.50-20260713?from=2026-09-01&to=2026-09-20", "")
	if status != 200 {
		t.Fatalf("status = %d", status)
	}
	dates := toStrings(body["dates"])
	prices := toFloats(body["prices"])
	// Business days 01..18/09: 01-04, 08-11, 14-18 (07/09 is a holiday).
	if len(dates) != 13 || len(prices) != 13 {
		t.Fatalf("got %d rows (%v), want 13", len(dates), dates)
	}
	if dates[0] != "2026-09-01" || dates[len(dates)-1] != "2026-09-18" {
		t.Errorf("range = %s..%s", dates[0], dates[len(dates)-1])
	}
	for _, dt := range dates {
		if dt == "2026-09-07" {
			t.Error("holiday 07/09 must not appear as a row")
		}
	}
	// Last row: PU(18/09) accrues through 17/09 = 48 business days.
	if diff := prices[len(prices)-1] - 1026.40284128; diff > tol || diff < -tol {
		t.Errorf("last price = %.8f, want 1026.40284128", prices[len(prices)-1])
	}
}

func TestHistoryClampsAndErrors(t *testing.T) {
	ts := testServer(t, fixtureRates(true), "")

	// from clamped to emission: first row is the emission itself, PU 1000.
	status, body := getJSON(t, ts.URL+"/history/CDI-104.50-20260713?from=2026-07-01&to=2026-07-15", "")
	if status != 200 {
		t.Fatalf("status = %d", status)
	}
	dates := toStrings(body["dates"])
	if dates[0] != "2026-07-13" {
		t.Errorf("first date = %s, want emission 2026-07-13", dates[0])
	}
	if diff := toFloats(body["prices"])[0] - 1000; diff != 0 {
		t.Errorf("PU(emission) = %v, want 1000", toFloats(body["prices"])[0])
	}

	// Window entirely before the emission: 200 with empty arrays (D6).
	status, body = getJSON(t, ts.URL+"/history/CDI-104.50-20260713?from=2026-01-01&to=2026-06-01", "")
	if status != 200 {
		t.Fatalf("status = %d", status)
	}
	if len(toStrings(body["dates"])) != 0 || len(toFloats(body["prices"])) != 0 {
		t.Error("want empty arrays for a pre-emission window")
	}

	// Malformed original range: 400.
	if status, _ := getJSON(t, ts.URL+"/history/CDI-104.50-20260713?from=2026-09-25&to=2026-09-20", ""); status != 400 {
		t.Errorf("from>to -> %d, want 400", status)
	}
	// Invalid date format: 400.
	if status, _ := getJSON(t, ts.URL+"/history/CDI-104.50-20260713?from=20260901", ""); status != 400 {
		t.Errorf("bad from format -> %d, want 400", status)
	}
}

func TestAPIKey(t *testing.T) {
	ts := testServer(t, fixtureRates(true), "sekrit")

	if status, _ := getJSON(t, ts.URL+"/pu/CDI-104.50-20260713", ""); status != 401 {
		t.Errorf("no key -> %d, want 401", status)
	}
	if status, _ := getJSON(t, ts.URL+"/pu/CDI-104.50-20260713", "wrong"); status != 401 {
		t.Errorf("wrong key -> %d, want 401", status)
	}
	if status, _ := getJSON(t, ts.URL+"/pu/CDI-104.50-20260713", "sekrit"); status != 200 {
		t.Errorf("right key -> %d, want 200", status)
	}
	// healthz stays open for healthchecks.
	if status, _ := getJSON(t, ts.URL+"/healthz", ""); status != 200 {
		t.Errorf("healthz -> %d, want 200", status)
	}
}

func TestSourceDownBehavesAsDesigned(t *testing.T) {
	// Post-fixed with no cache and source down: 503.
	ts := testServer(t, nil, "")
	if status, _ := getJSON(t, ts.URL+"/pu/CDI-104.50-20260713", ""); status != 503 {
		t.Errorf("CDI no cache -> %d, want 503", status)
	}
	// Pre-fixed works fully offline (calendar only).
	status, body := getJSON(t, ts.URL+"/pu/PRE-14.30-20260713", "")
	if status != 200 {
		t.Fatalf("PRE offline -> %d, want 200", status)
	}
	wantFloat(t, body, "price", 1026.329393, tol)
}

func TestHealthz(t *testing.T) {
	ts := testServer(t, fixtureRates(false), "")
	status, body := getJSON(t, ts.URL+"/healthz", "")
	if status != 200 {
		t.Fatalf("status = %d", status)
	}
	cdi, _ := body["cdi"].(map[string]any)
	if cdi["lastDate"] != "2026-09-17" {
		t.Errorf("cdi.lastDate = %v, want 2026-09-17", cdi["lastDate"])
	}
}

func toStrings(v any) []string {
	arr, _ := v.([]any)
	out := make([]string, 0, len(arr))
	for _, e := range arr {
		out = append(out, e.(string))
	}
	return out
}

func toFloats(v any) []float64 {
	arr, _ := v.([]any)
	out := make([]float64, 0, len(arr))
	for _, e := range arr {
		out = append(out, e.(float64))
	}
	return out
}
