# NQ Trading Stack Refactoring — Implementation Plan

## Objective

Turn this repo into a cleaner, more portable, locally-driven NQ trading stack:
1. Richer Bookmap ingestion beyond BBO/trade
2. Zero Claude/Anthropic advisory code
3. Resolved config/runtime mismatches
4. Internal microstructure features (absorption, sweeps, footprint, large trades, market profile)
5. Clean CI/dev portability
6. Signal logic much less dependent on TradingView studies/Pine outputs

## Phase Checklist

### Phase 0: Discovery + Plan
- [x] Audit Claude footprint (15 files, runner/env/dashboard/config/tests)
- [x] Audit TradingView dependency chain (HARD/SOFT/PINE classification)
- [x] Audit config mismatches (cooldown_bars, no_same_bar_reversal, analysis_interval)
- [x] Audit Bookmap capabilities (DepthDataListener available, AdvancedMboAnalyzer dormant)
- [x] Create this plan file

### Phase 1: CI/Dev Portability
- [ ] Add .github/workflows/ci.yml
- [ ] Add bootstrap/clean/rebuild/verify package.json scripts
- [ ] Update .gitignore for Python caches, Bookmap artifacts
- [ ] Verify fresh install works

### Phase 2: Remove Claude Completely
- [ ] Extract SessionInfo type to types.ts (pre-work)
- [ ] Delete src/autotrade/claude-reasoning/ (15 files)
- [ ] Remove Claude from runner.ts, env.ts, types.ts, config
- [ ] Remove Claude from dashboard (state, types, server, frontend)
- [ ] Remove Claude log writers and test files
- [ ] Verify zero claude/anthropic references in src/

### Phase 3: Bookmap Upgrade Beyond BBO/Trade
- [ ] Add DepthDataListener to Java addon
- [ ] Wire AdvancedMboAnalyzer into sidecar state
- [ ] Add adv_* fields to TypeScript LobSnapshot
- [ ] Remove `as any` casts from feature-builder.ts
- [ ] Add depth/MBO ingestion tests

### Phase 4: Microstructure Features
- [ ] Absorption scoring (bid/ask)
- [ ] Enhanced sweep metrics
- [ ] Footprint delta/imbalance
- [ ] Large trade clustering
- [ ] Session volume profile (VPOC/VAH/VAL)
- [ ] Extend TS types and ML registries

### Phase 5: Config/Runtime Cleanup
- [ ] Fix cooldown_bars fallback (4 places in runner.ts)
- [ ] Fix no_same_bar_reversal fallback
- [ ] Align DEFAULT_CONFIG with JSON
- [ ] Remove dead Claude config fields
- [ ] Add validation for ML/execution config
- [ ] Clear startup logging

### Phase 6: Signal Logic Revamp
- [ ] Extract local indicator functions (EMA, RSI, ATR, ADX, VWAP)
- [ ] Implement local swing/BOS structure detection
- [ ] Implement local session levels
- [ ] Replace TV study dependence in data-collector
- [ ] Update strategy to use local features
- [ ] Reduce ensureChartSetup requirements

### Phase 7: Final Verification + Docs
- [ ] Full test suite green
- [ ] Fresh clone bootstrap test
- [ ] Updated docs
- [ ] IMPLEMENTATION_AUDIT.md

## Key Repo Findings

### Claude Footprint
- 15 files in src/autotrade/claude-reasoning/
- Runtime wiring: runner.ts imports, service init, trigger scheduler, snapshot provider
- Config: env.ts (8 CLAUDE_* vars), types.ts (claude_management), indicator-config.json
- Dashboard: state-manager (claudeState, updateClaude, buildClaude), types (2 interfaces), server (route, SSE), frontend (ClaudePanel.tsx)
- Critical: SessionInfo type from claude-reasoning/snapshot-types.ts used by dashboard — extract BEFORE delete

### TradingView Dependencies
- HARD (keep): OHLCV bars, quotes, timeframe switching
- SOFT (replace with local): EMA, RSI, ATR, Volume SMA, SuperTrend — functions exist in historical/snapshot-builder.ts
- PINE (blocking): Smart Money BOS/CHoCH (15+ decision points) — replace with local swing/structure detection
- CHART_SETUP (reduce): Auto-add ATR/RSI can be removed once computed locally

### Config Mismatches
- cooldown_bars: runner fallback=3 vs config=0 (4 places)
- no_same_bar_reversal: runner fallback=true vs config=false
- analysis_interval_seconds: DEFAULT_CONFIG=20 vs JSON=5

### Bookmap/Sidecar State
- Addon: BBO+trade only. DepthDataListener available but not implemented.
- Sidecar: Handles depth+mbo messages. AdvancedMboAnalyzer exists+tested but DORMANT.
- TypeScript: LobSnapshot missing adv_* fields → 7 `as any` casts in feature-builder.ts
