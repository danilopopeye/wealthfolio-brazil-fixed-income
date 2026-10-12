package main

import (
	"embed"
	"net/http"
)

//go:embed static/index.html
var staticFS embed.FS

// registerManual serves a static, script-free setup manual at "/": what the
// API is, the one-time Wealthfolio custom provider configuration, the symbol
// grammar and the endpoints. Deliberately documentation only — interactive
// registration lives in the Wealthfolio addon.
func registerManual(mux *http.ServeMux) {
	mux.HandleFunc("GET /{$}", func(w http.ResponseWriter, r *http.Request) {
		data, err := staticFS.ReadFile("static/index.html")
		if err != nil {
			http.Error(w, "manual unavailable", http.StatusInternalServerError)
			return
		}
		w.Header().Set("Content-Type", "text/html; charset=utf-8")
		_, _ = w.Write(data)
	})
}
