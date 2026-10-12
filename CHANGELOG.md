# Changelog

All notable changes to the Cadastro Renda Fixa addon will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

## [1.7.1] - 2026-10-13

### Security
- Override source-map-js to ^1.2.2 (Dependabot high: event-loop denial of
  service through indexed source-map section offsets). Development-scope
  transitive tooling only (tailwind node, postcss, vite) — no runtime impact
  on the addon bundle

## [1.7.0] - 2026-10-12

### Added
- Static setup manual and favicon kit served at the API root (/) — the exact
  custom provider configuration for Wealthfolio, no repository access needed
- Tag-driven release flow: test gate, manifest-vs-tag version gate,
  changelog-derived release notes, and SLSA build provenance attestation on
  the zip (verifiable with gh attestation verify)
- CI: hermetic gates for both components (Go vet/tests and gofmt, addon
  type-check + fixture engine + production build, Docker image build), with
  GitHub Actions pinned to commit SHAs

### Changed
- BREAKING: default custom provider code renamed to brazil-fixed-income —
  recreate the provider in Wealthfolio Settings → Market Data and point
  existing assets at it (the old cdb-brasil-bcb setups keep pricing with the
  old code until migrated)
- Compose service renamed to fixed-income-api
- Go module renamed to github.com/danilopopeye/wealthfolio-brazil-fixed-income
- Package renamed to wealthfolio-brazil-fixed-income; README rewritten in
  English

## [Unreleased-old]

## [1.6.1] - 2026-10-13

### Changed
- Default custom provider code renamed to brazil-fixed-income (country-scoped
  namespace ahead of a sibling funds API)

## [1.6.0] - 2026-10-13

### Added
- Internationalization: pt/en bundles registered through the addon i18n API;
  the UI language follows the host setting, with matching number and date
  formats

## [1.5.1] - 2026-10-12

### Changed
- Addon renamed to Cadastro Renda Fixa

## [1.5.0] - 2026-10-12

### Added
- LCA and LCDA product types in the canonical code selector

## [1.4.0] - 2026-10-12

### Added
- LCI product type

## [1.3.3] - 2026-10-12

### Removed
- Bank field: the canonical code derives from a single path (the product
  name), which is now required

## [1.3.2] - 2026-10-12

### Changed
- Canonical codes standardized as CDB-<slug>, trimming a leading CDB from
  the product name

## [1.3.1] - 2026-10-12

### Fixed
- Asset name: the activity-creation path ignores AssetResolutionInput.name,
  so the profile update now sets it explicitly (assets no longer end up
  named by a generated UUID)

### Changed
- Friendly canonical codes derived from the product name

## [1.3.0] - 2026-10-12

### Added
- Bond-typed registration with maturity date: the provider override ships
  under both resolver keys (CUSTOM_SCRAPER plus the per-source code), so
  Bond assets resolve to an equity symbol and the BondIsin routing is never
  reached; the BondSpec (maturity, face value 1000, zero coupon) lands in
  the asset metadata

### Fixed
- Activity dates now carry an explicit timezone (RFC3339), fixing the
  "Invalid date format" rejection

## [1.2.x] - 2026-10-12

### Fixed
- Quote pricing validation polls for the first quote instead of reading
  immediately after the asynchronous market sync
- Profile updates include the required notes field (422 rejection)
- Activity dates reject bare timestamps (RFC3339 required)

### Added
- Quote arrival validation after registration

## [1.0.0 - 1.1.0] - 2026-10-06

### Added
- Initial addon: PU engine (post-fixed and pre-fixed, emission-solver),
  wizard with three purchase modes, provider override wiring, and the
  fixture-validated conventions from docs/bootstrap.md
