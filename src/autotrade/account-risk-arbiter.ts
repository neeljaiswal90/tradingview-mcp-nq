import type { ContractRoot } from './contracts.js';
import type { MultiInstrumentConfig } from './instrument-config.js';

export interface EntryRequest {
  instrumentId: ContractRoot;
  side: 'long' | 'short';
  riskUsd: number;
  rankInputs: CandidateRankInputs;
}

export interface CandidateRankInputs {
  expected_r_post_cost: number | null;
  quality_band: string | null;
  confidence: number;
  data_quality_score: number;
  instrument_preference?: number;
}

export interface ArbiterDecision {
  approved: boolean;
  reason: string;
  score?: number;
  competing_instrument?: ContractRoot;
  competing_score?: number;
}

interface OpenPositionInfo {
  side: 'long' | 'short';
  riskUsd: number;
  openedAt: number;
}

const QUALITY_BAND_SCORE: Record<string, number> = { A: 3, B: 2, C: 1, D: 0 };

export function rankCandidate(inputs: CandidateRankInputs): number {
  if (inputs.expected_r_post_cost == null) return Number.NEGATIVE_INFINITY;

  return (
    inputs.expected_r_post_cost * 1.0 +
    (QUALITY_BAND_SCORE[inputs.quality_band ?? ''] ?? -1) * 0.3 +
    inputs.confidence * 0.05 +
    inputs.data_quality_score * 0.1 +
    (inputs.instrument_preference ?? 0)
  );
}

export class AccountRiskArbiter {
  private readonly config: MultiInstrumentConfig;
  private readonly accountEquity: number;
  private readonly openPositions = new Map<ContractRoot, OpenPositionInfo>();
  private readonly dailyPnl = new Map<ContractRoot, number>();

  constructor(config: MultiInstrumentConfig, accountEquity: number) {
    this.config = config;
    this.accountEquity = accountEquity;
  }

  requestEntry(request: EntryRequest): ArbiterDecision {
    if (this.config.global_kill_switch) {
      return { approved: false, reason: 'global_kill_switch' };
    }

    const maxPositions = this.config.max_simultaneous_positions ?? 1;
    if (this.openPositions.size >= maxPositions) {
      return {
        approved: false,
        reason: `max_positions_${maxPositions}_reached`,
      };
    }

    if (this.openPositions.has(request.instrumentId)) {
      return {
        approved: false,
        reason: `already_positioned_${request.instrumentId}`,
      };
    }

    const maxRiskPct = this.config.max_total_risk_pct ?? 3.0;
    const maxTotalRisk = this.accountEquity * (maxRiskPct / 100);
    const currentRisk = this.getTotalOpenRisk();
    if (currentRisk + request.riskUsd > maxTotalRisk) {
      return {
        approved: false,
        reason: `total_risk_exceeded_${(currentRisk + request.riskUsd).toFixed(0)}_vs_max_${maxTotalRisk.toFixed(0)}`,
      };
    }

    if (this.isGlobalDailyLimitHit()) {
      return { approved: false, reason: 'global_daily_loss_limit' };
    }

    return this.checkCorrelationPolicy(request);
  }

  arbitrateSimultaneous(requests: EntryRequest[]): Map<ContractRoot, ArbiterDecision> {
    const results = new Map<ContractRoot, ArbiterDecision>();

    if (this.config.global_kill_switch) {
      for (const request of requests) {
        results.set(request.instrumentId, { approved: false, reason: 'global_kill_switch' });
      }
      return results;
    }

    if ((this.config.correlated_exposure_policy ?? 'best_signal_only') !== 'best_signal_only') {
      for (const request of requests) {
        results.set(request.instrumentId, this.requestEntry(request));
      }
      return results;
    }

    const first = requests[0];
    if (!first) return results;

    const sameDirection = requests.every(request => request.side === first.side);
    if (!sameDirection) {
      for (const request of requests) {
        results.set(request.instrumentId, this.requestEntry(request));
      }
      return results;
    }

    const scored = requests.map(request => ({
      request,
      score: rankCandidate(request.rankInputs),
    }));

    scored.sort((left, right) => {
      if (right.score !== left.score) return right.score - left.score;
      return left.request.instrumentId.localeCompare(right.request.instrumentId);
    });

    const winner = scored[0];
    if (!winner || winner.score === Number.NEGATIVE_INFINITY) {
      for (const candidate of scored) {
        results.set(candidate.request.instrumentId, {
          approved: false,
          reason: 'correlated_exposure_no_quant_data',
          score: candidate.score,
        });
      }
      return results;
    }

    const winnerDecision = this.requestEntry(winner.request);
    winnerDecision.score = winner.score;
    results.set(winner.request.instrumentId, winnerDecision);

    for (const loser of scored.slice(1)) {
      results.set(loser.request.instrumentId, {
        approved: false,
        reason: 'correlated_exposure_ranked_out',
        score: loser.score,
        competing_instrument: winner.request.instrumentId,
        competing_score: winner.score,
      });
    }

    return results;
  }

  notifyPositionOpen(
    instrumentId: ContractRoot,
    side: 'long' | 'short',
    riskUsd: number,
  ): void {
    this.openPositions.set(instrumentId, {
      side,
      riskUsd,
      openedAt: Date.now(),
    });
  }

  notifyPositionClose(instrumentId: ContractRoot, pnlUsd: number): void {
    this.openPositions.delete(instrumentId);
    this.dailyPnl.set(instrumentId, (this.dailyPnl.get(instrumentId) ?? 0) + pnlUsd);
  }

  getOpenPositions(): ReadonlyMap<ContractRoot, OpenPositionInfo> {
    return this.openPositions;
  }

  getTotalOpenRisk(): number {
    let total = 0;
    for (const position of this.openPositions.values()) {
      total += position.riskUsd;
    }
    return total;
  }

  private checkCorrelationPolicy(request: EntryRequest): ArbiterDecision {
    const policy = this.config.correlated_exposure_policy ?? 'best_signal_only';
    switch (policy) {
      case 'allow_both':
        return { approved: true, reason: 'allow_both' };
      case 'best_signal_only':
        return { approved: true, reason: 'best_signal_only_single_request' };
      case 'opposite_only':
        for (const [instrumentId, position] of this.openPositions.entries()) {
          if (position.side === request.side) {
            return {
              approved: false,
              reason: `opposite_only_blocked_by_${instrumentId}`,
            };
          }
        }
        return { approved: true, reason: 'opposite_only_pass' };
    }
  }

  private isGlobalDailyLimitHit(): boolean {
    let total = 0;
    for (const pnl of this.dailyPnl.values()) {
      total += pnl;
    }
    const maxLoss = this.accountEquity * ((this.config.max_total_risk_pct ?? 3.0) / 100);
    return total <= -maxLoss;
  }
}
