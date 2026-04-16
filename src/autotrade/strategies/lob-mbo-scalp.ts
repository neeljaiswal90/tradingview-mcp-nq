/**
 * lob-mbo-scalp.ts — real generator for the lob_mbo_scalp strategy family.
 *
 * Phase 5 implementation. Wires the Phase 1 sidecar `ScalpState`, the
 * Phase 2 deterministic + persistence gates, the Phase 5 expectancy
 * engine, the Phase 4.5 ML client, and the Phase 5 shadow decision
 * engine into a single generator registered as `status: 'shadow'` in
 * STRATEGY_REGISTRY. The strategy is shadow-only in this wave — the
 * runner never executes a scalper candidate — so every rejection path
 * here exists to feed the training log, not to block real orders.
 *
 * Order of operations (strict, per plan §3 Phase 3 step list):
 *
 *    1. lobSnapshot present              → pre-gate bailout (no log row)
 *    2. buildScalperStateVector          → pre-gate bailout (no log row)
 *    3. evaluateScalperDeterministicGate → compute verdict (carry forward)
 *    4. evaluateScalperPersistenceGate   → read prior state (carry forward)
 *    5. readScalperPriorMlReadiness      → snapshot prior ml_ready for guard
 *    6. lookupScalperExpectancy          → per-horizon post-cost EV
 *    7. getScalperMlDecision (AT the    → ML probability at expectancy-
 *       expectancy-chosen horizon)         chosen horizon, never a guess
 *    8. buildScalperShadowDecision       → single audit record, internal
 *       (which calls shouldAllowScalperEntry
 *        for the final allow flag)
 *    9. recordScalperDeterministicResult → update persistence state for
 *       with (passedDeterministic, mlReady)  next cycle's guard
 *   10. writeLobMboScalpCandidate        → ONE full log row per evaluation
 *   11. return StrategyGeneratorEvaluation with the shadow decision's
 *       rejectReason — Stage A still emits every candidate as a shadow
 *       signal, Stage B suppresses disallowed candidates
 *
 * Phase 5 guardrails (enforced by this file + tests):
 *
 *   - DECISION-TIME-SAFE INPUTS ONLY. The state vector is built from the
 *     captured LobSnapshot. The ML call is made AT the expectancy-chosen
 *     horizon. No forward labels, no realized-return fields, no future
 *     state is read at any point.
 *
 *   - CONSECUTIVE-READY-CYCLES GUARD. The persistence state now also
 *     carries the prior `mlReady` flag. `readScalperPriorMlReadiness`
 *     snapshots it BEFORE step 9 records the current cycle's flag, so
 *     the guard fires on the prior value exactly once per cycle.
 *
 *   - NO SILENT FALLBACK. When the expectancy table is missing, the
 *     lookup returns a null-filled estimate and the shadow decision
 *     rejects with `expectancy_no_bucket_match`. When the ML client
 *     returns `ready=false`, the shadow decision rejects with
 *     `ml_unavailable`. No "best-effort" paths.
 *
 *   - NO HIDDEN THRESHOLDS. `theta_p`, `ev_floor_ticks`,
 *     `min_bucket_samples`, `cost_ticks`, and `hybrid_gate` are required
 *     inputs on `GenerateLobMboScalpOptions.shadowDecisionConfig` — the
 *     generator refuses to operate with defaults. Phase 6 plumbs them
 *     from `config/indicator-config.json::lob_mbo_scalp`.
 *
 *   - FULL TRANSPARENCY IN LOGS. `writeLobMboScalpCandidate` spreads the
 *     full `ScalperShadowDecision` record into the JSONL row under the
 *     `shadow_decision` field, alongside the raw state vector and gate
 *     verdicts. Every threshold, every probability, every bucket-id is
 *     reviewable after the fact without re-running the engine.
 *
 * Reject-reason precedence (high to low):
 *   1. no_lob_snapshot             (pre-gate, no log row)
 *   2. no_scalp_state              (pre-gate, no log row)
 *   3. missing_shadow_config       (pre-gate, no log row) — Phase 5 refuses
 *                                  to run with unset thresholds
 *   4. shadow decision's rejectReason, which in first-failing-clause order is:
 *        deterministic:<sub>
 *        persistence:<sub>
 *        expectancy_no_bucket_match
 *        expectancy_below_min_samples
 *        expectancy_horizon_missing
 *        ml_readiness_not_confirmed
 *        ml_unavailable
 *        ml_horizon_mismatch
 *        ml_probability_invalid
 *        ml_below_threshold
 *        ev_below_threshold
 *   5. null → allowed (all clauses passed)
 *
 * Persistence state is still module-level so the runner does not need
 * to thread a per-cycle context through StrategyDefinition.generator.
 * Tests call `resetLobMboScalpPersistenceState()` between cases to
 * isolate.
 */

import type { MarketSnapshot, IndicatorConfig, SetupFamily } from '../types.js';
import type { LobSnapshot } from '../lob-client.js';
import type { SetupType } from '../../shared/strategy-ids.js';
import type { StrategyGeneratorEvaluation } from '../strategy-registry.js';

import {
  buildScalperStateVector,
  evaluateScalperDeterministicGate,
  evaluateScalperPersistenceGate,
  recordScalperDeterministicResult,
  readScalperPriorMlReadiness,
  emptyScalperPersistenceState,
  type ScalperPersistenceState,
  type ScalperStateVector,
  type ScalperDirection,
  type ScalperDeterministicGateConfig,
  type ScalperPersistenceConfig,
  type ScalperDeterministicVerdict,
  type ScalperPersistenceVerdict,
} from '../features/scalper-state.js';
import {
  lookupScalperExpectancy,
  type ScalperExpectancyBucketTable,
  type ScalperExpectancyEstimate,
  type ScalperHorizonSec,
} from '../features/scalper-expectancy-engine.js';
import {
  buildScalperShadowDecision,
  type ScalperShadowDecisionConfig,
  type ScalperShadowMlInput,
  type ScalperShadowDecision,
} from '../features/scalper-shadow-decision.js';
import type { ScalperMlDecision } from '../ml-entry/lob-mbo-scalp-client.js';
import {
  writeLobMboScalpCandidate,
  shouldSampleScalperReject,
} from '../log-writer.js';

const SETUP_FAMILY: SetupFamily = 'lob_mbo_scalp';

// ─── Module-owned persistence state ──────────────────────────────────────────

let _persistState: ScalperPersistenceState = emptyScalperPersistenceState();

/** Test-only: reset the module-level persistence state between cases. */
export function resetLobMboScalpPersistenceState(): void {
  _persistState = emptyScalperPersistenceState();
}

/** Test-only / inspection helper. */
export function peekLobMboScalpPersistenceState(): ScalperPersistenceState {
  return _persistState;
}

// ─── Module-owned generator options registration (Phase 6) ──────────────────
//
// The STRATEGY_REGISTRY entries call the direction-specific wrappers below
// with NO options — because `StrategyDefinition.generator` has a fixed
// 3-argument signature (snap, config, lobSnapshot) that the trend
// generators also conform to. To thread the Phase 5 required options
// (shadowDecisionConfig, expectancyTable, mlDecider) without widening
// the registry signature, the runner calls
// `registerScalperGeneratorOptions(options)` at startup and the wrappers
// look up that registration via the module-level variable.
//
// Tests that want to drive the core `generateLobMboScalp` directly
// continue to pass options explicitly — the registry path is ONLY used
// by the wrappers below and by STRATEGY_REGISTRY invocations.
//
// Until the runner calls `registerScalperGeneratorOptions`, the wrapper
// path emits `missing_shadow_config` — which is the intentional
// "refuse without explicit config" behavior. Unit tests lock this state
// so a regression that silently fills defaults can't slip through.

let _registeredGeneratorOptions: GenerateLobMboScalpOptions | null = null;

/**
 * Register a default options bag for the scalper generator wrappers
 * (`generateLobMboScalpLong` / `generateLobMboScalpShort`). The runner
 * calls this once at startup after loading the expectancy bucket table
 * and coefs; it can be called again to swap in a newly promoted model
 * set without restarting the process.
 */
export function registerScalperGeneratorOptions(options: GenerateLobMboScalpOptions | null): void {
  _registeredGeneratorOptions = options;
}

/** Read the currently registered options (or null if none). Test + inspection helper. */
export function peekScalperGeneratorOptions(): GenerateLobMboScalpOptions | null {
  return _registeredGeneratorOptions;
}

/** Test-only: clear the registered options so subsequent wrapper calls emit missing_shadow_config. */
export function _resetScalperGeneratorOptionsForTests(): void {
  _registeredGeneratorOptions = null;
}

// ─── Pre-gate reject reasons (no log row emitted) ───────────────────────────

const REASON_NO_LOB_SNAPSHOT = 'no_lob_snapshot';
const REASON_NO_SCALP_STATE = 'no_scalp_state';
const REASON_MISSING_SHADOW_CONFIG = 'missing_shadow_config';

// ─── Generator options (dependency injection surface) ───────────────────────

/**
 * Options for `generateLobMboScalp`. Phase 5 requires the caller to
 * supply the shadow decision config, the expectancy table, and an ML
 * decider. The normal production call path threads these from the
 * runner; tests can stub each independently.
 *
 * ML hook is a function, not a client config, so tests can feed a
 * deterministic value without spinning up a fake HTTP layer. The
 * runner wraps `getScalperMlDecision` in a thin closure that curries
 * the base URL + timeout from config.
 */
export interface GenerateLobMboScalpOptions {
  /** Override the deterministic gate config (defaults to DEFAULT_SCALPER_GATE_CONFIG). */
  deterministicConfig?: ScalperDeterministicGateConfig;
  /** Override the persistence gate config (defaults to DEFAULT_SCALPER_PERSISTENCE_CONFIG). */
  persistenceConfig?: ScalperPersistenceConfig;
  /** Inject an alternative persistence state (tests only). */
  persistenceStateOverride?: ScalperPersistenceState;

  /**
   * Phase 5 shadow decision config. REQUIRED — the generator refuses to
   * run with unset thresholds and emits `missing_shadow_config` when
   * omitted. Phase 6 plumbs this from `config/indicator-config.json`.
   */
  shadowDecisionConfig?: ScalperShadowDecisionConfig;

  /**
   * Phase 5 expectancy bucket table. Passed by the runner from
   * `loadScalperExpectancyTable`. `null` means "no table loaded" —
   * the shadow decision will reject with `expectancy_no_bucket_match`.
   */
  expectancyTable?: ScalperExpectancyBucketTable | null;

  /**
   * Phase 5 ML decider. SYNCHRONOUS — receives the expectancy-chosen
   * horizon and the raw features dict and returns a
   * `ScalperMlDecision` without awaiting. Must never throw.
   *
   * Required, not optional. When omitted, the generator emits
   * `missing_shadow_config` (same pre-gate refusal as a missing
   * shadowDecisionConfig) because Phase 5 refuses to run with
   * implicit defaults. The runner wires this in Phase 6 by calling
   * `computeScalperLogisticInference` from `features/scalper-inference.ts`
   * against a loaded coefs set, packaged as a sync closure. Tests inject
   * a stub returning a deterministic decision.
   *
   * The sync contract is deliberate: the generator must complete on a
   * single snapshot tick without awaiting a network round-trip. The
   * Phase 4.5 HTTP client remains available for offline verification
   * and batch scoring but is NEVER on the live decision path.
   */
  mlDecider?: (
    direction: ScalperDirection,
    horizonSec: ScalperHorizonSec,
    features: Record<string, number | null | undefined>,
  ) => ScalperMlDecision;
}

// ─── Helpers ────────────────────────────────────────────────────────────────

function reject(setupType: SetupType, reason: string): StrategyGeneratorEvaluation {
  return {
    setupType,
    setupFamily: SETUP_FAMILY,
    candidate: null,
    rejectionReasonPrimary: reason,
    rejectionReasonAll: [reason],
  };
}

/**
 * Project the camelCase scalper state vector onto the snake_case
 * feature dict expected by `/predict_lob_mbo_scalp`. Mirror of the
 * mapping in `scripts/ml/build_lob_mbo_scalp_dataset.py::STATE_VECTOR_FIELD_MAP`
 * — the trainer saw snake_case features so the serve-time features
 * must carry the same keys.
 *
 * Per-target `feature_order` in the loaded coefs artifact decides
 * which subset is read; the loader raises `missing_feature:<name>`
 * when an expected key is absent, so extra keys are harmless and the
 * projection intentionally copies every field present on the vector.
 */
function scalperStateVectorToMlFeatures(
  vec: ScalperStateVector,
): Record<string, number | null | undefined> {
  return {
    qi_1: vec.qi1,
    qi_3: vec.qi3,
    qi_5: vec.qi5,
    microprice: vec.microprice,
    microprice_edge_ticks: vec.micropriceEdgeTicks,
    ofi_250ms: vec.ofi250ms,
    ofi_1s: vec.ofi1s,
    ofi_3s: vec.ofi3s,
    z_ofi_250ms: vec.zOfi250ms,
    z_ofi_1s: vec.zOfi1s,
    z_ofi_3s: vec.zOfi3s,
    afi_250ms: vec.afi250ms,
    afi_1s: vec.afi1s,
    afi_3s: vec.afi3s,
    hazard_bid_1s: vec.hazardBid1s,
    hazard_ask_1s: vec.hazardAsk1s,
    abs_bid_1s: vec.absBid1s,
    abs_ask_1s: vec.absAsk1s,
    refill_bid_1s: vec.refillBid1s,
    refill_ask_1s: vec.refillAsk1s,
    sigma_1s_ticks: vec.sigma1sTicks,
    spread_ticks: vec.spreadTicks,
  };
}

/** A sentinel ML decision used when the generator short-circuits before any HTTP call. */
function syntheticMlSkip(
  direction: ScalperDirection,
  horizonSec: ScalperHorizonSec | null,
): ScalperMlDecision {
  return {
    ready: false,
    pFavorDirection: null,
    targetKey: horizonSec === null ? `${direction}_?` : `${direction}_${horizonSec}s`,
    direction,
    horizonSec: (horizonSec ?? 1) as 1 | 3 | 5,
    modelVersion: '',
    featureSchema: [],
    reason: 'ml_skipped_before_call',
    inferenceMs: 0,
    httpStatus: null,
  };
}

/**
 * Build the Phase 5 candidate log row. Every input seen by the combined
 * rule (state vector, raw verdicts, expectancy estimate, ML snapshot,
 * config thresholds, prior-readiness snapshot) flows into this record so
 * the JSONL line is a complete audit trail.
 *
 * The `sample_weight` is set by the caller based on sampling outcome.
 */
function buildScalperCandidateRecord(params: {
  setupType: SetupType;
  direction: ScalperDirection;
  tsMs: number;
  vec: ScalperStateVector;
  detVerdict: ScalperDeterministicVerdict;
  persistVerdict: ScalperPersistenceVerdict;
  expectancy: ScalperExpectancyEstimate;
  ml: ScalperMlDecision;
  shadowDecision: ScalperShadowDecision;
  sampleWeight: number;
}): Record<string, unknown> {
  return {
    ts_ms: params.tsMs,
    setup_type: params.setupType,
    setup_family: SETUP_FAMILY,
    direction: params.direction,
    scalper_state_vector: params.vec,
    deterministic_verdict: params.detVerdict,
    persistence_verdict: params.persistVerdict,
    expectancy: params.expectancy,
    ml_decision: {
      ready: params.ml.ready,
      p_favor_direction: params.ml.pFavorDirection,
      target_key: params.ml.targetKey,
      horizon_sec: params.ml.horizonSec,
      model_version: params.ml.modelVersion,
      feature_schema: params.ml.featureSchema,
      reason: params.ml.reason,
      inference_ms: params.ml.inferenceMs,
      http_status: params.ml.httpStatus,
    },
    shadow_decision: params.shadowDecision,
    // Legacy-compatible summary fields for Phase 4.3 dataset builder
    // consumers (all_gates_passed / reject_stage / reject_reason /
    // expectancy_ready / ml_ready / det_passed / persist_passed / …).
    // These mirror the Phase 4.1/4.3 shape so existing CSV columns keep
    // working without a schema bump.
    expectancy_ready: params.expectancy.bucket_source !== null,
    ml_ready: params.ml.ready,
    all_gates_passed: params.shadowDecision.allowed,
    reject_stage: deriveRejectStage(params.shadowDecision.rejectReason),
    reject_reason: params.shadowDecision.rejectReason ?? 'allowed',
    sample_weight: params.sampleWeight,
  };
}

/**
 * Map a shadow decision's reject reason onto a coarse stage bucket for
 * dashboards. The full reason is also preserved verbatim on the row —
 * this helper just coarsens for grouping.
 */
function deriveRejectStage(reason: string | null): string {
  if (reason === null) return 'emission';
  if (reason.startsWith('deterministic:')) return 'deterministic';
  if (reason.startsWith('persistence:')) return 'persistence';
  if (reason.startsWith('expectancy_')) return 'expectancy';
  if (reason.startsWith('ev_')) return 'expectancy';
  if (reason.startsWith('ml_')) return 'ml';
  return 'other';
}

// ─── Core generator ──────────────────────────────────────────────────────────

/**
 * Evaluate the scalper Phase 5 gate chain for a single (setup_type,
 * direction) pair. SYNCHRONOUS — the ML decider is a sync pure
 * function and the expectancy lookup is pure, so the whole chain
 * completes on a single tick without awaiting anything. This matches
 * the existing synchronous runner loop in
 * `strategy.ts::generateSignal` and keeps the scalper generator
 * interchangeable with trend generators from the runner's perspective.
 */
export function generateLobMboScalp(
  setupType: SetupType,
  direction: ScalperDirection,
  _snap: MarketSnapshot,
  _config: IndicatorConfig,
  lobSnapshot: LobSnapshot | null | undefined,
  options: GenerateLobMboScalpOptions = {},
): StrategyGeneratorEvaluation {
  // Step 1: lobSnapshot present? (pre-gate bailout)
  if (!lobSnapshot) {
    return reject(setupType, REASON_NO_LOB_SNAPSHOT);
  }

  // Step 2: build state vector (pre-gate bailout)
  const vec = buildScalperStateVector(lobSnapshot);
  if (vec === null) {
    return reject(setupType, REASON_NO_SCALP_STATE);
  }

  // Phase 5 refusal: shadow config AND ML decider are REQUIRED. No
  // silent defaults — the generator refuses to operate without both.
  const shadowConfig = options.shadowDecisionConfig;
  const mlDecider = options.mlDecider;
  if (!shadowConfig || !mlDecider) {
    return reject(setupType, REASON_MISSING_SHADOW_CONFIG);
  }

  // Step 3: deterministic gate (never throws)
  const detVerdict = evaluateScalperDeterministicGate(vec, direction, options.deterministicConfig);

  // Step 4: persistence gate — read BEFORE step 9 records the current result
  const nowMs = lobSnapshot.timestamp_ms;
  const persistState = options.persistenceStateOverride ?? _persistState;
  const persistVerdict = evaluateScalperPersistenceGate(
    persistState,
    direction,
    nowMs,
    options.persistenceConfig,
  );

  // Step 5: snapshot prior ML readiness BEFORE we record the current cycle
  const priorReadiness = readScalperPriorMlReadiness(persistState, direction, nowMs);

  // Step 6: expectancy lookup
  const expectancy = lookupScalperExpectancy(options.expectancyTable ?? null, {
    direction,
    vec,
    cost_ticks: shadowConfig.cost_ticks,
    min_n: shadowConfig.min_bucket_samples,
  });

  // Step 7: ML call AT the expectancy-chosen horizon.
  //
  // When the earlier gates already failed, OR the expectancy lookup did
  // not resolve a horizon winner, we MUST NOT call the ML service: the
  // ML model has no defined behavior at a null horizon, and calling it
  // would waste a network round-trip on a candidate we're already
  // rejecting. Instead we synthesize a `ml_skipped_before_call` decision
  // that carries through the shadow decision intact — the shadow rule
  // will then reject with the earlier failing clause and the log row
  // still captures that the ML call was deliberately skipped.
  const shouldSkipMl =
    !detVerdict.passed ||
    !persistVerdict.passed ||
    expectancy.max_ev_horizon_sec === null ||
    expectancy.bucket_source === null;

  let mlDecision: ScalperMlDecision;
  if (shouldSkipMl) {
    mlDecision = syntheticMlSkip(direction, expectancy.max_ev_horizon_sec);
  } else {
    const horizon = expectancy.max_ev_horizon_sec as ScalperHorizonSec;
    const features = scalperStateVectorToMlFeatures(vec);
    mlDecision = mlDecider(direction, horizon, features);
  }

  const mlShadowInput: ScalperShadowMlInput = {
    ready: mlDecision.ready,
    pFavorDirection: mlDecision.pFavorDirection,
    evaluatedHorizonSec:
      mlDecision.horizonSec === 1 || mlDecision.horizonSec === 3 || mlDecision.horizonSec === 5
        ? mlDecision.horizonSec
        : null,
    reason: mlDecision.reason,
    modelVersion: mlDecision.modelVersion,
  };

  // Step 8: build the shadow decision — this calls shouldAllowScalperEntry
  // internally and patches `allowed` + `rejectReason` in-place so the
  // record is the single source of truth.
  const shadowDecision = buildScalperShadowDecision({
    direction,
    vec,
    detVerdict,
    persistVerdict,
    expectancy,
    ml: mlShadowInput,
    priorReadiness,
    config: shadowConfig,
  });

  // Step 9: record BOTH deterministic result and current cycle's mlReady
  // flag so the next cycle's consecutive-ready guard sees this cycle.
  recordScalperDeterministicResult(
    persistState,
    direction,
    nowMs,
    detVerdict.passed,
    mlDecision.ready,
  );

  // Step 10: write one candidate log row.
  //
  // Allowed candidates are always logged (weight 1) — they are the rare
  // positive samples that drive training. Rejections go through the
  // Phase 4.1 sampler.
  let shouldWrite = true;
  let sampleWeight = 1;
  if (!shadowDecision.allowed) {
    const s = shouldSampleScalperReject();
    shouldWrite = s.sample;
    sampleWeight = s.weight;
  }

  if (shouldWrite) {
    writeLobMboScalpCandidate(
      buildScalperCandidateRecord({
        setupType,
        direction,
        tsMs: nowMs,
        vec,
        detVerdict,
        persistVerdict,
        expectancy,
        ml: mlDecision,
        shadowDecision,
        sampleWeight,
      }),
    );
  }

  // Step 11: return a StrategyGeneratorEvaluation. Phase 5 still returns
  // `candidate: null` for every row — the actual CandidateSetup
  // construction lands in a later phase once shadow-data validates the
  // gate. The reject reason carries through for Stage A telemetry.
  //
  // `allowed` returns the string 'allowed' so dashboards that bucket on
  // `rejectionReasonPrimary` can distinguish a pass from a reject
  // without rebuilding the shadow decision. Stage B suppression of
  // disallowed candidates will flip here once CandidateSetup is wired.
  const primaryReason = shadowDecision.allowed ? 'allowed' : (shadowDecision.rejectReason ?? 'allowed');
  return reject(setupType, primaryReason);
}

// ─── Thin direction-specific wrappers used by STRATEGY_REGISTRY ──────────────
//
// SYNCHRONOUS and registry-compatible. They read the module-level
// options bag registered by the runner at startup via
// `registerScalperGeneratorOptions`. When nothing is registered the
// wrappers still call the core generator — which then emits
// `missing_shadow_config` (the Phase 5 refuse-without-defaults path).
// This keeps tests that reset registration via
// `_resetScalperGeneratorOptionsForTests` deterministic.

export function generateLobMboScalpLong(
  snap: MarketSnapshot,
  config: IndicatorConfig,
  lobSnapshot: LobSnapshot | null | undefined,
): StrategyGeneratorEvaluation {
  const opts = _registeredGeneratorOptions ?? {};
  return generateLobMboScalp('lob_mbo_scalp_long', 'long', snap, config, lobSnapshot, opts);
}

export function generateLobMboScalpShort(
  snap: MarketSnapshot,
  config: IndicatorConfig,
  lobSnapshot: LobSnapshot | null | undefined,
): StrategyGeneratorEvaluation {
  const opts = _registeredGeneratorOptions ?? {};
  return generateLobMboScalp('lob_mbo_scalp_short', 'short', snap, config, lobSnapshot, opts);
}
