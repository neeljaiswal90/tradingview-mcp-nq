#!/bin/bash
# Clean sensitivity sweep with unique directories (no reuse).
# Usage: nohup bash scripts/run-sweep-clean.sh > reports/sensitivity/sweep_v2.log 2>&1 &

set -e
cd "$(dirname "$0")/.."

CONFIG_PATH="config/indicator-config.json"
HIST_CONFIG="config/historical-config.json"
TO_UNIX="1773972000"
OUT_BASE="reports/sensitivity"
RUN_TAG="v2"

# Save baseline config
cp "$CONFIG_PATH" "$OUT_BASE/indicator-config-backup.json"

run_experiment() {
  local label=$1
  shift
  local overrides_json=$1

  echo ""
  echo "====== [$label] $(date) ======"
  echo "  overrides: $overrides_json"

  local logs_dir="logs/sweep_${RUN_TAG}_${label}"
  local out_dir="$OUT_BASE/${label}"

  # Use fresh directory (unique name per run)
  mkdir -p "$logs_dir" "$out_dir"

  # Write mutated config
  node -e "
    const fs = require('fs');
    const base = JSON.parse(fs.readFileSync('$OUT_BASE/indicator-config-backup.json','utf8'));
    const overrides = JSON.parse('$overrides_json');
    Object.assign(base, overrides);
    fs.writeFileSync('$CONFIG_PATH', JSON.stringify(base, null, 2));
    console.log('  config: min_rr=' + base.min_rr + ' min_conf=' + base.min_confidence + ' max_conf=' + base.max_confidence);
  "

  # Run replay to fresh directory
  echo "  running replay..."
  node dist/autotrade/historical/cli.js --config "$HIST_CONFIG" --to "$TO_UNIX" --out "$logs_dir" > "$logs_dir/_stdout.log" 2>&1
  local trade_count=$(node -e "console.log(JSON.parse(require('fs').readFileSync('$logs_dir/performance.json','utf8')).total_trades)" 2>/dev/null || echo "?")
  echo "  replay done: $trade_count trades"

  # Run analysis
  node scripts/analyze-replay.mjs "$logs_dir" "$out_dir" --label "$label" > /dev/null 2>&1
  node scripts/bin-results.mjs "$logs_dir" "$out_dir" > /dev/null 2>&1

  # Print headline
  if [ -f "$out_dir/${label}_metrics.json" ]; then
    node -e "
      const m = JSON.parse(require('fs').readFileSync('$out_dir/${label}_metrics.json','utf8')).headline;
      console.log('  RESULT: trades=' + m.total_trades + ' WR=' + m.win_rate_pct + '% E[R]=' + m.expectancy_r + ' PF=' + m.profit_factor + ' PnL=\$' + m.total_pnl_usd + ' MaxDD=\$' + m.max_drawdown_usd);
    "
  fi
  echo "  [$label] complete."
}

echo "=== Post-Refactor Sensitivity Sweep (clean run) ==="
echo "Started: $(date)"
echo "Run tag: $RUN_TAG"

run_experiment "baseline"                              '{}'
run_experiment "rr_1.85"                               '{"min_rr":1.85}'
run_experiment "rr_1.75"                               '{"min_rr":1.75}'
run_experiment "conf_7.2"                              '{"min_confidence":7.2}'
run_experiment "conf_6.8"                              '{"min_confidence":6.8}'
run_experiment "maxconf_disabled"                      '{"max_confidence":10.0}'
run_experiment "maxconf_8.9"                           '{"max_confidence":8.9}'
run_experiment "combined_rr1.85_conf7.2"               '{"min_rr":1.85,"min_confidence":7.2}'
run_experiment "combined_rr1.75_conf6.8_maxconf8.9"    '{"min_rr":1.75,"min_confidence":6.8,"max_confidence":8.9}'

# Restore baseline config
cp "$OUT_BASE/indicator-config-backup.json" "$CONFIG_PATH"
echo ""
echo "=== Restored baseline config ==="
echo "=== SWEEP COMPLETE: $(date) ==="
echo "SWEEP_V2_DONE" > "$OUT_BASE/.sweep_v2_done"
