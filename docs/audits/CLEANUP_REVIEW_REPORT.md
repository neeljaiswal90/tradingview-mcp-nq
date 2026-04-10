# Cleanup Review Report

**Date:** 2026-04-05
**Scope:** Full repo audit — architecture, trading logic, replay, analytics, dependencies, hygiene
**Test results after changes:** 254/254 pass, 0 type errors

---

## 1. Executive Summary

### Top 5 Issues Found

1. **Config defaults mismatch (HIGH)** — `indicator-config-manager.ts` DEFAULT_CONFIG had `min_rr=2.5`, `max_risk_per_trade_pct=0.5%`, `account_equity=10,000` while the actual config file has `min_rr=2`, `max_risk_per_trade_pct=1.5%`, `account_equity=25,000`. If the config file were deleted, the engine would silently revert to drastically different risk parameters. Same problem in `env.ts` hardcoded defaults. **Fixed now.**

2. **Env-vs-config precedence ambiguity (HIGH)** — `runner.ts` merges env vars over config file values. When no `.env` or env var is set, `env.ts` hardcoded defaults (old values: $10K equity, 0.5% risk) would **override** the config file. This caused the `sizing_zero_contracts` bug previously. Now fixed by aligning all defaults. Structural fix (single source of truth) is a later redesign.

3. **Strategy scoring magic numbers (MEDIUM)** — 30+ hardcoded confidence-factor weights in `strategy.ts` (e.g., `+2.0` for 4TF alignment, `-1.0` for 1h conflict). These are not tunable via config. A `scoring_weights` config section would let sweeps optimize them.

4. **Dual-direction model scores candidates twice (MEDIUM)** — `generateSignal()` calls `scoreConfidenceDetailed()` during candidate generation (line ~1458), then calls it AGAIN inside `buildDirectionalCandidate()` (line ~1481). Each candidate is scored twice with identical inputs. The second call is wasted compute.

5. **Historical replay lacks opening-range reconstruction (MEDIUM)** — `historical/snapshot-builder.ts` builds MarketSnapshot from CSV bars but does not reconstruct `key_levels.or_high`, `or_low`, `or_mid`. Opening-drive strategy families fire on OR levels, so they're effectively dead in replay mode.

### Top 5 Cleanup Wins Delivered

1. **Config defaults aligned** — DEFAULT_CONFIG, env.ts defaults, and indicator-config.json now agree on all values.
2. **Dead type variants removed** — 7 unreachable `SetupType` and `MarketRegime` variants pruned.
3. **Orphaned config/domains/ removed** — 4 JSON files in `config/domains/` were never loaded by any code.
4. **Duplicate npm scripts removed** — `lint` (dup of `typecheck`), `auto:dev` (dup of `auto:paper`), `historical:build-dataset` (dup of `historical:replay`).
5. **Dead code removed** — `void classifySession` no-op statement in runner.ts.

### Biggest Risk Areas Still Remaining

1. **Env-vs-config dual source of truth** — runner.ts merges both, with env winning. Needs architectural decision on single canonical source.
2. **Scoring magic numbers not config-driven** — Prevents automated tuning and introduces invisible coupling.
3. **Historical replay can't test OR-based strategies** — Opening-range setups are silently untested in backtest.
4. **Double scoring in generateSignal()** — Performance waste, but functionally harmless.
5. **Claude trigger-scheduler has redundant market-hours fallback** — Implements simplified ET check that diverges from `session.ts` logic.

---

## 2. Architecture Map

### System Overview

```
                         ┌─────────────────────────────┐
                         │     MCP Server (server.ts)    │
                         │  78 tools via @mcp/sdk        │
                         └──────────┬──────────────────┘
                                    │
              ┌─────────────────────┼─────────────────────┐
              ▼                     ▼                     ▼
     src/tools/ (15)        src/cli/ (17)         src/autotrade/
     Tool registration      CLI commands          Trading engine
              │                     │                     │
              └─────────┬───────────┘                     │
                        ▼                                 │
              src/core/tradingview/ (20)                   │
              Chart, Data, Pine, Replay, UI               │
                        │                                 │
                        ▼                                 │
              src/core/cdp/ (3)                           │
              Chrome DevTools Protocol                    │
                        │                                 │
                        ▼                                 ▼
              TradingView Desktop              ┌──────────────────┐
              (via CDP port 9222)              │  Autotrade Engine │
                                               ├──────────────────┤
                                               │ runner.ts (entry) │
                                               │ strategy.ts       │
                                               │ position-mgr.ts   │
                                               │ risk.ts           │
                                               │ execution.ts      │
                                               │ data-collector.ts  │
                                               │ scheduler.ts      │
                                               │ session.ts        │
                                               │ events.ts         │
                                               │ contracts.ts      │
                                               │ env.ts            │
                                               │ log-writer.ts     │
                                               │ perf-tracker.ts   │
                                               │ indicator-cfg.ts   │
                                               ├──────────────────┤
                                               │ claude-reasoning/  │
                                               │  (advisory only)  │
                                               ├──────────────────┤
                                               │ historical/       │
                                               │  (offline replay) │
                                               └──────────────────┘
```

### Module Boundaries

| Layer | Files | Responsibility |
|-------|-------|---------------|
| **CDP** | 3 | Raw Chrome DevTools Protocol connection, evaluation, target discovery |
| **Session** | 1 | Singleton CDP client lifecycle, liveness probe |
| **Core TV** | 20 | TradingView API abstraction (chart, data, pine, replay, UI, etc.) |
| **Tools** | 15 | MCP tool registration with Zod schemas |
| **CLI** | 17 | Command-line interface routing |
| **Autotrade** | 15 | Strategy engine, risk management, execution, logging |
| **Claude Reasoning** | 8 | Non-blocking advisory layer (never places orders) |
| **Historical** | 9 | Offline replay pipeline, CSV loading, bar alignment, fill models |

### Tight Coupling Hotspots

- **runner.ts ↔ env.ts ↔ indicator-config-manager.ts** — Triple merge for effective config
- **strategy.ts** — 1,547 lines, contains regime classification, bias assessment, 9 generators, scoring, hard gates, dual-direction comparison, and ML features
- **data-collector.ts ↔ core/tradingview/** — Direct coupling to TV API for 4-TF data collection

---

## 3. Findings Table

### Critical

| # | Title | Category | Files | Problem | Impact | Recommendation | Status |
|---|-------|----------|-------|---------|--------|---------------|--------|
| F1 | Config defaults mismatch | architecture | indicator-config-manager.ts, env.ts, indicator-config.json | DEFAULT_CONFIG had min_rr=2.5, risk=0.5%, equity=$10K vs config file's 2.0, 1.5%, $25K | Silent fallback to wrong risk params if config file missing; was root cause of sizing_zero_contracts bug | Aligned all three sources | **FIXED** |

### High

| # | Title | Category | Files | Problem | Impact | Recommendation | Status |
|---|-------|----------|-------|---------|--------|---------------|--------|
| F2 | Env-vs-config dual source of truth | architecture | env.ts, runner.ts, indicator-config-manager.ts | runner.ts spreads env over config; env.ts defaults can silently override config file values | Confusing precedence, prone to value shadowing bugs | Establish single canonical source; document precedence chain | Later |
| F3 | Historical replay missing OR reconstruction | replay | historical/snapshot-builder.ts | OR high/low/mid are never populated from CSV bars; opening_drive generators require them | Opening-drive and failed-OR strategies are silently dead in replay | Build OR from 9:30-9:45 ET 1m bars in snapshot builder | Later |

### Medium

| # | Title | Category | Files | Problem | Impact | Recommendation | Status |
|---|-------|----------|-------|---------|--------|---------------|--------|
| F4 | Scoring magic numbers | trading logic | strategy.ts | 30+ hardcoded weights (2.0, 1.0, 0.5, -1.0, etc.) not in config | Can't tune via sweep; invisible to config audit | Add scoring_weights section to IndicatorConfig | Later |
| F5 | Double scoring in generateSignal | trading logic | strategy.ts:1458,1481 | Each candidate scored by scoreConfidenceDetailed() during generation, then again in buildDirectionalCandidate() | Wasted compute (2× scoring calls per candidate per cycle) | Cache breakdown from first call, pass to buildDirectionalCandidate | Later |
| F6 | strategy.ts is 1,547 lines | architecture | strategy.ts | Regime, bias, 9 generators, scoring, gates, dual-direction, ML features all in one file | Hard to navigate and test individual concerns | Split into strategy/generators.ts, strategy/scoring.ts, strategy/dual-direction.ts | Later |
| F7 | Claude trigger-scheduler redundant ET fallback | trading logic | claude-reasoning/trigger-scheduler.ts | Lines 109-127 implement simplified market-hours check that diverges from session.ts | Could fire advisory outside proper ETH/RTH windows | Import and use classifySession() instead of custom fallback | Later |
| F8 | Duplicate snapshot builders | architecture | historical/snapshot-builder.ts, claude-reasoning/snapshot-builder.ts | Both implement EMA computation independently | Minor code duplication, drift risk | Extract shared indicator-math.ts utility | Later |

### Low

| # | Title | Category | Files | Problem | Impact | Recommendation | Status |
|---|-------|----------|-------|---------|--------|---------------|--------|
| F9 | Dead SetupType variants | hygiene | types.ts | 6 unreachable variants (vwap_reclaim_long, etc.) with no generators | Type bloat, misleading about supported strategies | Removed | **FIXED** |
| F10 | Dead MarketRegime variant | hygiene | types.ts | mean_reversion never returned by classifyRegime() | Type bloat | Removed | **FIXED** |
| F11 | Orphaned config/domains/ | hygiene | config/domains/ | 4 JSON files never loaded by any code | Disk clutter, confusing for new contributors | Removed | **FIXED** |
| F12 | Duplicate npm scripts | hygiene | package.json | lint=typecheck, auto:dev=auto:paper, historical:build-dataset=historical:replay | Confusing, creates illusion of different behavior | Removed duplicates | **FIXED** |
| F13 | Dead void statement | hygiene | runner.ts:587 | `void classifySession` is a no-op (import already used at line 259) | Dead code | Removed | **FIXED** |
| F14 | scoreConfidence() wrapper | hygiene | strategy.ts | Now just delegates to scoreConfidenceDetailed(); only used in tests | Legacy code | Keep for test backward compat; mark as legacy | Noted |
| F15 | cross-env devDependency | dependency | package.json | Node >=18 supports env var syntax natively on most platforms | Unnecessary dependency | Test removal; keep if Windows cmd.exe compat needed | Later |

---

## 4. Bloat Removal Table

| Item | Why Bloat | Verification | Replaced By |
|------|-----------|-------------|-------------|
| `void classifySession;` (runner.ts:587) | No-op statement; import already used at line 259 | Grep confirmed classifySession used at line 259; void statement adds nothing | Deleted |
| `mean_reversion` in MarketRegime type | Never returned by classifyRegime(); unreachable | Grep for `mean_reversion` in src/ found only type definition | Deleted |
| 6 SetupType variants: `vwap_reclaim_long`, `vwap_rejection_short`, `range_breakout_long`, `range_breakdown_short`, `failed_breakout_short`, `failed_breakdown_long` | No generator function produces these types | Grep across entire codebase found them only in type definition | Deleted |
| `config/domains/` directory (4 files) | Never loaded or referenced by any source code | Grep for `config/domains` and `domains/` in src/ returned zero results | Deleted |
| `lint` npm script | Identical to `typecheck` (both run `tsc --noEmit`) | Visual inspection of package.json | Kept `typecheck` |
| `auto:dev` npm script | Identical to `auto:paper` (both run `cross-env MODE=paper node dist/autotrade/runner.js`) | Visual inspection of package.json | Kept `auto:paper` |
| `historical:build-dataset` npm script | Identical to `historical:replay` (both run same cli.js with same args) | Visual inspection of package.json | Kept `historical:replay` |

---

## 5. Candidate Removals NOT Yet Removed

| Item | Why Suspicious | Why Not Safe to Remove | How to Verify |
|------|---------------|----------------------|---------------|
| `cross-env` devDependency | Node >=18 supports env vars natively | Windows cmd.exe still may not support `MODE=paper node ...` syntax; .bat launchers exist | Test `npm run auto:paper` on Windows cmd.exe without cross-env |
| `scripts/pine_push.js` + `scripts/pine_pull.js` | Not referenced in any npm script | May be used manually by developer for Pine Script development workflow | Ask developer if these are still used |
| `scripts/run-remaining-sweep.mjs` + `scripts/run-sensitivity-sweep.mjs` + `scripts/sweep-summary.mjs` | Experiment scripts from prior sensitivity sweep; may not be needed again | They're the analysis toolchain; may be reused for future sweeps | Keep unless explicitly deprecated |
| `reports/sensitivity/` directory (50+ files) | Generated experiment output from past sweep | Serves as historical reference for config decisions | Keep; add to .gitignore if not already tracked |
| `skills/autoresearch/.DS_Store` | macOS metadata file | Not harmful, but shouldn't be in repo | Add `**/.DS_Store` to .gitignore |
| `scoreConfidence()` wrapper function | Now just delegates to `scoreConfidenceDetailed()` | Used in existing test file `autotrade.test.ts` (5 test cases) | Could migrate tests to use `scoreConfidenceDetailed()` directly |

---

## 6. Refactors Performed

### R1: Config Defaults Alignment

**What changed:**
- `indicator-config-manager.ts` DEFAULT_CONFIG updated: `min_rr` 2.5→2, `max_risk_per_trade_pct` 0.5→1.5, `account_equity` 10K→25K, `version` updated to match config file
- `env.ts` defaults updated: `MAX_RISK_PER_TRADE_PCT` 0.5→1.5, `ACCOUNT_EQUITY` 10K→25K, `ANALYSIS_INTERVAL_SECONDS` 10→20

**Why:** These three sources (DEFAULT_CONFIG, env.ts hardcoded defaults, indicator-config.json) must agree. Mismatched defaults were the root cause of the sizing_zero_contracts bug and would cause silent behavior changes if the config file were absent.

**Expected benefit:** Eliminates an entire class of "config file missing/field absent" bugs. Any source now produces the same production-safe defaults.

### R2: Dead Type Pruning

**What changed:** Removed 6 `SetupType` variants and 1 `MarketRegime` variant from `types.ts`.

**Why:** These types had no corresponding generator functions and could never be produced at runtime. They created a false impression that the strategy supported more setup families than it actually does.

**Expected benefit:** Clearer contract of what the strategy engine actually produces. Prevents confusion when analyzing trade logs or planning new generators.

---

## 7. Testing / Validation

| Check | Result |
|-------|--------|
| `npx tsc --noEmit` | Pass — 0 errors |
| `npx vitest run` | 254/254 tests pass (21 test files) |
| Type-check after removing SetupType variants | Pass — no references to removed variants anywhere in codebase |
| Type-check after removing mean_reversion | Pass — only appeared in type definition, never in runtime code |
| Config alignment verification | env.ts defaults, DEFAULT_CONFIG, and indicator-config.json all agree on: min_rr=2, max_risk=1.5%, equity=$25K, interval=20s |

**What could NOT be fully validated:**
- Live trading behavior (no live environment available)
- Historical replay with OR-based strategies (OR reconstruction not yet implemented)
- Windows cmd.exe compatibility if cross-env were removed

---

## 8. Files Changed

| File | Change Type | Description |
|------|------------|-------------|
| `src/autotrade/types.ts` | Modified | Removed `mean_reversion` regime, 6 unreachable SetupType variants |
| `src/autotrade/runner.ts` | Modified | Removed dead `void classifySession` statement |
| `src/autotrade/indicator-config-manager.ts` | Modified | Aligned DEFAULT_CONFIG values with indicator-config.json |
| `src/autotrade/env.ts` | Modified | Aligned hardcoded defaults (equity=$25K, risk=1.5%, interval=20s) |
| `package.json` | Modified | Removed 3 duplicate scripts (lint, auto:dev, historical:build-dataset) |
| `config/domains/` | Deleted | Removed 4 orphaned JSON files (entry_filter/baseline.json, current.json, runner_management/baseline.json, current.json) |

---

## 9. Next-Step Roadmap

### Immediate (do next session)

1. **Fix double scoring in generateSignal()** — Cache the `ScoreBreakdown` from the first `scoreConfidenceDetailed()` call and pass it into `buildDirectionalCandidate()` instead of re-computing. Trivial change, saves ~50% of scoring compute per cycle.

2. **Add OR reconstruction to historical snapshot builder** — Use 1m bars between 09:30-09:45 ET to compute `or_high`, `or_low`, `or_mid` in historical snapshots. Without this, the opening-drive and failed-OR strategy families are dead in replay.

### Short-term Refactors (next 1-2 weeks)

3. **Split strategy.ts** — Extract into:
   - `strategy/generators.ts` — All 9 setup generator functions (~400 lines)
   - `strategy/scoring.ts` — `scoreConfidenceDetailed()`, `applyHardGates()`, factor weights (~300 lines)
   - `strategy/dual-direction.ts` — `compareSides()`, decision logic, console output (~200 lines)
   - `strategy/index.ts` — `generateSignal()` orchestrator, ML features, re-exports

4. **Extract scoring weights to config** — Add `scoring_weights` object to IndicatorConfig with named factors (e.g., `tf_alignment_4_bonus: 2.0`, `1h_conflict_penalty: -1.0`). This makes sweep optimization possible.

5. **Consolidate market-hours logic** — Replace trigger-scheduler's fallback ET check with a call to `classifySession()` from session.ts.

6. **Extract shared indicator math** — Create `src/autotrade/indicator-math.ts` with EMA, ATR, RSI computation functions used by both historical and claude-reasoning snapshot builders.

### Larger Later Redesigns (roadmap items)

7. **Single config source of truth** — Decide whether `indicator-config.json` or `.env` is canonical for risk/equity params. Consider removing the env-override pattern in runner.ts and having env.ts only handle mode/symbol/logging.

8. **Strategy scoring model v2** — Replace additive factor model with a structured evaluator where each factor has a weight, direction-sensitivity flag, and regime-specific modifier, all driven by config.

9. **Trade management separation** — Currently, position-manager.ts handles exits inline during the 2s monitor loop. Consider extracting a `TradeManager` class that encapsulates trailing stop policy, partial exit rules, and time-stop gating as a composable strategy.

10. **Replay-live parity audit** — Systematically compare every field in live `MarketSnapshot` vs historical `MarketSnapshot` to identify all gaps (OR levels, session state, event state, key levels from Pine indicators).

---

## Appendix: Architecture Statistics

| Metric | Value |
|--------|-------|
| Source files (src/) | 135 TypeScript files |
| Test files | 21 (254 test cases) |
| Runtime dependencies | 2 (@modelcontextprotocol/sdk, chrome-remote-interface) |
| Dev dependencies | 5 |
| Lines in strategy.ts | 1,547 |
| Lines in runner.ts | 585 |
| Lines in types.ts | 630 |
| Setup generators | 9 (4 always-on, 5 config-gated) |
| Confidence scoring factors | 30+ |
| Hard gate checks | 16 |
| Supported contracts | NQ, MNQ, ES, MES |
| Log file types | 7 (signals, trades, rejected, trade_path, sessions, indicator_changes, performance) |
