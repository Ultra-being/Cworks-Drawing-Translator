# Cworks Drawing Translator

Standalone web app that translates the text layer of construction and engineering PDF drawing sets and AutoCAD 2018 ASCII DXF files into English or Japanese, with page-level checkpoints, human review, and durable private storage.

Split out of the Navigator monorepo (`Ultra-being/Cworks-Intelligence`) on 14 September 2026. It shares the Cworks Postgres database and Object Storage bucket with Navigator but is deployed and authenticated separately.

## Run & Operate

- `pnpm install`
- `pnpm --filter @workspace/api-server run dev` — API server on port 5000 (builds then starts)
- `pnpm --filter @workspace/cworks-drawing-translator run dev` — Vite UI on port 20122 under `/cworks-drawing-translator/`
- `pnpm run typecheck` — full typecheck
- `pnpm run build` — typecheck + build all packages
- `pnpm --filter @workspace/db run push` — push the translator's own tables (guarded by `tablesFilter: cworks_translation_*`; it cannot touch Navigator tables)
- `pnpm exec tsx artifacts/api-server/scripts/test/native-dxf-real-smoke.ts` — safe default; reports a skipped, no-network/no-AI fixture smoke
- `RUN_NATIVE_DXF_REAL_SMOKE=1 pnpm exec tsx artifacts/api-server/scripts/test/native-dxf-real-smoke.ts` — explicit opt-in bounded smoke against the fixed 47 MB architecture DXF

### Required environment

| Variable | Purpose |
|---|---|
| `DATABASE_URL` | Shared Cworks Postgres |
| `SESSION_SECRET` | Required. The server refuses to start without it |
| `CWORKS_APP_PASSWORD` | The translator's own password gate (never falls back to Navigator's `APP_PASSWORD`) |
| `ANTHROPIC_API_KEY` | Translation model |
| `DEFAULT_OBJECT_STORAGE_BUCKET_ID`, `PRIVATE_OBJECT_DIR` | Replit Object Storage; files live under the `cworks-translator/` prefix |
| `PYTHON_BIN` | Optional. Python with PyMuPDF for `src/cworks-translator/*.py` (defaults to `python3`) |
| `TRANSLATOR_CLAUDE_MODEL` | Optional model override (default `claude-sonnet-4-5-20250929`) |

## Stack

- pnpm workspaces, Node.js 24, TypeScript 5.9
- API: Express 5 (`artifacts/api-server`)
- UI: Vite + React 19 (`artifacts/cworks-drawing-translator`)
- DB: PostgreSQL + Drizzle ORM (`lib/db`)
- Python 3.11 + PyMuPDF for PDF text-layer and native DXF processing
- Build: esbuild (ESM bundle)

## Where things live

- `artifacts/api-server/src/index.ts` — boot: session, health, `/api/cworks-translator`, static UI in production, translation worker
- `artifacts/api-server/src/routes/cworksTranslation.ts` — all HTTP endpoints, including the password gate
- `artifacts/api-server/src/cworks-translator/` — worker, checkpoints, native DXF pipeline, Python processors
- `artifacts/api-server/src/ai-services.ts` — `askClaude` (the only model call)
- `artifacts/api-server/src/usage-logger.ts` — writes cost rows to the shared `api_usage_logs` table so Navigator's Cost Dashboard still sees this spend
- `lib/db/src/schema/schema-cworks-translator.ts` — source of truth for the translator's tables
- `lib/db/src/schema/schema.ts` — partial, read-only mirrors of Navigator's `users` and `api_usage_logs`. Never push these from here.

## Architecture decisions

- Target output is intentionally limited to English (default) or Japanese. The selected target is immutable job evidence and must flow through translation, rendering, independent audit, revision checkpoints, and release approval.
- Native DXF translation surgically patches approved UTF-8 MTEXT values only. It never changes geometry, layout, handles, styles, or unrelated bytes to accommodate a translation.
- Sessions use their own `cworks_translator_sessions` table so they never mix with Navigator logins.

## Product

- Accepts PDF or AutoCAD 2018 ASCII DXF engineering drawings, auto-detects or accepts a selected source language, and produces an English or Japanese review draft.
- The qualified human reviewer makes the final go/no-go decision for the exact drawing revision. An independent machine audit informs that decision; it does not replace human judgment.
- Translation, layout, coverage, and other CAD-review warnings must allow a recorded human disposition: accept with a reason, request correction, or reject. Automated uncertainty must not create a permanent approval veto. Native DXF still requires accountable CAD-operator inspection.
- Corrupted files, stale or mismatched revisions/hashes, invalid evidence, and missing required reviewer attestations remain hard approval blocks. Human acceptance must not falsely label untouched source tables as translated or an edited derivative as byte-preserved.

## Gotchas

- Set `SESSION_SECRET` and `CWORKS_APP_PASSWORD` in Secrets before the first run.
- The UI is served under `/cworks-drawing-translator/` (see `.replit-artifact/artifact.toml`); `/` redirects there.
