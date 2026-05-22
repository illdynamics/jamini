## v0.2.3 (2026-05-15)

### Features
- **Interactive TTY**: The containerized `jamini` wrapper (`~/bin/jamini`) now conditionally allocates a TTY (`-t`) when stdin is a terminal,
  restoring full Gemini CLI interactive mode for `jamini` and `jamini -y`. Piped input still works without TTY.
- **Smart TTY passthrough**: TTY is only passed through when the parent process has a terminal on stdin, so piped usage
  (`echo "query" | jamini -y`) still works correctly.
- **Host TERM passthrough**: The wrapper now forwards the host's `TERM` and `COLORTERM` environment variables into the container.
  The Docker image also sets sensible defaults (`TERM=xterm-256color`, `COLORTERM=truecolor`), eliminating both
  `256-color support not detected` and `True color support not detected` startup warnings from the Gemini CLI.

### Fixes
- **Stderr warning suppression**: Fixed `stderr-filter.ts` regex patterns to catch Gemini CLI v0.42.0 warning format changes.
  The new format uses a `⚠` emoji prefix (e.g. `⚠  Warning: 256-color...`). Added a `stripPrefix()` helper that strips
  leading non-alphanumeric characters before matching, and added `256-color` (dash variant) to the drop patterns.
- **Gemini CLI sync**: Both the host `package.json` (`@google/gemini-cli`) and the `Dockerfile` (`GEMINI_CLI_NPM_VERSION`)
  were updated from `0.41.2` to `0.42.0`, matching the host's globally installed version.

### Changes
- `VERSION` — v0.2.3
- `package.json` — `@google/gemini-cli` 0.42.0, version 0.2.3
- `package-lock.json` — Regenerated
- `Dockerfile` — Added `TERM`, `COLORTERM` env vars; `GEMINI_CLI_NPM_VERSION` → 0.42.0
- `~/bin/jamini` (installed wrapper) — `-t` flag + TERM/COLORTERM passthrough
- `jamini` (bootstrap script) — Updated wrapper template
- `src/cli.ts` — v0.2.3, branded banner updated
- `src/stderr-filter.ts` — Fixed pattern matching for emoji-prefixed warnings
- `dist/stderr-filter.js` — Recompiled
- `dist/cli.js` — Recompiled
- `README.md` — v0.2.3 references
- `PRIVACY_LOCKDOWN.md` — v0.2.3 references
- `RELEASE-NOTES.md` — This entry

# Jamini Release Notes

## v0.2.2 (2026-05-14)

### Critical Fix
- **Interactive mode restored**: Fixed TTY detection for Gemini CLI child process.
  `jamini` and `jamini -y` now enter interactive mode correctly (like upstream `gemini`).
  The root cause was Node.js `child_process.spawn` passing `process.stdin` as a stream
  object, which created a pipe instead of inheriting the TTY descriptor. Changed to
  `stdio: ['inherit', 'inherit', 'pipe']`.

### Production Hardening (MasterWonq Audit — 9 findings fixed)
- **Release hygiene**: Fixed `check-release-hygiene.sh` — removed `.codeseeq` dev tool from
  forbidden list; fixed broken `node_modules` check in the same script.
- **Dependency pinning**: All dependencies pinned to exact versions (no `^` prefixes) in both
  `package.json` and `bridge/package.json`. `@google/gemini-cli` pinned to `0.41.2`.
  `Dockerfile` `GEMINI_CLI_NPM_VERSION` pinned to `0.41.2`.
- **Startup timeout**: Added 60-second startup timeout in `main()` to prevent indefinite hangs
  when bridge fails to start. Calls `die()` with clear error message.
- **SIGINT/SIGTERM async-safety**: Signal handlers no longer call `log()` (avoids lazy
  `WriteStream` creation in signal handler). Async cleanup (`doCleanup()`) now completes
  before process exit with 5-second timeout backstop. Log stream initialized early in
  `main()`.
- **Safer container runtime detection**: `execSync()` replaced with `spawnSync()` + PATH-based
  path probing in `findContainerRuntime()`. Eliminates latent command injection risk.
- **Bridge graceful shutdown connection draining**: Added active socket tracking in bridge
  server. On shutdown, tracked sockets are destroyed after a drain window (1/3 of shutdown
  timeout, max 3s) before force exit.
- **Stderr filter maintenance policy**: Added comprehensive maintenance documentation in
  `src/stderr-filter.ts` describing when to run smoke tests, how to add patterns, and when
  to deprecate filters.
- **TypeScript hygiene**: Replaced `catch (err: any)` with `catch (err: unknown)` + type guards
  in `src/cli.ts`.
- **Test coverage**: Added 3 new CLI integration tests for jamini-branded no-input message,
  stderr filter warning suppression, and YOLO deduplication. Total test count: 180 (up from
  177).

### Changes
- `scripts/check-release-hygiene.sh` — Fixed release hygiene check
- `package.json` — Pinned all deps, bumped version
- `bridge/package.json` — Pinned all deps
- `Dockerfile` — Pinned `GEMINI_CLI_NPM_VERSION`
- `src/cli.ts` — Startup timeout, SIGINT async-safety, safer container detection, `any` → `unknown`, TTY stdio inheritance fix
- `src/stderr-filter.ts` — Maintenance policy documentation
- `bridge/src/server.ts` — Connection draining for graceful shutdown
- `test/cli.test.ts` — 3 new integration tests

## v0.2.1 (2026-05-12)

### License Change
- **Apache 2.0**: Relicensed from MIT to Apache License 2.0; LICENSE file replaced, package.json and README.md updated

### Release Blockers Fixed
- **SSE streaming**: Removed `data: [DONE]` from Gemini SSE responses — real Gemini CLI no longer crashes with SyntaxError
- **Security**: `bin/jamini-print-config` no longer leaks raw `DEEPSEEK_API_KEY`; prints `<set (redacted)>` only

### Production Hardening
- **Source hygiene**: Removed `.env`, `.codeseeq/`, `.DS_Store` from repo; added `check:release-hygiene` script
- **Model policy**: Strict enforcement — only `v4-flash`, `v4-flash-thinking`, `v4-pro`, `v4-pro-thinking` accepted; provider aliases rejected
- **Bridge startup**: Server only auto-starts with `JAMINI_BRIDGE_AUTO_START=1` flag; safe for test imports
- **Graceful shutdown**: Fixed double `server.close()` with `shuttingDown` guard
- **Brave/Unstructured**: 501 stubs removed; tools disabled until fully implemented
- **LiteLLM**: Hidden from help/docs; experimental only
- **Lint**: ESLint configured; `npm run lint` passes with 0 errors
- **Preflight**: `npm run preflight` now includes build + typecheck + lint + test + pack + hygiene

### CI/CD
- **Extended workflow**: Added static checks job (ShellCheck, bash -n, secret scan, executable permissions, git whitespace), package verification job (npm pack dry-run + release hygiene), and enhanced docker smoke tests (gemini CLI available, model catalog present, config generation)
- **Release job moved into CI workflow**: The release step now lives inside `ci.yml` as a 5th job (`release`) with `needs: [static, test, package, docker]`, only firing on `v*` tags — visible as a distinct step in the pipeline UI instead of a hidden downstream workflow
- **Gemini CLI auto-install**: `./jamini install` now detects `gemini`/`gemini-cli` and auto-installs `@google/gemini-cli` globally via npm if missing — one command does everything
- **Repo cleanup**: Removed vendored `gemini-cli/` (204MB), `codeseeq/` (741MB), and reference folders `jeanclaude-github/`, `codeseeq-github/`

### Distribution
- **curl | bash installer**: `install.sh` fetches the latest GitHub release zip, extracts it, and runs `./jamini install` — one command from zero to working jamini
- **Release workflow**: Release job inside `ci.yml` auto-creates GitHub releases with zip archives on `v*` tags via `git archive`
- **README overhaul**: Replaced npm install instructions with curl/git/manual install options; removed Docker section (now handled by `./jamini install`)

### Developer Experience
- **Bootstrap script**: Added `./jamini` bootstrap/installer — `./jamini build` builds the Docker/Podman image, `./jamini install` installs to ~/.config/jamini and ~/bin/jamini for direct PATH access
- **CI fixes**: Docker tests excluded from test job (no Docker daemon), bridge auto-start flag added to docker job

### Testing
- **Real Gemini CLI E2E**: Created `test/real-gemini-cli.integration.test.ts` — proves full flow: mock DeepSeek → bridge → real Gemini CLI, no Google auth, no `[DONE]` crash (gated: `JAMINI_RUN_REAL_GEMINI_TESTS=1`)
- **144 tests passing**, 7 skipped (6 Docker + 1 real Gemini E2E)

### Packaging
- **npm pack**: 25.8 kB, 20 files, clean — no secrets, no node_modules in package
- **Release hygiene**: `npm run check:release-hygiene` verifies no forbidden files or secret patterns

### Known Limitations
- Docker tests require Docker runtime (6 tests skipped otherwise)
- Real Gemini CLI E2E gated behind `JAMINI_RUN_REAL_GEMINI_TESTS=1`
- 39 ESLint warnings from `any` types in translation code (0 errors)

---

## v0.2.0 (initial)

Initial production-grade architecture:
- Custom TypeScript Gemini→DeepSeek translation bridge (Express)
- Process bridge mode (no Docker required)
- External bridge mode
- Container bridge mode (fallback)
- Four-model policy (v4-flash, v4-flash-thinking, v4-pro, v4-pro-thinking)
- `@google/gemini-cli` npm dependency
- Auth suppression (no Google OAuth)
- YOLO/dangerous mode pass-through
- Streaming SSE support
- Tool call translation with ID preservation
- countTokens (estimator)
- Dockerfile (Node.js 22 slim, no Postgres/Julep)
- CI workflow (GitHub Actions)

