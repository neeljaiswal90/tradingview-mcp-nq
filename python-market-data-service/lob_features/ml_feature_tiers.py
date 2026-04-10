"""
ml_feature_tiers.py — Tier definitions for management ML models.

Each tier defines a feature subset, training quality thresholds, and runtime
selection requirements. All feature lists are derived from the canonical
registry to prevent drift.

Tiers:
  tier0 — position/time/setup only (always trainable, always selectable)
  tier1 — tier0 + BBO/depth/trade-flow (requires fresh LOB data)
  tier3 — tier1 + advanced MBO (requires full microstructure)

Tier2 is intentionally skipped: no distinct feature set vs tier1 today.
"""

from __future__ import annotations

from .ml_feature_registry import (
    POSITION_NUMERIC_FEATURES,
    LOB_NUMERIC_FEATURES,
    ADVANCED_MBO_FEATURES,
    CATEGORICAL_FEATURES,
)


TIER_DEFINITIONS: dict[str, dict] = {
    "tier0": {
        "name": "position_only",
        "description": "Position/time/setup features only",
        "numeric_features": list(POSITION_NUMERIC_FEATURES),
        "categorical_features": list(CATEGORICAL_FEATURES),
        "required_families": ["position", "categorical"],
        # Runtime selection: always selectable (no LOB needed)
        "runtime_required_fields": [],
        "runtime_max_bbo_age_ms": None,  # no BBO freshness check
        # Training thresholds (conservative)
        "min_rows": 50,
        "min_trades": 10,
        "min_family_coverage": {},
        "min_row_completeness": 0.0,
    },
    "tier1": {
        "name": "position_plus_lob",
        "description": "Position + BBO/depth/trade-flow",
        "numeric_features": list(POSITION_NUMERIC_FEATURES) + list(LOB_NUMERIC_FEATURES),
        "categorical_features": list(CATEGORICAL_FEATURES),
        "required_families": ["position", "categorical", "lob_bbo", "lob_flow"],
        # Runtime selection: require fresh BBO + core depth + flow
        "runtime_required_fields": [
            "lob_spread_ticks", "lob_bid_size", "lob_ask_size",
            "lob_depth_imbalance_5",
            "lob_cumulative_delta_10s", "lob_trade_flow_imbalance_10s",
        ],
        "runtime_max_bbo_age_ms": 5000,
        # Training thresholds (moderate)
        "min_rows": 100,
        "min_trades": 15,
        "min_family_coverage": {
            "lob_bbo": 0.50,
            "lob_flow": 0.40,
        },
        "min_row_completeness": 0.0,
    },
    "tier3": {
        "name": "full_microstructure",
        "description": "All features including advanced MBO",
        "numeric_features": (
            list(POSITION_NUMERIC_FEATURES)
            + list(LOB_NUMERIC_FEATURES)
            + list(ADVANCED_MBO_FEATURES)
        ),
        "categorical_features": list(CATEGORICAL_FEATURES),
        "required_families": [
            "position", "categorical",
            "lob_bbo", "lob_flow", "lob_mbo", "adv_mbo",
        ],
        # Runtime selection: require fresh LOB + advanced MBO
        "runtime_required_fields": [
            "lob_spread_ticks", "lob_bid_size", "lob_ask_size",
            "lob_depth_imbalance_5",
            "lob_cumulative_delta_10s", "lob_trade_flow_imbalance_10s",
            "adv_cancel_replace_ratio_10s", "adv_queue_deterioration_bid_10s",
        ],
        "runtime_max_bbo_age_ms": 3000,  # tighter freshness for advanced tier
        # Training thresholds (strict — better to skip than train on mostly-null)
        "min_rows": 200,
        "min_trades": 20,
        "min_family_coverage": {
            "lob_bbo": 0.70,
            "lob_flow": 0.60,
            "lob_mbo": 0.50,
            "adv_mbo": 0.50,
        },
        "min_row_completeness": 0.60,
    },
}

# Ordered from highest to lowest priority for runtime selection
TIER_PRIORITY: list[str] = ["tier3", "tier1", "tier0"]
FALLBACK_TIER: str = "tier0"


def get_tier_features(tier: str) -> list[str]:
    """Return all features (numeric + categorical) for a given tier."""
    defn = TIER_DEFINITIONS[tier]
    return defn["numeric_features"] + defn["categorical_features"]


def get_tier_cat_indices(tier: str) -> list[int]:
    """Return categorical feature indices for CatBoost training."""
    features = get_tier_features(tier)
    cats = TIER_DEFINITIONS[tier]["categorical_features"]
    return [features.index(c) for c in cats]


def get_tier_feature_count(tier: str) -> int:
    """Return total feature count for a given tier."""
    return len(get_tier_features(tier))
