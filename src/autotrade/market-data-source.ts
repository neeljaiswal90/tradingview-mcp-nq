import type { LobBbo, LobHealthResult } from './lob-client.js';

export type LobHealthState = 'healthy' | 'degraded' | 'unhealthy';
export type LobRequiredFeed = 'bbo' | 'depth' | 'mbo';
export type MarketDataSource = 'bookmap' | 'tradingview';
export type MarketDataStartupAction =
  | 'use_bookmap'
  | 'fallback_to_tradingview'
  | 'fail_startup';

export interface MarketDataConfig {
  fallback_to_tradingview_on_unhealthy_lob?: boolean;
  lob_health_timeout_ms?: number;
  lob_max_staleness_ms?: number;
  lob_required_feed?: LobRequiredFeed;
}

export interface ResolvedMarketDataConfig {
  fallback_to_tradingview_on_unhealthy_lob: boolean;
  lob_health_timeout_ms: number;
  lob_max_staleness_ms: number;
  lob_required_feed: LobRequiredFeed;
}

export interface LobHealthProbeClient {
  getHealth(): Promise<LobHealthResult>;
  getBbo(): Promise<LobBbo>;
}

export interface LobSidecarReadiness {
  configured_lob_url: string;
  expected_symbol_root: string;
  reported_symbol_root: string | null;
  reported_source_alias: string | null;
  feed_provider: string | null;
  required_feed: LobRequiredFeed;
  state: LobHealthState;
  reason: string;
  issues: string[];
  source_connected: boolean | null;
  bbo_fresh: boolean | null;
  bbo_age_ms: number | null;
  update_count: number | null;
  trade_count: number | null;
  depth_levels_bid: number | null;
  depth_levels_ask: number | null;
  mbo_status: string | null;
  mbo_age_ms: number | null;
  health_payload: LobHealthResult | null;
  bbo_payload: LobBbo | null;
}

export interface MarketDataStartupSelection {
  instrument: string;
  configured_lob_url: string;
  lob_health_state: LobHealthState;
  market_data_source_selected: MarketDataSource | null;
  startup_action: MarketDataStartupAction;
  fallback_allowed: boolean;
  fallback_reason: string | null;
  lob_health: LobSidecarReadiness;
}

export const DEFAULT_MARKET_DATA_CONFIG: ResolvedMarketDataConfig = {
  fallback_to_tradingview_on_unhealthy_lob: true,
  lob_health_timeout_ms: 2_000,
  lob_max_staleness_ms: 1_500,
  lob_required_feed: 'depth',
};

const KNOWN_CONTRACT_ROOTS = ['MNQ', 'MES', 'NQ', 'ES'] as const;

function isFiniteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}

function normalizeOptionalString(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function pushIssue(issues: string[], code: string): void {
  if (!issues.includes(code)) {
    issues.push(code);
  }
}

function isLobHealthPayloadValid(health: LobHealthResult): boolean {
  return typeof health.status === 'string'
    && typeof health.source_connected === 'boolean'
    && typeof health.bbo_fresh === 'boolean'
    && isFiniteNumber(health.bbo_age_ms)
    && isFiniteNumber(health.update_count)
    && isFiniteNumber(health.trade_count)
    && isFiniteNumber(health.depth_levels_bid)
    && isFiniteNumber(health.depth_levels_ask)
    && isFiniteNumber(health.mbo_events_buffered)
    && typeof health.recording_context === 'string'
    && isFiniteNumber(health.uptime_sec);
}

function isLobBboPayloadValid(bbo: LobBbo): boolean {
  return isFiniteNumber(bbo.bbo_age_ms)
    && isFiniteNumber(bbo.timestamp_ms)
    && typeof bbo.source_connected === 'boolean'
    && isFiniteNumber(bbo.update_count)
    && typeof bbo.is_fresh === 'boolean'
    && isFiniteNumber(bbo.last_bbo_ts_ms);
}

export function deriveContractRootFromAlias(alias: string | null | undefined): string | null {
  const normalized = normalizeOptionalString(alias)?.toUpperCase() ?? null;
  if (!normalized) return null;
  for (const root of KNOWN_CONTRACT_ROOTS) {
    if (normalized.startsWith(root)) {
      return root;
    }
  }
  return null;
}

export function resolveMarketDataConfig(
  config?: MarketDataConfig | null,
): ResolvedMarketDataConfig {
  return {
    fallback_to_tradingview_on_unhealthy_lob:
      config?.fallback_to_tradingview_on_unhealthy_lob
      ?? DEFAULT_MARKET_DATA_CONFIG.fallback_to_tradingview_on_unhealthy_lob,
    lob_health_timeout_ms:
      config?.lob_health_timeout_ms
      ?? DEFAULT_MARKET_DATA_CONFIG.lob_health_timeout_ms,
    lob_max_staleness_ms:
      config?.lob_max_staleness_ms
      ?? DEFAULT_MARKET_DATA_CONFIG.lob_max_staleness_ms,
    lob_required_feed:
      config?.lob_required_feed
      ?? DEFAULT_MARKET_DATA_CONFIG.lob_required_feed,
  };
}

function buildReadinessResult(opts: {
  configuredLobUrl: string;
  expectedSymbolRoot: string;
  state: LobHealthState;
  reason: string;
  issues: string[];
  requiredFeed: LobRequiredFeed;
  healthPayload?: LobHealthResult | null;
  bboPayload?: LobBbo | null;
  feedProvider?: string | null;
  reportedAlias?: string | null;
  reportedSymbolRoot?: string | null;
}): LobSidecarReadiness {
  const health = opts.healthPayload ?? null;
  return {
    configured_lob_url: opts.configuredLobUrl,
    expected_symbol_root: opts.expectedSymbolRoot,
    reported_symbol_root: opts.reportedSymbolRoot ?? null,
    reported_source_alias: opts.reportedAlias ?? null,
    feed_provider: opts.feedProvider ?? null,
    required_feed: opts.requiredFeed,
    state: opts.state,
    reason: opts.reason,
    issues: opts.issues,
    source_connected: health?.source_connected ?? null,
    bbo_fresh: health?.bbo_fresh ?? null,
    bbo_age_ms: health?.bbo_age_ms ?? null,
    update_count: health?.update_count ?? null,
    trade_count: health?.trade_count ?? null,
    depth_levels_bid: health?.depth_levels_bid ?? null,
    depth_levels_ask: health?.depth_levels_ask ?? null,
    mbo_status: normalizeOptionalString(health?.mbo_status),
    mbo_age_ms: health?.mbo_age_ms ?? null,
    health_payload: opts.healthPayload ?? null,
    bbo_payload: opts.bboPayload ?? null,
  };
}

export async function probeLobSidecarReadiness(opts: {
  client: LobHealthProbeClient;
  configuredLobUrl: string;
  expectedSymbolRoot: string;
  config?: MarketDataConfig | null;
}): Promise<LobSidecarReadiness> {
  const config = resolveMarketDataConfig(opts.config);
  let health: LobHealthResult;
  try {
    health = await opts.client.getHealth();
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return buildReadinessResult({
      configuredLobUrl: opts.configuredLobUrl,
      expectedSymbolRoot: opts.expectedSymbolRoot,
      state: 'unhealthy',
      reason: 'health_endpoint_unreachable',
      issues: [`health_endpoint_unreachable:${message}`],
      requiredFeed: config.lob_required_feed,
    });
  }

  if (!isLobHealthPayloadValid(health)) {
    return buildReadinessResult({
      configuredLobUrl: opts.configuredLobUrl,
      expectedSymbolRoot: opts.expectedSymbolRoot,
      state: 'unhealthy',
      reason: 'health_payload_invalid',
      issues: ['health_payload_invalid'],
      requiredFeed: config.lob_required_feed,
      healthPayload: health,
      feedProvider: normalizeOptionalString(health.feed_provider),
      reportedAlias: normalizeOptionalString(health.source_alias),
      reportedSymbolRoot:
        normalizeOptionalString(health.source_symbol_root)
        ?? deriveContractRootFromAlias(health.source_alias),
    });
  }

  let bbo: LobBbo;
  try {
    bbo = await opts.client.getBbo();
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return buildReadinessResult({
      configuredLobUrl: opts.configuredLobUrl,
      expectedSymbolRoot: opts.expectedSymbolRoot,
      state: 'unhealthy',
      reason: 'bbo_endpoint_unreachable',
      issues: [`bbo_endpoint_unreachable:${message}`],
      requiredFeed: config.lob_required_feed,
      healthPayload: health,
      feedProvider: normalizeOptionalString(health.feed_provider),
      reportedAlias: normalizeOptionalString(health.source_alias),
      reportedSymbolRoot:
        normalizeOptionalString(health.source_symbol_root)
        ?? deriveContractRootFromAlias(health.source_alias),
    });
  }

  if (!isLobBboPayloadValid(bbo)) {
    return buildReadinessResult({
      configuredLobUrl: opts.configuredLobUrl,
      expectedSymbolRoot: opts.expectedSymbolRoot,
      state: 'unhealthy',
      reason: 'bbo_payload_invalid',
      issues: ['bbo_payload_invalid'],
      requiredFeed: config.lob_required_feed,
      healthPayload: health,
      bboPayload: bbo,
      feedProvider: normalizeOptionalString(health.feed_provider),
      reportedAlias: normalizeOptionalString(health.source_alias),
      reportedSymbolRoot:
        normalizeOptionalString(health.source_symbol_root)
        ?? deriveContractRootFromAlias(health.source_alias),
    });
  }

  const issues: string[] = [];
  const reportedAlias = normalizeOptionalString(health.source_alias);
  const reportedSymbolRoot =
    normalizeOptionalString(health.source_symbol_root)
    ?? deriveContractRootFromAlias(reportedAlias);
  const feedProvider = normalizeOptionalString(health.feed_provider);
  const expectedRoot = opts.expectedSymbolRoot.trim().toUpperCase();

  if (!health.source_connected) {
    pushIssue(issues, 'source_disconnected');
  }
  if (!health.bbo_fresh) {
    pushIssue(issues, 'bbo_not_fresh');
  }
  if (health.bbo_age_ms > config.lob_max_staleness_ms) {
    pushIssue(issues, 'bbo_stale');
  }
  if (bbo.bbo_age_ms > config.lob_max_staleness_ms) {
    pushIssue(issues, 'bbo_endpoint_stale');
  }
  if (!bbo.source_connected) {
    pushIssue(issues, 'bbo_source_disconnected');
  }
  if (bbo.bid === null || bbo.ask === null || bbo.mid === null) {
    pushIssue(issues, 'bbo_missing');
  }
  if (reportedSymbolRoot === null) {
    pushIssue(issues, 'source_symbol_root_unreported');
  } else if (reportedSymbolRoot !== expectedRoot) {
    pushIssue(
      issues,
      `source_symbol_root_mismatch:${reportedSymbolRoot}->${expectedRoot}`,
    );
  }

  switch (config.lob_required_feed) {
    case 'depth':
      if (health.depth_levels_bid <= 0 || health.depth_levels_ask <= 0) {
        pushIssue(issues, 'depth_unavailable');
      }
      break;
    case 'mbo':
      if (normalizeOptionalString(health.mbo_status) !== 'active') {
        pushIssue(issues, 'mbo_not_active');
      }
      if (!isFiniteNumber(health.mbo_age_ms) || health.mbo_age_ms > config.lob_max_staleness_ms) {
        pushIssue(issues, 'mbo_stale');
      }
      break;
    case 'bbo':
    default:
      break;
  }

  return buildReadinessResult({
    configuredLobUrl: opts.configuredLobUrl,
    expectedSymbolRoot: expectedRoot,
    state: issues.length === 0 ? 'healthy' : 'degraded',
    reason: issues[0] ?? 'healthy',
    issues,
    requiredFeed: config.lob_required_feed,
    healthPayload: health,
    bboPayload: bbo,
    feedProvider,
    reportedAlias,
    reportedSymbolRoot,
  });
}

export async function resolveMarketDataStartupSelection(opts: {
  client: LobHealthProbeClient;
  instrument: string;
  configuredLobUrl: string;
  expectedSymbolRoot: string;
  config?: MarketDataConfig | null;
}): Promise<MarketDataStartupSelection> {
  const config = resolveMarketDataConfig(opts.config);
  const lobHealth = await probeLobSidecarReadiness({
    client: opts.client,
    configuredLobUrl: opts.configuredLobUrl,
    expectedSymbolRoot: opts.expectedSymbolRoot,
    config,
  });

  if (lobHealth.state === 'healthy') {
    return {
      instrument: opts.instrument,
      configured_lob_url: opts.configuredLobUrl,
      lob_health_state: lobHealth.state,
      market_data_source_selected: 'bookmap',
      startup_action: 'use_bookmap',
      fallback_allowed: config.fallback_to_tradingview_on_unhealthy_lob,
      fallback_reason: null,
      lob_health: lobHealth,
    };
  }

  if (config.fallback_to_tradingview_on_unhealthy_lob) {
    return {
      instrument: opts.instrument,
      configured_lob_url: opts.configuredLobUrl,
      lob_health_state: lobHealth.state,
      market_data_source_selected: 'tradingview',
      startup_action: 'fallback_to_tradingview',
      fallback_allowed: true,
      fallback_reason: lobHealth.reason,
      lob_health: lobHealth,
    };
  }

  return {
    instrument: opts.instrument,
    configured_lob_url: opts.configuredLobUrl,
    lob_health_state: lobHealth.state,
    market_data_source_selected: null,
    startup_action: 'fail_startup',
    fallback_allowed: false,
    fallback_reason: lobHealth.reason,
    lob_health: lobHealth,
  };
}

export function formatMarketDataStartupLine(selection: MarketDataStartupSelection): string {
  const selected = selection.market_data_source_selected ?? 'none';
  const fallbackReason = selection.fallback_reason ?? 'none';
  return (
    `[MARKET-DATA] instrument=${selection.instrument} ` +
    `configured_lob_url=${selection.configured_lob_url} ` +
    `lob_health_state=${selection.lob_health_state} ` +
    `market_data_source_selected=${selected} ` +
    `fallback_allowed=${selection.fallback_allowed} ` +
    `fallback_reason=${fallbackReason} ` +
    `startup_action=${selection.startup_action}`
  );
}

export function formatMarketDataDetailLine(selection: MarketDataStartupSelection): string {
  const health = selection.lob_health;
  return (
    `[MARKET-DATA] instrument=${selection.instrument} ` +
    `required_feed=${health.required_feed} ` +
    `reported_symbol_root=${health.reported_symbol_root ?? 'unknown'} ` +
    `reported_source_alias=${health.reported_source_alias ?? 'unknown'} ` +
    `feed_provider=${health.feed_provider ?? 'unknown'} ` +
    `source_connected=${health.source_connected ?? 'unknown'} ` +
    `bbo_fresh=${health.bbo_fresh ?? 'unknown'} ` +
    `bbo_age_ms=${health.bbo_age_ms ?? 'unknown'} ` +
    `depth_levels=${health.depth_levels_bid ?? 'unknown'}/${health.depth_levels_ask ?? 'unknown'} ` +
    `mbo_status=${health.mbo_status ?? 'unknown'} ` +
    `mbo_age_ms=${health.mbo_age_ms ?? 'unknown'} ` +
    `issues=${health.issues.length > 0 ? health.issues.join('|') : 'none'}`
  );
}

export function formatMarketDataStartupFailure(selection: MarketDataStartupSelection): string {
  const health = selection.lob_health;
  return (
    `[STARTUP] Refusing to start ${selection.instrument} with TradingView fallback disabled: ` +
    `LOB sidecar at ${selection.configured_lob_url} is ${selection.lob_health_state}. ` +
    `reason=${selection.fallback_reason ?? health.reason} ` +
    `reported_symbol_root=${health.reported_symbol_root ?? 'unknown'} ` +
    `reported_source_alias=${health.reported_source_alias ?? 'unknown'} ` +
    `required_feed=${health.required_feed} ` +
    `issues=${health.issues.length > 0 ? health.issues.join(', ') : 'none'}`
  );
}
