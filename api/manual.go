package main

import (
	"embed"
	"io/fs"
	"net/http"
)

//go:embed static
var staticFS embed.FS

// registerManual serves the static, script-free setup manual at "/" plus its
// favicon kit: what the API is, the one-time Wealthfolio custom provider
// configuration, the symbol grammar and the endpoints. Deliberately
// documentation only — interactive registration lives in the Wealthfolio
// addon.
func registerManual(mux *http.ServeMux) {
	sub, err := fs.Sub(staticFS, "static")
	if err != nil {
		panic("embedded static assets missing: " + err.Error())
	}

	mux.HandleFunc("GET /{$}", func(w http.ResponseWriter, r *http.Request) {
		serveAsset(w, sub, "index.html", "text/html; charset=utf-8")
	})

	assets := map[string]string{
		"favicon.ico":                  "image/x-icon",
		"favicon.svg":                  "image/svg+xml",
		"favicon-96x96.png":            "image/png",
		"apple-touch-icon.png":         "image/png",
		"site.webmanifest":             "application/manifest+json",
		"web-app-manifest-192x192.png": "image/png",
		"web-app-manifest-512x512.png": "image/png",
	}
	for name, contentType := range assets {
		mux.HandleFunc("GET /"+name, func(w http.ResponseWriter, r *http.Request) {
			serveAsset(w, sub, name, contentType)
		})
	}
}

func serveAsset(w http.ResponseWriter, sub fs.FS, name, contentType string) {
	data, err := fs.ReadFile(sub, name)
	if err != nil {
		http.Error(w, "asset unavailable", http.StatusInternalServerError)
		return
	}
	w.Header().Set("Content-Type", contentType)
	_, _ = w.Write(data)
}
