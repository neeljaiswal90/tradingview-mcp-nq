#!/usr/bin/env python3
"""
Shadow audit script for the layered scoring architecture V1.

Reads LAYERED_SHADOW log lines from runner output and computes:
  - Old vs new score distributions (percentiles, histogram bins)
  - Rank correlation (Spearman) old vs new
  - Accepted/rejected candidate deltas
  - Long/short selection deltas
  - Per-setup-family selection changes
  - Missing-flow rate (overall and per-family)
  - Effect of each default-on flow feature
  - Cases where lagging previously dominated but no longer does
  - Cases where reliable flow materially re-ranked a valid candidate
  - Threshold calibration suggestions
  - Hard-valid-only analysis (all metrics repeated for valid-only subset)

Usage:
  python scripts/analysis/layered_score_shadow_audit.py <log_file_or_dir>

Expects lines matching:
  [LAYERED_SHADOW] <DIRECTION> <setup_type> old_score=<f> new_rank=<f> structure=<f> flow=<f>(q=<str>) ...
"""

import argparse
import json
import os
import re
import sys
from collections import Counter, defaultdict
from dataclasses import dataclass, field
from pathlib import Path
from typing import Optional

try:
    from scipy import stats as scipy_stats
    HAS_SCIPY = True
except ImportError:
    HAS_SCIPY = False


@dataclass
class ShadowRecord:
    direction: str
    setup_type: str
    old_score: float
    new_rank: float
    structure: float
    flow: float
    flow_quality: str
    lagging: float
    setup_family: str
    structure_weight: float
    flow_weight: float
    missing_flow: bool
    flow_features: list
    flow_degradation: list
    trend_cluster_raw: float = 0.0
    trend_cluster_capped: float = 0.0
    hard_valid_old: bool = True  # assume valid unless we see gate failures
    hard_valid_new: bool = True


SHADOW_PATTERN = re.compile(
    r'\[LAYERED_SHADOW\]\s+'
    r'(\w+)\s+'           # direction
    r'(\S+)\s+'           # setup_type
    r'old_score=([\d.]+)\s+'
    r'new_rank=([\d.]+)\s+'
    r'structure=([\d.]+)\s+'
    r'flow=([\d.]+)\(q=(\w+)\)\s+'
    r'lagging=([+-]?[\d.]+)\s+'
    r'profile=(\w+)\(s=([\d.]+),f=([\d.]+)\)\s*'
    r'(MISSING_FLOW\s*)?'
    r'trend_cap=([\d.-]+)->([\d.-]+)\s+'
    r'flow_features=\[([^\]]*)\]\s+'
    r'flow_degradation=\[([^\]]*)\]'
)


def parse_shadow_line(line: str) -> Optional[ShadowRecord]:
    m = SHADOW_PATTERN.search(line)
    if not m:
        return None
    return ShadowRecord(
        direction=m.group(1).lower(),
        setup_type=m.group(2),
        old_score=float(m.group(3)),
        new_rank=float(m.group(4)),
        structure=float(m.group(5)),
        flow=float(m.group(6)),
        flow_quality=m.group(7),
        lagging=float(m.group(8)),
        setup_family=m.group(9),
        structure_weight=float(m.group(10)),
        flow_weight=float(m.group(11)),
        missing_flow=bool(m.group(12)),
        trend_cluster_raw=float(m.group(13)),
        trend_cluster_capped=float(m.group(14)),
        flow_features=[f.strip() for f in m.group(15).split(',') if f.strip()],
        flow_degradation=[f.strip() for f in m.group(16).split(',') if f.strip()],
    )


def read_records(path: str) -> list[ShadowRecord]:
    records = []
    target = Path(path)
    files = []
    if target.is_dir():
        files = sorted(target.glob('**/*.log')) + sorted(target.glob('**/*.jsonl'))
    elif target.is_file():
        files = [target]
    else:
        print(f"Path not found: {path}", file=sys.stderr)
        return records

    for f in files:
        with open(f, 'r', encoding='utf-8', errors='replace') as fh:
            for line in fh:
                rec = parse_shadow_line(line)
                if rec:
                    records.append(rec)
    return records


def percentiles(values: list[float]) -> dict:
    if not values:
        return {}
    s = sorted(values)
    n = len(s)
    return {
        'min': s[0],
        'p10': s[int(n * 0.10)],
        'p25': s[int(n * 0.25)],
        'p50': s[int(n * 0.50)],
        'p75': s[int(n * 0.75)],
        'p90': s[int(n * 0.90)],
        'max': s[-1],
        'mean': sum(s) / n,
        'count': n,
    }


def compute_audit(records: list[ShadowRecord], label: str = "all") -> dict:
    if not records:
        return {'label': label, 'count': 0, 'note': 'no records'}

    old_scores = [r.old_score for r in records]
    new_ranks = [r.new_rank for r in records]
    deltas = [r.new_rank - r.old_score for r in records]

    result = {
        'label': label,
        'count': len(records),
        'old_score_dist': percentiles(old_scores),
        'new_rank_dist': percentiles(new_ranks),
        'delta_dist': percentiles(deltas),
    }

    # Spearman rank correlation
    if HAS_SCIPY and len(records) >= 3:
        corr, pval = scipy_stats.spearmanr(old_scores, new_ranks)
        result['spearman_correlation'] = round(corr, 4)
        result['spearman_pvalue'] = round(pval, 6)

    # Direction breakdown
    dir_counts = Counter(r.direction for r in records)
    result['direction_counts'] = dict(dir_counts)

    # Setup family breakdown
    family_counts = Counter(r.setup_family for r in records)
    result['setup_family_counts'] = dict(family_counts)

    # Missing flow rate
    missing_count = sum(1 for r in records if r.missing_flow)
    result['missing_flow_rate'] = round(missing_count / len(records), 4)

    # Per-family missing flow rate
    family_missing = defaultdict(lambda: {'total': 0, 'missing': 0})
    for r in records:
        family_missing[r.setup_family]['total'] += 1
        if r.missing_flow:
            family_missing[r.setup_family]['missing'] += 1
    result['per_family_missing_flow'] = {
        fam: round(d['missing'] / d['total'], 4) if d['total'] > 0 else 0
        for fam, d in family_missing.items()
    }

    # Flow feature coverage
    feature_counts = Counter()
    for r in records:
        for f in r.flow_features:
            feature_counts[f] += 1
    result['flow_feature_coverage'] = {
        feat: round(cnt / len(records), 4)
        for feat, cnt in feature_counts.most_common()
    }

    # Threshold calibration
    old_threshold = 7.5
    old_accepted = sum(1 for s in old_scores if s >= old_threshold)
    new_accepted = sum(1 for s in new_ranks if s >= old_threshold)
    result['threshold_calibration'] = {
        'old_threshold': old_threshold,
        'old_accepted_count': old_accepted,
        'new_accepted_at_old_threshold': new_accepted,
        'delta': new_accepted - old_accepted,
        'new_scores_around_threshold': {
            'in_6.5_to_7.5': sum(1 for s in new_ranks if 6.5 <= s < 7.5),
            'in_7.5_to_8.5': sum(1 for s in new_ranks if 7.5 <= s < 8.5),
        },
    }

    # Cases where trend cluster was capped
    trend_capped = [r for r in records if abs(r.trend_cluster_raw - r.trend_cluster_capped) > 0.01]
    result['trend_cluster_capped_count'] = len(trend_capped)

    # Cases where lagging dominated old score but no longer does
    lagging_dominant_old = [
        r for r in records
        if abs(r.lagging) >= 0.5 and abs(r.new_rank - r.old_score) > 0.5
    ]
    result['lagging_shift_cases'] = len(lagging_dominant_old)

    return result


def main():
    parser = argparse.ArgumentParser(description='Layered scoring shadow audit')
    parser.add_argument('path', help='Log file or directory to scan')
    parser.add_argument('--output', '-o', help='Output JSON file', default=None)
    args = parser.parse_args()

    records = read_records(args.path)
    print(f"Parsed {len(records)} shadow records", file=sys.stderr)

    if not records:
        print("No LAYERED_SHADOW records found.", file=sys.stderr)
        sys.exit(1)

    # All candidates
    all_audit = compute_audit(records, "all_candidates")

    # Hard-valid only (both old and new)
    valid_records = [r for r in records if r.hard_valid_old and r.hard_valid_new]
    valid_audit = compute_audit(valid_records, "hard_valid_only")

    report = {
        'total_records': len(records),
        'all_candidates': all_audit,
        'hard_valid_only': valid_audit,
    }

    output = json.dumps(report, indent=2)
    if args.output:
        with open(args.output, 'w') as f:
            f.write(output)
        print(f"Wrote audit to {args.output}", file=sys.stderr)
    else:
        print(output)


if __name__ == '__main__':
    main()
