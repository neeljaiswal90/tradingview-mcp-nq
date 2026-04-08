#!/usr/bin/env python3
"""
export_feature_registry.py — Generate a machine-readable JSON snapshot of the
canonical management ML feature registry.

This JSON file is the cross-language bridge between the Python registry
(ml_feature_registry.py) and TypeScript tests (e2e-acceptance.test.ts).

Run:
  python scripts/ml/export_feature_registry.py
  # or at repo root:
  python -m scripts.ml.export_feature_registry

Output:
  config/ml_management_features.json

When to run:
  - Any time ml_feature_registry.py changes
  - Before running training scripts on a new feature schema
  - The TypeScript parity tests will fail if this file is stale

The output file should be committed to git alongside the registry change.
"""

from __future__ import annotations

import json
import os
import sys
from datetime import datetime, timezone
from pathlib import Path

REPO_ROOT = Path(__file__).parent.parent.parent
sys.path.insert(0, str(REPO_ROOT / "python-market-data-service"))

from lob_features.ml_feature_registry import (
    ALL_FEATURES,
    NUMERIC_FEATURES,
    CATEGORICAL_FEATURES,
    CAT_FEATURE_INDICES,
    FEATURE_SCHEMA_VERSION,
    FEATURE_COUNT,
)


def main() -> None:
    output_path = REPO_ROOT / "config" / "ml_management_features.json"
    output_path.parent.mkdir(parents=True, exist_ok=True)

    registry = {
        "_description": (
            "Auto-generated from python-market-data-service/lob_features/ml_feature_registry.py. "
            "Do not edit by hand. Regenerate with: python scripts/ml/export_feature_registry.py"
        ),
        "feature_schema_version": FEATURE_SCHEMA_VERSION,
        "feature_count": FEATURE_COUNT,
        "all_features": ALL_FEATURES,
        "numeric_features": NUMERIC_FEATURES,
        "categorical_features": CATEGORICAL_FEATURES,
        "cat_feature_indices": CAT_FEATURE_INDICES,
        "generated_at": datetime.now(timezone.utc).isoformat(),
    }

    with open(output_path, "w", encoding="utf-8") as f:
        json.dump(registry, f, indent=2)
        f.write("\n")

    print(f"[EXPORT] {FEATURE_COUNT} features ({FEATURE_SCHEMA_VERSION})")
    print(f"[EXPORT] Written to {output_path}")

    # Self-check: round-trip verify
    with open(output_path) as f:
        loaded = json.load(f)
    assert loaded["all_features"] == ALL_FEATURES, "Round-trip check failed"
    assert loaded["feature_count"] == FEATURE_COUNT, "Count mismatch"
    print("[EXPORT] Round-trip OK")


if __name__ == "__main__":
    main()
