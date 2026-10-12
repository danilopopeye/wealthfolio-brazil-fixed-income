# CODING_STANDARDS.md

Regras de revisão para este repo.

- **Um commit por contexto**: se o diff carrega dois trabalhos independentes (dois fixes, fix + doc), exigir split antes do merge.
- **Mensagem de commit via arquivo** (`git commit -F <arquivo>`), nunca printf/interpolação de shell: `%` no texto trunca a mensagem silenciosamente.
- **Mudança na matemática de PU** só entra com as suítes de fixture verdes nos dois lados (`go test ./...` em `api/` e `pnpm test` na raiz) — as quatro fontes de fixture (`api`, `check-engine`, `check-cdi`, `docs/bootstrap.md`) precisam seguir juntas.
