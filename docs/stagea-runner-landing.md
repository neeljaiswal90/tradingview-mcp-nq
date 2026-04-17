# Stage-A Runner Landing Scope

This PR is intentionally limited to the Stage-A runner landing.

Included in this landing:

- Stage-A runner/orchestrator landing behind `multi_instrument`
- Deterministic runner precedence with `FORCE_LEGACY_RUNNER=1` as the hard kill switch
- Per-instrument config isolation through resolved child config dirs and env wiring
- Real `multi_instrument` schema with instrument-scoped log, LOB, port, and role settings
- JSONL-first layered shadow audit using `candidate_scores_v2.jsonl`
- One-active-plus-shadow safety guard

Operational notes:

- Default runner behavior remains legacy single-instrument
- `runner_v2_enabled` and `runner_v2_shadow_only` remain as deprecated aliases for one integration cycle
- Initial multi-instrument validation profile is `MNQ=active`, `MES=shadow`
- Initial pane assignment is deterministic: `MNQ -> pane 0`, `MES -> pane 1`
- Only one active engine is allowed in this landing
- Shadow engines generate telemetry but do not emit execution side effects
- Repo-local MNQ paper artifacts can be bootstrapped with `npm run bootstrap:paper-artifacts -- --symbol MNQ`
- Startup logs the repo-local `artifact_root`, refuses to borrow missing paper artifacts from another worktree, and fails clearly when symbol-scoped artifacts are absent

Explicitly not flipped in this landing:

- No orchestrator-default cutover
- No layered-scoring authoritative cutover
- No `LOB_MBO_Scalp` hybrid/live cutover
- No quant-primary cutover
- No launcher deletion
