/**
 * htf-zones.ts — Higher-Timeframe zone parsing, market-neutral context building,
 * and candidate-specific evaluation (scoring + veto).
 *
 * Data flow:
 *   TradingView "APP HTF Pivot Zones" study → getPineLabels() → parseHtfZoneLabel()
 *   → buildHtfContext() → MarketSnapshot.htf_context (market-neutral)
 *   → evaluateHtfForSetup() per candidate in strategy layer (directional)
 *
 * Label format (pipe-delimited key=value with prefix):
 *   APP_HTF_ZONE|KIND=RES|TF=60|LEVEL=19850.5|TOP=19855|BOTTOM=19846|ATR=7.2|PIVLEN=5|TS=1712678400000
 */

import type {
  HtfZone,
  HtfZoneKind,
  HtfContext,
  HtfSetupEvaluation,
  HtfZonesConfig,
  CandidateSetup,
  MarketSnapshot,
} from '../types.js';

// ─── Constants ─────────────────────────────────────────────────────────────

const LABEL_PREFIX = 'APP_HTF_ZONE';

/** Timeframe severity for sorting and tiebreaking. Higher = more severe. */
const TF_SEVERITY: Record<string, number> = { '15': 1, '60': 2, '240': 3 };

function tfSeverity(tf: string): number {
  return TF_SEVERITY[tf] ?? 0;
}

// ─── Default Config ────────────────────────────────────────────────────────

export const DEFAULT_HTF_ZONES_CONFIG: HtfZonesConfig = {
  enabled: true,
  study_filter: 'APP HTF Pivot Zones',
  max_labels: 200,
  hard_veto_enabled: false,
  hard_veto_timeframes: ['60', '240'],
  min_first_obstacle_rr: 0.8,
  warn_distance_atr: 0.75,
  hard_veto_inside_major_zone: true,
  allow_breakout_acceptance_override: true,
  score_penalty_15m_res: -0.4,
  score_penalty_1h_res: -0.75,
  score_penalty_4h_res: -1.0,
  score_penalty_obstacle_before_t1: -1.25,
  score_bonus_near_support: 0.25,
  score_bonus_reclaimed_support: 0.5,
};

// ─── Parser ────────────────────────────────────────────────────────────────

/**
 * Parse a single TradingView Pine label text into an HtfZone.
 * Returns null for non-HTF labels or unparseable text.
 * Distance fields are left null — populated by buildHtfContext().
 */
export function parseHtfZoneLabel(text: string): HtfZone | null {
  if (!text || !text.startsWith(LABEL_PREFIX + '|')) return null;

  const segments = text.slice(LABEL_PREFIX.length + 1).split('|');
  const kv: Record<string, string> = {};
  for (const seg of segments) {
    const eqIdx = seg.indexOf('=');
    if (eqIdx > 0) {
      kv[seg.slice(0, eqIdx)] = seg.slice(eqIdx + 1);
    }
  }

  const kind = kv['KIND'];
  if (kind !== 'RES' && kind !== 'SUP') return null;

  const tf = kv['TF'];
  if (!tf) return null;

  const level = parseFloat(kv['LEVEL'] ?? '');
  const top = parseFloat(kv['TOP'] ?? '');
  const bottom = parseFloat(kv['BOTTOM'] ?? '');
  if (isNaN(level) || isNaN(top) || isNaN(bottom)) return null;

  const atr = kv['ATR'] !== undefined ? parseFloat(kv['ATR']) : null;
  const pivotLen = kv['PIVLEN'] !== undefined ? parseInt(kv['PIVLEN'], 10) : null;
  const sourceTs = kv['TS'] !== undefined ? parseInt(kv['TS'], 10) : null;

  const id = `${kind}_${tf}_${level}_${sourceTs ?? 'na'}`;

  return {
    id,
    kind: kind as HtfZoneKind,
    timeframe: tf,
    level,
    top,
    bottom,
    atr: atr !== null && !isNaN(atr) ? atr : null,
    pivot_len: pivotLen !== null && !isNaN(pivotLen) ? pivotLen : null,
    source_ts: sourceTs !== null && !isNaN(sourceTs) ? sourceTs : null,
    distance_pts: null,
    distance_atr: null,
    contains_price: false,
  };
}

// ─── Context Builder ───────────────────────────────────────────────────────

interface RawPineLabels {
  studies: Array<{ name: string; labels: Array<{ text: string; price: number }> }>;
}

/**
 * Build market-neutral HTF context from Pine labels.
 * Dedupes labels, sorts zones, identifies nearest and inside-zone states.
 */
export function buildHtfContext(
  rawLabels: RawPineLabels | null,
  price: number,
  atr14: number | null,
): HtfContext {
  if (!rawLabels || !rawLabels.studies || rawLabels.studies.length === 0) {
    return emptyHtfContext();
  }

  // Parse all labels across all matched studies
  const allZones: HtfZone[] = [];
  let studyName: string | null = null;

  for (const study of rawLabels.studies) {
    if (!studyName) studyName = study.name;
    for (const label of study.labels) {
      const zone = parseHtfZoneLabel(label.text);
      if (zone) allZones.push(zone);
    }
  }

  if (allZones.length === 0) {
    return {
      study_present: true,
      study_name: studyName,
      fetched_at_iso: new Date().toISOString(),
      resistance_zones: [],
      support_zones: [],
      nearest_resistance: null,
      nearest_support: null,
      inside_resistance_zone: false,
      inside_support_zone: false,
    };
  }

  // Dedupe by kind + timeframe + level + source_ts
  const seen = new Set<string>();
  const deduped: HtfZone[] = [];
  for (const z of allZones) {
    const key = `${z.kind}_${z.timeframe}_${z.level}_${z.source_ts ?? 'na'}`;
    if (!seen.has(key)) {
      seen.add(key);
      deduped.push(z);
    }
  }

  // Enrich: distance and containment relative to current price
  for (const z of deduped) {
    z.contains_price = price >= z.bottom && price <= z.top;
    z.distance_pts = Math.round((z.level - price) * 100) / 100;
    z.distance_atr = atr14 && atr14 > 0
      ? Math.round((Math.abs(z.distance_pts) / atr14) * 10000) / 10000
      : null;
  }

  // Sort: contains_price desc → distance_atr asc → TF severity desc → source_ts desc
  deduped.sort((a, b) => {
    if (a.contains_price !== b.contains_price) return a.contains_price ? -1 : 1;
    const distA = a.distance_atr ?? Infinity;
    const distB = b.distance_atr ?? Infinity;
    if (distA !== distB) return distA - distB;
    const sevA = tfSeverity(a.timeframe);
    const sevB = tfSeverity(b.timeframe);
    if (sevA !== sevB) return sevB - sevA; // higher severity first
    return (b.source_ts ?? 0) - (a.source_ts ?? 0); // newest first
  });

  // Split into resistance / support
  const resistanceZones = deduped.filter(z => z.kind === 'RES');
  const supportZones = deduped.filter(z => z.kind === 'SUP');

  // Find nearest resistance: prefer inside zones, then closest above price.
  // Among inside zones, prefer higher-severity TF.
  const nearestResistance = findNearest(resistanceZones, price, 'RES');
  const nearestSupport = findNearest(supportZones, price, 'SUP');

  return {
    study_present: true,
    study_name: studyName,
    fetched_at_iso: new Date().toISOString(),
    resistance_zones: resistanceZones,
    support_zones: supportZones,
    nearest_resistance: nearestResistance,
    nearest_support: nearestSupport,
    inside_resistance_zone: resistanceZones.some(z => z.contains_price),
    inside_support_zone: supportZones.some(z => z.contains_price),
  };
}

/**
 * Find the nearest zone for a given kind.
 * Priority: inside zones (higher-severity TF wins) → closest non-inside zone.
 * For RES: prefer zones above price (positive distance_pts).
 * For SUP: prefer zones below price (negative distance_pts).
 */
function findNearest(zones: HtfZone[], price: number, kind: HtfZoneKind): HtfZone | null {
  // Inside zones first (already sorted by TF severity desc from the main sort)
  const inside = zones.filter(z => z.contains_price);
  if (inside.length > 0) {
    // Among inside zones, pick highest TF severity
    inside.sort((a, b) => tfSeverity(b.timeframe) - tfSeverity(a.timeframe));
    return inside[0] ?? null;
  }

  // Non-inside: for RES, find closest zone above price; for SUP, closest below
  const nonInside = zones.filter(z => !z.contains_price);
  if (kind === 'RES') {
    // Zones above price (distance_pts > 0), sorted by distance ascending
    const above = nonInside
      .filter(z => z.distance_pts !== null && z.distance_pts > 0)
      .sort((a, b) => (a.distance_pts ?? Infinity) - (b.distance_pts ?? Infinity));
    return above[0] ?? null;
  } else {
    // Zones below price (distance_pts < 0), sorted by absolute distance ascending
    const below = nonInside
      .filter(z => z.distance_pts !== null && z.distance_pts < 0)
      .sort((a, b) => Math.abs(a.distance_pts ?? Infinity) - Math.abs(b.distance_pts ?? Infinity));
    return below[0] ?? null;
  }
}

/** Safe empty context when study is absent or disabled. */
export function emptyHtfContext(): HtfContext {
  return {
    study_present: false,
    study_name: null,
    fetched_at_iso: null,
    resistance_zones: [],
    support_zones: [],
    nearest_resistance: null,
    nearest_support: null,
    inside_resistance_zone: false,
    inside_support_zone: false,
  };
}

// ─── Candidate-Specific Evaluation ─────────────────────────────────────────

/**
 * Evaluate HTF zone context for a specific candidate setup.
 * Computes first obstacle RR, location quality, score adjustments, and veto.
 * Called per-candidate in the strategy layer.
 */
export function evaluateHtfForSetup(
  htf: HtfContext,
  setup: CandidateSetup,
  snap: MarketSnapshot,
  config: HtfZonesConfig,
): HtfSetupEvaluation {
  const isLong = setup.direction === 'long';
  const entryMid = (setup.entry_low + setup.entry_high) / 2;
  const riskPts = setup.risk_pts;

  // Determine obstacle and support zones based on direction
  const obstacleZone = isLong ? htf.nearest_resistance : htf.nearest_support;
  const supportZone = isLong ? htf.nearest_support : htf.nearest_resistance;
  const insideObstacle = isLong ? htf.inside_resistance_zone : htf.inside_support_zone;
  const insideSupport = isLong ? htf.inside_support_zone : htf.inside_resistance_zone;

  // ── First obstacle RR ──────────────────────────────────────────────────
  let firstObstacleRr: number | null = null;
  if (riskPts > 0 && obstacleZone) {
    // Long: room = resistance bottom - entry; Short: room = entry - support top
    const room = isLong
      ? obstacleZone.bottom - entryMid
      : entryMid - obstacleZone.top;
    firstObstacleRr = Math.round((room / riskPts) * 100) / 100;
  }

  // ── Score adjustment ───────────────────────────────────────────────────
  let adjustment = 0;
  const factors: string[] = [];

  if (obstacleZone) {
    const distAtr = obstacleZone.distance_atr ?? Infinity;
    const tf = obstacleZone.timeframe;

    // Penalty based on proximity to obstacle, scaled by timeframe
    if (insideObstacle || distAtr < 1.5) {
      let penalty = 0;
      if (tf === '15') penalty = config.score_penalty_15m_res;
      else if (tf === '60') penalty = config.score_penalty_1h_res;
      else if (tf === '240') penalty = config.score_penalty_4h_res;

      if (penalty !== 0) {
        // Scale penalty: full penalty when inside or very close, reduced at distance
        const scale = insideObstacle ? 1.0 : Math.max(0, 1 - distAtr / 1.5);
        const scaledPenalty = Math.round(penalty * scale * 100) / 100;
        if (scaledPenalty !== 0) {
          adjustment += scaledPenalty;
          factors.push(`htf_${tf}_${isLong ? 'res' : 'sup'}_proximity:${scaledPenalty}`);
        }
      }
    }

    // Penalty when first obstacle is before T1
    if (firstObstacleRr !== null && firstObstacleRr < setup.rr_t1 && firstObstacleRr >= 0) {
      adjustment += config.score_penalty_obstacle_before_t1;
      factors.push(`htf_obstacle_before_t1:${config.score_penalty_obstacle_before_t1}`);
    }
  }

  // Bonus for support proximity (only when no close obstacle overhead)
  if (supportZone && insideSupport && (!obstacleZone || (obstacleZone.distance_atr ?? Infinity) > 1.5)) {
    adjustment += config.score_bonus_near_support;
    factors.push(`htf_support_proximity:+${config.score_bonus_near_support}`);
  }

  // ── Location quality ───────────────────────────────────────────────────
  let locationQuality: 'good' | 'warning' | 'poor' | null = null;
  if (obstacleZone) {
    const distAtr = obstacleZone.distance_atr ?? Infinity;
    if (insideObstacle || distAtr < config.warn_distance_atr) {
      locationQuality = 'poor';
    } else if (distAtr < 1.5) {
      locationQuality = 'warning';
    } else {
      locationQuality = 'good';
    }
  }

  // ── Hard veto ──────────────────────────────────────────────────────────
  let vetoed = false;
  let vetoReason: string | null = null;

  if (config.hard_veto_enabled) {
    // Inside major-TF obstacle zone
    if (config.hard_veto_inside_major_zone && insideObstacle && obstacleZone) {
      const tf = obstacleZone.timeframe;
      if (config.hard_veto_timeframes.includes(tf)) {
        // Check breakout acceptance override
        const canOverride = config.allow_breakout_acceptance_override && tf !== '240';
        const overridden = canOverride && checkBreakoutAccepted(snap, obstacleZone, isLong);

        if (!overridden) {
          vetoed = true;
          vetoReason = `inside_htf_${isLong ? 'resistance' : 'support'}_zone_${tf}`;
        }
      }
    }

    // Poor first obstacle RR (only when risk_pts > 0)
    if (!vetoed && firstObstacleRr !== null && firstObstacleRr < config.min_first_obstacle_rr) {
      const tf = obstacleZone?.timeframe ?? 'unknown';
      if (config.hard_veto_timeframes.includes(tf)) {
        const canOverride = config.allow_breakout_acceptance_override && tf !== '240';
        const overridden = canOverride && obstacleZone
          ? checkBreakoutAccepted(snap, obstacleZone, isLong)
          : false;

        if (!overridden) {
          vetoed = true;
          vetoReason = `poor_rr_to_first_obstacle_${firstObstacleRr}_tf_${tf}`;
        }
      }
    }
  }

  // ── Breakout accepted flag (informational even when veto is off) ──────
  const breakoutAccepted = obstacleZone
    ? checkBreakoutAccepted(snap, obstacleZone, isLong)
    : false;

  return {
    first_obstacle_rr: firstObstacleRr,
    location_quality: locationQuality,
    score_adjustment: Math.round(adjustment * 100) / 100,
    score_factors: factors,
    vetoed,
    veto_reason: vetoReason,
    breakout_accepted: breakoutAccepted,
    nearest_obstacle: obstacleZone,
    nearest_support_zone: supportZone,
  };
}

// ─── Breakout Acceptance ───────────────────────────────────────────────────

/**
 * Simple breakout acceptance check: price has closed above zone top (long)
 * or below zone bottom (short) on both 1m and 5m bars.
 */
function checkBreakoutAccepted(
  snap: MarketSnapshot,
  zone: HtfZone,
  isLong: boolean,
): boolean {
  const bars1m = snap.bars_1m;
  const bars5m = snap.bars_5m;
  if (bars1m.length === 0 || bars5m.length === 0) return false;

  const last1m = bars1m[bars1m.length - 1]!;
  const last5m = bars5m[bars5m.length - 1]!;

  if (isLong) {
    return last1m.close > zone.top && last5m.close > zone.top;
  } else {
    return last1m.close < zone.bottom && last5m.close < zone.bottom;
  }
}

// ─── Timeframe Ordinal Encoding (for ML) ───────────────────────────────────

/** Ordinal encoding for timeframes: null→0, 15→1, 60→2, 240→3. */
export function htfTimeframeOrdinal(tf: string | null | undefined): number {
  if (!tf) return 0;
  return TF_SEVERITY[tf] ?? 0;
}
