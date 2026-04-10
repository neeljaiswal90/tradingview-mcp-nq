#!/usr/bin/env python3
"""
ml_management_audit.py — Audit pipeline for management-ML behavior.

Reads runtime logs and produces a comprehensive report covering:
  - Action distribution and approval rates
  - Model versions used
  - Feature coverage and data quality tiers
  - Tier usage and fallback reasons
  - Splits by setup family, trade stage, and provenance
  - Realized outcomes by action category
  - Error analysis and inference latency
  - Summary classification (passive / error / blocked / approved)

Usage:
  python scripts/analysis/ml_management_audit.py
  python scripts/analysis/ml_management_audit.py --log-dir ./logs --out ./reports/ml_management_audit.md

Inputs:
  logs/ml_management_actions.jsonl
  logs/ml_management_features_*.jsonl (optional)
  logs/trades.jsonl
  models/catboost/*/training_meta.json (optional)
"""

from __future__ import annotations

import argparse
import glob
import json
import os
import sys
from collections import Counter, defaultdict
from datetime import datetime, timezone
from typing import Any


def read_jsonl(path: str) -> list[dict]:
    if not os.path.exists(path):
        return []
    records = []
    with open(path, "r", encoding="utf-8") as f:
        for line in f:
            line = line.strip()
            if not line:
                continue
            try:
                records.append(json.loads(line))
            except json.JSONDecodeError:
                continue
    return records


def read_jsonl_glob(pattern: str) -> list[dict]:
    records = []
    for fpath in sorted(glob.glob(pattern)):
        records.extend(read_jsonl(fpath))
    return records


def percentile(values: list[float], p: float) -> float:
    if not values:
        return 0.0
    s = sorted(values)
    k = (len(s) - 1) * p / 100.0
    f = int(k)
    c = f + 1
    if c >= len(s):
        return s[-1]
    return s[f] + (k - f) * (s[c] - s[f])


def build_report(
    actions: list[dict],
    features: list[dict],
    trades: list[dict],
    model_metas: dict[str, dict],
) -> str:
    lines: list[str] = []
    now = datetime.now(timezone.utc).isoformat(timespec="seconds")

    # Filter out non-primary action records (execution_intent, entry_ml_decision, etc.)
    primary_actions = [a for a in actions if not a.get("_type")]

    ts_list = [a.get("timestamp", "") for a in primary_actions if a.get("timestamp")]
    period_start = min(ts_list) if ts_list else "?"
    period_end = max(ts_list) if ts_list else "?"

    lines.append(f"# ML Management Audit Report")
    lines.append(f"")
    lines.append(f"**Generated:** {now}")
    lines.append(f"**Period:** {period_start[:19]} to {period_end[:19]}")
    lines.append(f"**Total action records:** {len(primary_actions)}")
    lines.append(f"**Feature payload records:** {len(features)}")
    lines.append(f"**Trade records:** {len(trades)}")
    lines.append("")

    # ── 1. Action Distribution ────────────────────────────────────────────
    lines.append("## 1. Action Distribution")
    lines.append("")
    action_counts = Counter(a.get("action", "UNKNOWN") for a in primary_actions)
    total = len(primary_actions) or 1

    lines.append("| Action | Count | % | Avg Confidence |")
    lines.append("|--------|-------|---|----------------|")
    for action_name, count in sorted(action_counts.items(), key=lambda x: -x[1]):
        pct = round(count / total * 100, 1)
        confs = [a.get("action_confidence", 0) for a in primary_actions if a.get("action") == action_name]
        avg_conf = round(sum(confs) / len(confs), 3) if confs else 0
        lines.append(f"| {action_name} | {count} | {pct}% | {avg_conf} |")
    lines.append("")

    # ── 2. Approval Rate ──────────────────────────────────────────────────
    lines.append("## 2. Approval Rate")
    lines.append("")
    approved = sum(1 for a in primary_actions if a.get("approved"))
    blocked = sum(1 for a in primary_actions if not a.get("approved"))
    lines.append("| Status | Count | % |")
    lines.append("|--------|-------|---|")
    lines.append(f"| Approved | {approved} | {round(approved/total*100,1)}% |")
    lines.append(f"| Blocked | {blocked} | {round(blocked/total*100,1)}% |")
    lines.append("")

    # Top rejection reasons
    rejection_counts = Counter(
        a.get("rejection_reason", "n/a")
        for a in primary_actions
        if not a.get("approved") and a.get("rejection_reason")
    )
    if rejection_counts:
        lines.append("### Top Rejection Reasons")
        lines.append("")
        lines.append("| Reason | Count |")
        lines.append("|--------|-------|")
        for reason, count in rejection_counts.most_common(10):
            lines.append(f"| {reason[:80]} | {count} |")
        lines.append("")

    # ── 3. Model Versions Used ────────────────────────────────────────────
    lines.append("## 3. Model Versions Used")
    lines.append("")
    version_counts = Counter(a.get("model_version", "unknown") for a in primary_actions)
    lines.append("| Version | Count | % |")
    lines.append("|---------|-------|---|")
    for ver, count in version_counts.most_common():
        lines.append(f"| {ver} | {count} | {round(count/total*100,1)}% |")
    lines.append("")

    # ── 4. Feature Coverage ───────────────────────────────────────────────
    if features:
        lines.append("## 4. Feature Coverage (from runtime feature logs)")
        lines.append("")

        # Data quality tier distribution
        tier_counts = Counter(f.get("_data_quality_tier", "unknown") for f in features)
        lines.append("### Data Quality Tier Distribution")
        lines.append("")
        lines.append("| Tier | Count | % |")
        lines.append("|------|-------|---|")
        ftotal = len(features) or 1
        for tier, count in sorted(tier_counts.items(), key=lambda x: -x[1]):
            lines.append(f"| {tier} | {count} | {round(count/ftotal*100,1)}% |")
        lines.append("")

        # Per-family coverage
        sys.path.insert(0, os.path.join(os.path.dirname(__file__), '..', '..', 'python-market-data-service'))
        try:
            from lob_features.ml_feature_registry import FEATURE_FAMILIES
            lines.append("### Per-Family Coverage")
            lines.append("")
            lines.append("| Family | Avg Non-Null % |")
            lines.append("|--------|----------------|")
            for family, feats in FEATURE_FAMILIES.items():
                coverages = []
                for f_name in feats:
                    non_null = sum(1 for rec in features if rec.get(f_name) is not None)
                    coverages.append(non_null / ftotal * 100)
                avg = round(sum(coverages) / len(coverages), 1) if coverages else 0
                lines.append(f"| {family} | {avg}% |")
            lines.append("")
        except ImportError:
            lines.append("*(Feature registry not available for family coverage analysis)*")
            lines.append("")
    else:
        lines.append("## 4. Feature Coverage")
        lines.append("")
        lines.append("*No runtime feature logs available (ml_management_features_*.jsonl not found).*")
        lines.append("")

    # ── 5. Tier Usage ─────────────────────────────────────────────────────
    tier_used_counts = Counter(a.get("tier_used", "none") for a in primary_actions)
    lines.append("## 5. Tier Usage")
    lines.append("")
    lines.append("| Tier | Count | % |")
    lines.append("|------|-------|---|")
    for tier, count in sorted(tier_used_counts.items(), key=lambda x: -x[1]):
        lines.append(f"| {tier} | {count} | {round(count/total*100,1)}% |")
    lines.append("")

    fallback_counts = Counter(
        a.get("fallback_reason", "none")
        for a in primary_actions if a.get("fallback_used")
    )
    if fallback_counts:
        lines.append("### Fallback Reasons")
        lines.append("")
        lines.append("| Reason | Count |")
        lines.append("|--------|-------|")
        for reason, count in fallback_counts.most_common():
            lines.append(f"| {reason} | {count} |")
        lines.append("")

    # ── 5b. Provenance × Tier Cross-Tab ──────────────────────────────────
    # Cross-tab from runtime feature log (has both _lob_data_source and _response_tier_used).
    # Shows which data quality tiers are actually receiving LOB-enriched features.
    if features:
        lines.append("### Provenance × Tier Cross-Tab")
        lines.append("")
        lines.append("*(from runtime feature log — each row is one inference call)*")
        lines.append("")

        prov_tier_counts: dict[tuple[str, str], int] = {}
        for f in features:
            prov = f.get("_lob_data_source", "unknown") or "unknown"
            tier = f.get("_response_tier_used") or "none"
            key = (prov, tier)
            prov_tier_counts[key] = prov_tier_counts.get(key, 0) + 1

        if prov_tier_counts:
            ftotal = len(features) or 1
            lines.append("| Provenance | Tier | Count | % |")
            lines.append("|------------|------|-------|---|")
            for (prov, tier), count in sorted(
                prov_tier_counts.items(), key=lambda x: -x[1]
            ):
                lines.append(f"| {prov} | {tier} | {count} | {round(count/ftotal*100,1)}% |")
            lines.append("")

    # ── 6. Splits by Trade Stage ──────────────────────────────────────────
    lines.append("## 6. Splits by Trade Stage")
    lines.append("")

    def classify_stage(a: dict) -> str:
        if a.get("action") == "NO_ACTION" and a.get("model_name") == "error":
            return "error"
        # Simple heuristic based on available fields
        ur = a.get("unrealized_r")
        if ur is not None and ur > 0.2:
            return "post_breakeven"
        return "pre_pt1"

    stage_data: dict[str, list[dict]] = defaultdict(list)
    for a in primary_actions:
        stage_data[classify_stage(a)].append(a)

    lines.append("| Stage | Actions | Avg Confidence | Approval Rate |")
    lines.append("|-------|---------|----------------|---------------|")
    for stage, stage_actions in sorted(stage_data.items()):
        n = len(stage_actions)
        avg_conf = round(sum(a.get("action_confidence", 0) for a in stage_actions) / max(n, 1), 3)
        approved_pct = round(sum(1 for a in stage_actions if a.get("approved")) / max(n, 1) * 100, 1)
        lines.append(f"| {stage} | {n} | {avg_conf} | {approved_pct}% |")
    lines.append("")

    # ── 7. Splits by Setup Family ─────────────────────────────────────────
    lines.append("## 7. Splits by Setup Family")
    lines.append("")
    setup_data: dict[str, list[dict]] = defaultdict(list)
    for a in primary_actions:
        setup = a.get("setup_type", "unknown")
        setup_data[setup].append(a)

    lines.append("| Setup | Actions | Dominant Tier | Approval Rate |")
    lines.append("|-------|---------|---------------|---------------|")
    for setup, setup_actions in sorted(setup_data.items(), key=lambda x: -len(x[1])):
        n = len(setup_actions)
        tier_dist = Counter(a.get("tier_used", "none") for a in setup_actions)
        dominant = tier_dist.most_common(1)[0][0] if tier_dist else "none"
        approved_pct = round(sum(1 for a in setup_actions if a.get("approved")) / max(n, 1) * 100, 1)
        lines.append(f"| {setup} | {n} | {dominant} | {approved_pct}% |")
    lines.append("")

    # ── 8. Realized Outcomes ──────────────────────────────────────────────
    lines.append("## 8. Realized Outcomes")
    lines.append("")

    trades_by_id = {t.get("trade_id"): t for t in trades if t.get("trade_id")}
    trade_ids_with_actions = set(a.get("trade_id") for a in primary_actions if a.get("trade_id"))
    matched_trades = [trades_by_id[tid] for tid in trade_ids_with_actions if tid in trades_by_id]

    if matched_trades:
        # Group actions by trade, find dominant action
        actions_by_trade: dict[str, list[dict]] = defaultdict(list)
        for a in primary_actions:
            tid = a.get("trade_id")
            if tid:
                actions_by_trade[tid].append(a)

        lines.append("| Category | Trades | Avg Final R | Win Rate |")
        lines.append("|----------|--------|-------------|----------|")

        for category, filter_fn in [
            ("All trades with ML", lambda a_list: True),
            ("Had approved exit suggestion", lambda a_list: any(
                a.get("approved") and a.get("action") in ("EXIT_ALL", "EXIT_PARTIAL") for a in a_list
            )),
            ("All actions passive/hold", lambda a_list: all(
                a.get("action") in ("NO_ACTION", "HOLD") for a in a_list
            )),
        ]:
            matching_tids = [
                tid for tid, a_list in actions_by_trade.items()
                if filter_fn(a_list) and tid in trades_by_id
            ]
            if matching_tids:
                final_rs = [
                    float(trades_by_id[tid].get("r_multiple", 0))
                    for tid in matching_tids
                    if trades_by_id[tid].get("r_multiple") is not None
                ]
                avg_r = round(sum(final_rs) / len(final_rs), 3) if final_rs else 0
                win_rate = round(sum(1 for r in final_rs if r > 0) / max(len(final_rs), 1) * 100, 1)
                lines.append(f"| {category} | {len(matching_tids)} | {avg_r} | {win_rate}% |")
        lines.append("")
    else:
        lines.append("*No trades matched with action records for outcome analysis.*")
        lines.append("")

    # ── 9. Error Analysis ─────────────────────────────────────────────────
    lines.append("## 9. Error Analysis")
    lines.append("")
    error_actions = [a for a in primary_actions if a.get("model_name") == "error"]
    lines.append(f"**Service errors:** {len(error_actions)} ({round(len(error_actions)/total*100,1)}%)")
    lines.append("")

    if error_actions:
        error_reasons = Counter(
            (a.get("rejection_reason") or "unknown")[:60]
            for a in error_actions
        )
        lines.append("| Error Type | Count |")
        lines.append("|-----------|-------|")
        for reason, count in error_reasons.most_common(10):
            lines.append(f"| {reason} | {count} |")
        lines.append("")

    # ── 10. Inference Latency ─────────────────────────────────────────────
    lines.append("## 10. Inference Latency")
    lines.append("")
    latencies = [a.get("inference_ms", 0) for a in primary_actions if a.get("inference_ms")]
    if latencies:
        lines.append("| Metric | Value |")
        lines.append("|--------|-------|")
        lines.append(f"| p50 | {round(percentile(latencies, 50), 1)}ms |")
        lines.append(f"| p95 | {round(percentile(latencies, 95), 1)}ms |")
        lines.append(f"| p99 | {round(percentile(latencies, 99), 1)}ms |")
        lines.append(f"| max | {round(max(latencies), 1)}ms |")
        lines.append(f"| mean | {round(sum(latencies)/len(latencies), 1)}ms |")
        lines.append("")

    # ── 11. Summary Classification ────────────────────────────────────────
    lines.append("## 11. Summary Classification")
    lines.append("")

    # Classify each action
    n_error = len(error_actions)
    n_passive = sum(1 for a in primary_actions
                    if a.get("action") in ("NO_ACTION", "HOLD") and a.get("model_name") != "error")
    n_blocked = sum(1 for a in primary_actions
                    if not a.get("approved") and a.get("model_name") != "error"
                    and a.get("action") not in ("NO_ACTION", "HOLD"))
    n_approved = sum(1 for a in primary_actions
                     if a.get("approved") and a.get("action") not in ("NO_ACTION", "HOLD"))

    lines.append(f"- **Service healthy + passive (HOLD/NO_ACTION):** {n_passive} ({round(n_passive/total*100,1)}%)")
    lines.append(f"- **Service errors:** {n_error} ({round(n_error/total*100,1)}%)")
    lines.append(f"- **Model suggested action, gate blocked:** {n_blocked} ({round(n_blocked/total*100,1)}%)")
    lines.append(f"- **Model suggested action, gate approved:** {n_approved} ({round(n_approved/total*100,1)}%)")
    lines.append("")

    # ── 12. Model Artifact Info ───────────────────────────────────────────
    if model_metas:
        lines.append("## 12. Model Artifacts")
        lines.append("")
        for tier, meta in sorted(model_metas.items()):
            lines.append(f"### {tier}")
            lines.append(f"- Generated: {meta.get('generated_at', 'unknown')}")
            lines.append(f"- Features: {meta.get('feature_count', '?')}")
            lines.append(f"- Schema: {meta.get('feature_schema_version', '?')}")
            lines.append(f"- Rows: {meta.get('total_valid_rows', '?')}")
            lines.append(f"- Trades: {meta.get('total_trades', '?')}")
            clf = meta.get("classifier", {}).get("metrics", {})
            if clf:
                lines.append(f"- Classifier AUC: {clf.get('roc_auc', '?')}")
            reg = meta.get("regressor", {}).get("metrics", {})
            if reg:
                lines.append(f"- Regressor R2: {reg.get('r2', '?')}")
            lines.append("")

    return "\n".join(lines)


def main():
    parser = argparse.ArgumentParser(description="ML Management Audit Pipeline")
    parser.add_argument("--log-dir", default="./logs")
    parser.add_argument("--model-dir", default="./models/catboost")
    parser.add_argument("--out", default="./reports/ml_management_audit.md")
    args = parser.parse_args()

    print(f"[AUDIT] Reading logs from: {args.log_dir}")
    print(f"[AUDIT] Reading models from: {args.model_dir}")

    # Load data
    actions = read_jsonl(os.path.join(args.log_dir, "ml_management_actions.jsonl"))
    features = read_jsonl_glob(os.path.join(args.log_dir, "ml_management_features*.jsonl"))
    trades = read_jsonl(os.path.join(args.log_dir, "trades.jsonl"))

    print(f"[AUDIT] Action records: {len(actions)}")
    print(f"[AUDIT] Feature payload records: {len(features)}")
    print(f"[AUDIT] Trade records: {len(trades)}")

    # Load model metadata
    model_metas: dict[str, dict] = {}
    # Check for tiered metadata
    for tier_dir in sorted(glob.glob(os.path.join(args.model_dir, "tier*"))):
        meta_path = os.path.join(tier_dir, "training_meta.json")
        if os.path.exists(meta_path):
            tier_name = os.path.basename(tier_dir)
            with open(meta_path) as f:
                model_metas[tier_name] = json.load(f)
    # Check for flat metadata
    flat_meta = os.path.join(args.model_dir, "training_meta.json")
    if os.path.exists(flat_meta) and "tier0" not in model_metas:
        with open(flat_meta) as f:
            model_metas["flat"] = json.load(f)

    # Build report
    report = build_report(actions, features, trades, model_metas)

    # Write output
    os.makedirs(os.path.dirname(args.out) or ".", exist_ok=True)
    with open(args.out, "w", encoding="utf-8") as f:
        f.write(report)

    print(f"[AUDIT] Report written to: {args.out}")


if __name__ == "__main__":
    main()
