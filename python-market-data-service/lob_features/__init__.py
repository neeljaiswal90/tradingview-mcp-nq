"""
lob_features — Shared LOB/MBO feature computation.

This module is the SINGLE SOURCE OF TRUTH for all microstructure feature math.
Both the live sidecar and the offline dataset builder import from here,
ensuring zero feature drift between live inference and training.
"""

from .schema import LobFeatureSnapshot, MBO_FEATURE_NAMES, BBO_FEATURE_NAMES, ALL_FEATURE_NAMES
from .rolling import RollingTradeBuffer, RollingDepthState, RollingMboAggregator
from .compute import compute_lob_features, compute_mbo_features
from .ml_feature_registry import (
    NUMERIC_FEATURES, CATEGORICAL_FEATURES, ALL_FEATURES,
    CAT_FEATURE_INDICES, LOB_NUMERIC_FEATURES, POSITION_NUMERIC_FEATURES,
    FEATURE_SCHEMA_VERSION, FEATURE_COUNT,
)
