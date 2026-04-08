# LOB/MBO Feature Schema

**Source of truth:** `lob_features/schema.py`
**Shared by:** Live sidecar, offline dataset builder, ML training pipeline

## Feature Groups

### BBO-derived (Phase 1)

| Feature | Type | Description |
|---------|------|-------------|
| `bid` | float | Best bid price |
| `ask` | float | Best ask price |
| `mid` | float | Midpoint: (bid + ask) / 2 |
| `bid_size` | int | Size at best bid |
| `ask_size` | int | Size at best ask |
| `spread_pts` | float | Ask - bid in points |
| `spread_ticks` | int | Spread in ticks (spread_pts / tick_size) |

### Depth-derived

| Feature | Type | Description |
|---------|------|-------------|
| `depth_imbalance_5` | float | (bid_depth - ask_depth) / total, 5 levels. Range [-1, 1] |
| `depth_imbalance_10` | float | Same, 10 levels |
| `total_bid_depth_10lvl` | int | Total contracts on bid side, 10 levels |
| `total_ask_depth_10lvl` | int | Total contracts on ask side, 10 levels |
| `large_bid_within_5pts` | bool | Resting bid order > 50 lots within 5 pts |
| `large_ask_within_5pts` | bool | Resting ask order > 50 lots within 5 pts |

### Trade-flow-derived

| Feature | Type | Description |
|---------|------|-------------|
| `cumulative_delta_10s` | float | Buy volume - sell volume, 10s window |
| `cumulative_delta_30s` | float | Same, 30s window |
| `cumulative_delta_60s` | float | Same, 60s window |
| `trade_flow_imbalance_10s` | float | buy_vol / total_vol, 10s. Range [0, 1] |
| `trade_flow_imbalance_30s` | float | Same, 30s window |

### MBO-derived aggregates

| Feature | Type | Description |
|---------|------|-------------|
| `cancel_add_ratio_10s` | float | Cancels / adds in 10s. High = spoofing |
| `replenishment_rate_10s` | float | Adds after executions / executions. High = level defended |
| `absorption_rate_10s` | float | Executed vol / added vol. High = level holding |
| `mean_order_lifetime_top_book` | float | Avg ms from add to cancel/execute at BBO |
| `aggressor_penetration_10s` | float | Avg levels penetrated by aggressive fills |
| `sweep_count_10s` | int | Executions that penetrated 3+ levels |

## Recording Contexts

| Context | Cadence | Trigger |
|---------|---------|---------|
| `session` | Every 5 seconds | Continuous while market data flows |
| `trade` | Every 1 second | Between `/trade_context/start` and `/trade_context/end` |
| `pre_entry` | Every 1 second | Between `/signal_context/start` and `/signal_context/end` |
| `post_exit` | Every 1 second for 30s | After `/trade_context/end` |

## Log Files

| File | Content | Cadence |
|------|---------|---------|
| `lob_snapshots.jsonl` | Full feature snapshots during trade/pre-entry/post-exit | 1s |
| `lob_session_snapshots.jsonl` | Full feature snapshots session-wide | 5s |
| `lob_events_compact.jsonl` | Individual trade events with trade_id | Per event |
| `execution_intents.jsonl` | Trade/signal context start/end markers | Per event |
| `execution_results.jsonl` | Trade end markers | Per event |
