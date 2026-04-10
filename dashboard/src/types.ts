/**
 * Frontend accessors for the shared dashboard contract.
 */

export type {
  DashboardSnapshot,
  DashboardAppMeta as AppMeta,
  DashboardKpis as Kpis,
  DashboardActiveTrade as ActiveTrade,
  DashboardManagement as Management,
  DashboardMarketState as MarketState,
  DashboardDirectionalAssessment as DirectionalAssessment,
  DashboardMlManagement as MlManagement,
  DashboardRecentTrade as RecentTrade,
  DashboardHtfContext as HtfContext,
  DashboardHtfZone as HtfZone,
  DashboardHtfSetupEval as HtfSetupEval,
  DashboardDeltaEvent,
  DashboardDeltaBatch,
  DirectionalSetupInfo,
  FreshnessMetadata,
  PnlPoint,
  SessionInfo,
} from '../../src/shared/dashboard-contract';

export { DASHBOARD_VERSION } from '../../src/shared/dashboard-contract';
