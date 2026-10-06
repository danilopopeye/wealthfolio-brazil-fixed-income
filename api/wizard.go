package main

import (
	"embed"
	"net/http"
)

//go:embed static/index.html
var staticFS embed.FS

// registerWizard serves the registration assistant at "/". It is a pure
// calculator on top of the same public endpoints (no investment data is
// stored), aimed at people registering CDBs in Wealthfolio without a
// terminal. Open when API_KEY is set: the page asks for the key and sends
// it as X-API-Key on its own calls.
func registerWizard(mux *http.ServeMux) {
	mux.HandleFunc("GET /{$}", func(w http.ResponseWriter, r *http.Request) {
		data, err := staticFS.ReadFile("static/index.html")
		if err != nil {
			http.Error(w, "wizard unavailable", http.StatusInternalServerError)
			return
		}
		w.Header().Set("Content-Type", "text/html; charset=utf-8")
		_, _ = w.Write(data)
	})
}
