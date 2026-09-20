package main

import (
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"sort"
	"sync"
	"time"
)

// Rate is one daily CDI observation: the effective rate for that business
// day, in percentage points (0.050788 means 0.050788% per day).
type Rate struct {
	Date  time.Time // UTC midnight
	Value float64   // % per business day
}

type rateFile struct {
	UpdatedAt time.Time          `json:"updatedAt"`
	Rates     map[string]float64 `json:"rates"`
}

// RateStore is the CDI cache (design D1): an in-memory date->rate map
// persisted as a single JSON file with atomic rename. It stores nothing
// about investments, only the CDI series.
type RateStore struct {
	mu        sync.RWMutex
	path      string
	rates     map[string]float64
	sorted    []string
	fetchedAt time.Time
}

func LoadRateStore(path string) *RateStore {
	s := &RateStore{path: path, rates: make(map[string]float64)}
	if path == "" {
		return s
	}
	data, err := os.ReadFile(path)
	if err != nil {
		return s // missing file -> empty cache
	}
	var f rateFile
	if err := json.Unmarshal(data, &f); err != nil {
		return s // corrupted file -> empty cache, refetched on demand
	}
	s.rates = f.Rates
	if s.rates == nil {
		s.rates = make(map[string]float64)
	}
	s.reindex()
	s.fetchedAt = f.UpdatedAt
	return s
}

func (s *RateStore) reindex() {
	s.sorted = s.sorted[:0]
	for k := range s.rates {
		s.sorted = append(s.sorted, k)
	}
	sort.Strings(s.sorted)
}

// Get returns the rate for a date (UTC midnight).
func (s *RateStore) Get(d time.Time) (float64, bool) {
	s.mu.RLock()
	defer s.mu.RUnlock()
	v, ok := s.rates[d.Format("2006-01-02")]
	return v, ok
}

// First returns the earliest cached date.
func (s *RateStore) First() (time.Time, bool) {
	s.mu.RLock()
	defer s.mu.RUnlock()
	if len(s.sorted) == 0 {
		return time.Time{}, false
	}
	d, _ := time.Parse("2006-01-02", s.sorted[0])
	return d, true
}

// Last returns the latest cached date and its rate.
func (s *RateStore) Last() (time.Time, float64, bool) {
	s.mu.RLock()
	defer s.mu.RUnlock()
	if len(s.sorted) == 0 {
		return time.Time{}, 0, false
	}
	last := s.sorted[len(s.sorted)-1]
	d, _ := time.Parse("2006-01-02", last)
	return d, s.rates[last], true
}

func (s *RateStore) Count() int {
	s.mu.RLock()
	defer s.mu.RUnlock()
	return len(s.sorted)
}

func (s *RateStore) FetchedAt() time.Time {
	s.mu.RLock()
	defer s.mu.RUnlock()
	return s.fetchedAt
}

func (s *RateStore) MarkFetched(t time.Time) {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.fetchedAt = t
}

// Merge adds observations (new or overwriting) and persists atomically.
func (s *RateStore) Merge(rates []Rate) {
	s.mu.Lock()
	defer s.mu.Unlock()
	for _, r := range rates {
		s.rates[r.Date.Format("2006-01-02")] = r.Value
	}
	s.reindex()
}

// Save writes the cache file (tmp + rename). Empty path disables persistence.
func (s *RateStore) Save() error {
	s.mu.RLock()
	f := rateFile{UpdatedAt: s.fetchedAt, Rates: s.rates}
	s.mu.RUnlock()
	if s.path == "" {
		return nil
	}
	if err := os.MkdirAll(filepath.Dir(s.path), 0o755); err != nil {
		return fmt.Errorf("create cache dir: %w", err)
	}
	data, err := json.MarshalIndent(f, "", "  ")
	if err != nil {
		return err
	}
	tmp := s.path + ".tmp"
	if err := os.WriteFile(tmp, data, 0o644); err != nil {
		return fmt.Errorf("write cache: %w", err)
	}
	if err := os.Rename(tmp, s.path); err != nil {
		return fmt.Errorf("rename cache: %w", err)
	}
	return nil
}
