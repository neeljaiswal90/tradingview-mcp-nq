import type { LogWriter } from './log-writer.js';
import { computeScoreV2 } from './scoring/score-v2.js';
import type { ExtensionFeatures } from './features/extension.js';
import type { DynamicRewardPlan } from './features/dynamic-reward-plan.js';
import type { MicrostructureScoreResult } from './features/microstructure-score.js';
import type { LobSnapshot } from './lob-client.js';
import type {
  CandidateSetup,
  DirectionalCandidate,
  IndicatorConfig,
  MarketRegime,
  MarketSnapshot,
  MultiTfBias,
  ScoringWeights,
} from './types.js';

export interface CandidateScoreV2WriteContext {
  logWriter: LogWriter;
  signalId: string;
  sessionId: string;
  symbol: string;
  snap: MarketSnapshot;
  bias: MultiTfBias;
  regime: MarketRegime;
  bestSetup: CandidateSetup;
  chosenCandidate: DirectionalCandidate | null;
  indicatorConfig: IndicatorConfig;
  scoringWeights: ScoringWeights;
  extension: ExtensionFeatures | null;
  microstructure: MicrostructureScoreResult | null;
  lob: LobSnapshot | null;
  rewardPlan: DynamicRewardPlan | null;
  appVersion: string;
  buildSha: string;
  configHash: string;
  selectedForExecution: boolean;
  executionAllowedFinal: boolean;
  shadowReason: string | null;
  registryEffectiveStatus: string | null;
  vetoFlags?: string[];
  reasonCodes?: string[];
}

export function writeCandidateScoreV2Telemetry(context: CandidateScoreV2WriteContext): void {
  const {
    logWriter,
    signalId,
    sessionId,
    symbol,
    snap,
    bias,
    regime,
    bestSetup,
    chosenCandidate,
    indicatorConfig,
    scoringWeights,
    extension,
    microstructure,
    lob,
    rewardPlan,
    appVersion,
    buildSha,
    configHash,
    selectedForExecution,
    executionAllowedFinal,
    shadowReason,
    registryEffectiveStatus,
  } = context;

  const chosenDirection = bestSetup.direction;
  const barMs = Date.parse(snap.timestamp_iso);
  const replayKey = `${Number.isFinite(barMs) ? barMs : 0}:${bestSetup.setup_type}:${chosenDirection}:0`;
  const layered = chosenCandidate?.layered;
  const breakdown = chosenCandidate?.scoreBreakdown;
  const finalLiveScore = bestSetup.confidence;
  const scoreV2Result = computeScoreV2({
    setup: bestSetup,
    snap,
    bias,
    regime,
    scoringWeights,
    indicatorConfig,
    extension,
    microstructure,
    lob,
    rewardPlan,
  });

  logWriter.writeCandidateScoreV2({
    candidate_scores_schema_version: 'v2',
    candidate_id: signalId,
    candidate_replay_key: replayKey,
    app_version: appVersion,
    build_sha: buildSha,
    config_hash: configHash,
    session_id: sessionId,
    strategy_id: bestSetup.setup_type,
    direction: chosenDirection,
    regime,
    timestamp: snap.timestamp_iso,
    symbol,
    selected_for_execution: selectedForExecution,
    execution_allowed_final: executionAllowedFinal,
    shadow_reason: shadowReason,
    registry_effective_status: registryEffectiveStatus,
    hard_gate_pass: chosenCandidate?.passedHardGates ?? false,
    veto_flags: [...(context.vetoFlags ?? [])],
    reason_codes: [...(context.reasonCodes ?? [])],
    raw_flat_score: breakdown?.total ?? finalLiveScore,
    flat_score_components: breakdown ?? null,
    final_live_score: finalLiveScore,
    structure_score: scoreV2Result.structure,
    timing_score: scoreV2Result.timing,
    payoff_score: scoreV2Result.payoff,
    layered_shadow_score: layered?.final_rank ?? null,
    score_v2_source: 'score_v2',
    score_v2_composite: scoreV2Result.composite,
    score_v2_components: scoreV2Result.components,
    microstructure_overlay: microstructure
      ? {
          total: microstructure.total,
          directional: microstructure.directional,
          imbalance: microstructure.imbalance,
          absorption: microstructure.absorption,
          queue: microstructure.queue,
          sweep: microstructure.sweep,
          profile: microstructure.profile,
        }
      : null,
    dynamic_rr_value: rewardPlan?.dynamic_min_rr ?? null,
    dynamic_rr_gate_pass: rewardPlan?.rr_gate_pass ?? null,
    dynamic_rr_components: rewardPlan?.rr_components ?? null,
    final_rank_100: scoreV2Result.rank_100,
  });
}
