"""
loaders.py — Model loading and inference for the ML management service.

Loads the CatBoost walk-forward winner and provides a clean inference API.

Feature contract strategy
-------------------------
The loader enforces a strict three-way contract:

  artifact (training_meta.json)  ←→  registry (ml_feature_registry.py)  ←→  request (schemas.py)

At load time we compare the artifact's saved `feature_names` list against
the registry's ALL_FEATURES list.  If they differ in any way — different
names, different order, different count — the model is placed in an
INCOMPATIBLE state and inference is refused.

Why use the artifact as ground truth rather than silently adapting?
  • The artifact was trained on a specific feature vector shape.  Reordering
    or adding nulls for unknown columns is silently wrong, not recoverable.
  • The registry is the design target for the *next* artifact.  When registry
    and artifact agree, inference is safe.  When they diverge, the fix is to
    retrain, not to paper over it.
  • Explicit failure at startup is far better than silent wrong predictions
    in production.
"""

from __future__ import annotations

import json
import os
import sys
import time
from pathlib import Path
from typing import Any, Optional

from catboost import CatBoostClassifier, CatBoostRegressor

# ─── Import canonical feature list from the shared registry ──────────────────
# This is the DESIGN-TIME contract: what the current codebase expects.
# The loader also reads the ARTIFACT-TIME contract from training_meta.json.
sys.path.insert(0, os.path.join(os.path.dirname(__file__), '..', 'python-market-data-service'))
from lob_features.ml_feature_registry import (
    ALL_FEATURES,
    NUMERIC_FEATURES,
    CATEGORICAL_FEATURES,
    CAT_FEATURE_INDICES,
    FEATURE_SCHEMA_VERSION,
    FEATURE_COUNT,
)
from lob_features.ml_feature_tiers import (
    TIER_DEFINITIONS,
    TIER_PRIORITY,
    FALLBACK_TIER,
    get_tier_features,
    get_tier_cat_indices,
    get_tier_feature_count,
)

# Re-export for consumers
FEATURE_ORDER = ALL_FEATURES


# ─── Feature contract check ──────────────────────────────────────────────────

class FeatureContractError(RuntimeError):
    """Raised when the artifact's feature list doesn't match the registry."""


def check_feature_contract(
    artifact_features: list[str],
    registry_features: list[str],
    registry_version: str,
) -> str | None:
    """
    Compare the artifact's feature list against the registry.

    Returns None if compatible, or a human-readable error string if not.
    Checks: count, order, and individual names.
    """
    if len(artifact_features) != len(registry_features):
        return (
            f"Feature count mismatch: artifact has {len(artifact_features)}, "
            f"registry '{registry_version}' has {len(registry_features)}"
        )

    mismatches = [
        f"[{i}] artifact='{a}' registry='{r}'"
        for i, (a, r) in enumerate(zip(artifact_features, registry_features))
        if a != r
    ]
    if mismatches:
        return (
            f"Feature order/name mismatch ({len(mismatches)} positions): "
            + "; ".join(mismatches[:5])
            + (" ..." if len(mismatches) > 5 else "")
        )

    return None  # compatible


# ─── Model container ─────────────────────────────────────────────────────────

class ManagementModels:
    """
    Holds loaded model artifacts and provides inference.

    States:
      not_loaded       — load() has not been called yet
      loaded           — artifact loaded and feature contract verified
      incompatible     — artifact loaded but feature contract failed; inference refused
      load_failed      — artifact could not be read from disk
    """

    def __init__(self) -> None:
        self.classifier: Optional[CatBoostClassifier] = None
        self.regressor: Optional[CatBoostRegressor] = None

        # Identity
        self.model_name: str = ""
        self.model_version: str = ""

        # Feature contract
        self.feature_schema_version: str = FEATURE_SCHEMA_VERSION  # registry version
        self.feature_count: int = FEATURE_COUNT                    # registry count
        self.artifact_feature_names: list[str] = []
        self.artifact_feature_count: int = 0
        self.artifact_schema_version: str = "unknown"              # from meta if present

        # Contract result
        self.schema_compatible: bool = False
        self.schema_error: Optional[str] = None

        # Lifecycle
        self.loaded: bool = False      # True when artifact is on disk and parsed
        self.load_error: Optional[str] = None
        self.load_time: float = 0.0

    # ── Loading ───────────────────────────────────────────────────────────────

    def load(self, model_dir: str) -> None:
        """
        Load classifier and regressor from disk and validate the feature contract.

        Raises FileNotFoundError if the .cbm files are missing.
        Sets schema_compatible=False (not raises) if features don't match —
        the service stays up but degrades gracefully.
        """
        clf_path = os.path.join(model_dir, "hold_classifier.cbm")
        reg_path = os.path.join(model_dir, "remaining_r_regressor.cbm")
        meta_path = os.path.join(model_dir, "training_meta.json")

        if not os.path.exists(clf_path):
            raise FileNotFoundError(f"Classifier not found: {clf_path}")
        if not os.path.exists(reg_path):
            raise FileNotFoundError(f"Regressor not found: {reg_path}")

        t0 = time.time()

        self.classifier = CatBoostClassifier()
        self.classifier.load_model(clf_path)

        self.regressor = CatBoostRegressor()
        self.regressor.load_model(reg_path)

        # ── Read and enforce feature contract from training metadata ──────────
        if os.path.exists(meta_path):
            with open(meta_path, "r") as f:
                meta = json.load(f)

            self.model_name = "catboost_management"
            self.model_version = meta.get("generated_at", "unknown")
            # Schema version is stored in meta if the training script wrote it;
            # fall back to "v1_position_only" (22-feature era) as a safe default
            # so old artifacts don't silently claim compatibility.
            # "feature_schema_version" was added to CatBoost meta in the
            # same commit that introduced contract checking. Older artifacts
            # won't have it — use "unknown_pre_contract" to flag those clearly.
            self.artifact_schema_version = meta.get(
                "feature_schema_version", "unknown_pre_contract"
            )
            self.artifact_feature_names = meta.get("feature_names", [])
            self.artifact_feature_count = len(self.artifact_feature_names)
        else:
            # No metadata file — we cannot verify contract; refuse inference.
            self.model_name = "catboost_management"
            self.model_version = "unknown"
            self.artifact_schema_version = "no_meta_file"
            self.artifact_feature_names = []
            self.artifact_feature_count = 0
            self.schema_compatible = False
            self.schema_error = (
                f"training_meta.json not found in {model_dir}. "
                "Cannot verify feature contract. Inference refused until meta is available."
            )
            self.loaded = True
            self.load_time = round(time.time() - t0, 3)
            return

        # ── Contract check ────────────────────────────────────────────────────
        error = check_feature_contract(
            self.artifact_feature_names,
            FEATURE_ORDER,
            FEATURE_SCHEMA_VERSION,
        )
        if error:
            self.schema_compatible = False
            self.schema_error = error
            print(
                f"[ML-SERVICE] WARNING: Feature contract INCOMPATIBLE — inference disabled.\n"
                f"  {error}\n"
                f"  Artifact features: {self.artifact_feature_count}\n"
                f"  Registry features: {FEATURE_COUNT} ({FEATURE_SCHEMA_VERSION})\n"
                f"  Fix: retrain models against the current registry."
            )
        else:
            self.schema_compatible = True
            self.schema_error = None
            print(
                f"[ML-SERVICE] Feature contract OK: {self.artifact_feature_count} features "
                f"match registry {FEATURE_SCHEMA_VERSION}"
            )

        self.loaded = True
        self.load_time = round(time.time() - t0, 3)

    # ── Inference ─────────────────────────────────────────────────────────────

    def build_feature_vector(self, req: dict[str, Any]) -> list[Any]:
        """
        Build a feature vector in the exact order from the canonical registry.

        Train/serve contract (must be respected identically in training and here):

        1. FEATURE ORDER
           Iterate FEATURE_ORDER (= ALL_FEATURES from registry) exactly.
           The artifact's cat_feature_indices are positional — any reordering
           silently maps categoricals to numeric slots and produces garbage.

        2. CATEGORICAL FEATURES
           Raw Python strings — never integer-encoded before passing to CatBoost.
           Missing value → "unknown" (not None, not 0, not empty string).
           CatBoost handles the vocabulary internally.
           Training must pass the same "unknown" sentinel, not NaN or empty.

        3. NUMERIC FEATURES
           Cast to float via float(val). CatBoost handles Python None natively
           as missing (uses its built-in NaN branch in splits).
           Do NOT impute with 0, mean, or median before passing — let the model
           decide how to treat missing values via its trained split logic.

        4. NULL / MISSING SEMANTICS
           None (Python) represents "feature not available at this tick".
           This is distinct from 0.0 (feature available, value is zero).
           LOB features are None when the sidecar is offline or produced no data.
           Training rows must carry the same None (not 0.0) for the same scenario.

        5. CONTRACT ENFORCEMENT
           The artifact's training_meta.json['feature_names'] is compared against
           FEATURE_ORDER at load time. If they diverge, inference is refused.
           Fix: retrain against the current registry. Do not paper over mismatches.
        """
        vector: list[Any] = []
        for feat in FEATURE_ORDER:
            val = req.get(feat)
            if feat in CATEGORICAL_FEATURES:
                vector.append(str(val) if val is not None else "unknown")
            else:
                if val is not None and val != "":
                    try:
                        vector.append(float(val))
                    except (ValueError, TypeError):
                        vector.append(None)
                else:
                    vector.append(None)
        return vector

    def predict(self, req: dict[str, Any]) -> dict[str, Any]:
        """
        Run inference on a single feature vector.

        Raises RuntimeError if models are not loaded or feature contract is broken.
        Missing LOB/MBO features are passed as None — CatBoost handles natively.
        """
        if not self.loaded or self.classifier is None or self.regressor is None:
            raise RuntimeError("Models not loaded")

        if not self.schema_compatible:
            raise RuntimeError(
                f"Inference refused: feature contract incompatible. "
                f"{self.schema_error or 'See /health for details.'}"
            )

        vector = self.build_feature_vector(req)
        t0 = time.perf_counter()

        clf_probs = self.classifier.predict_proba([vector])[0]
        hold_prob = float(clf_probs[1])

        remaining_r = float(self.regressor.predict([vector])[0])

        inference_ms = round((time.perf_counter() - t0) * 1000, 2)

        return {
            "hold_prob": round(hold_prob, 4),
            "remaining_r": round(remaining_r, 4),
            "inference_ms": inference_ms,
        }


# ─── Tiered model container ─────────────────────────────────────────────────

class TieredManagementModels:
    """
    Manages multiple tier models and selects the best compatible one at inference.

    Loads tier-specific models from models/catboost/tier{0,1,3}/.
    Falls back to flat model (models/catboost/) as tier0 if no tier directories exist.
    """

    def __init__(self) -> None:
        self.tiers: dict[str, ManagementModels] = {}
        self.tier_priority = list(TIER_PRIORITY)
        self.available_tiers: list[str] = []
        self.loaded_at: str = ""
        self.model_dir: str = ""

    def load_all(self, base_dir: str) -> None:
        """Load all available tier models from base_dir/tier*/."""
        self.model_dir = base_dir
        self.loaded_at = time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())

        for tier in self.tier_priority:
            tier_dir = os.path.join(base_dir, tier)
            clf_path = os.path.join(tier_dir, "hold_classifier.cbm")
            if os.path.exists(clf_path):
                m = ManagementModels()
                try:
                    m.load(tier_dir)
                    if m.schema_compatible or m.loaded:
                        self.tiers[tier] = m
                        self.available_tiers.append(tier)
                        print(f"[ML-SERVICE] Tier {tier} loaded from {tier_dir}")
                except Exception as e:
                    print(f"[ML-SERVICE] Tier {tier} load failed: {e}")

        # Backward compat: if no tier dirs but flat model exists, load as tier0
        if not self.tiers:
            clf_path = os.path.join(base_dir, "hold_classifier.cbm")
            if os.path.exists(clf_path):
                m = ManagementModels()
                try:
                    m.load(base_dir)
                    if m.loaded:
                        self.tiers["tier0"] = m
                        self.available_tiers.append("tier0")
                        print(f"[ML-SERVICE] Flat model loaded as tier0 from {base_dir}")
                except Exception as e:
                    print(f"[ML-SERVICE] Flat model load failed: {e}")

        print(f"[ML-SERVICE] Available tiers: {self.available_tiers or 'none'}")

    def select_tier(
        self,
        req: dict,
        bbo_age_ms: float | None = None,
    ) -> tuple[str, ManagementModels, dict]:
        """
        Select the highest tier whose runtime requirements are met.

        Returns (tier_name, models, selection_metadata).
        """
        attempted: list[str] = []
        rejection_details: dict[str, str] = {}

        for tier in self.tier_priority:
            if tier not in self.tiers:
                continue
            attempted.append(tier)

            tier_def = TIER_DEFINITIONS[tier]
            tier_model = self.tiers[tier]

            # Check schema compatibility
            if not tier_model.schema_compatible:
                rejection_details[tier] = "schema_incompatible"
                continue

            # Check required fields are non-null
            required_fields = tier_def.get("runtime_required_fields", [])
            missing_fields = [f for f in required_fields if req.get(f) is None]
            if missing_fields:
                rejection_details[tier] = f"missing_required_fields: {missing_fields[:3]}"
                continue

            # Check BBO freshness
            max_bbo_age = tier_def.get("runtime_max_bbo_age_ms")
            if max_bbo_age is not None and bbo_age_ms is not None:
                if bbo_age_ms > max_bbo_age:
                    rejection_details[tier] = f"stale_bbo: {bbo_age_ms}ms > {max_bbo_age}ms"
                    continue

            # Secondary: check LOB family coverage >= 50%
            lob_features_in_tier = [
                f for f in get_tier_features(tier)
                if f.startswith("lob_") or f.startswith("adv_")
            ]
            if lob_features_in_tier:
                non_null = sum(1 for f in lob_features_in_tier if req.get(f) is not None)
                coverage = non_null / len(lob_features_in_tier)
                if coverage < 0.5:
                    rejection_details[tier] = f"insufficient_family_coverage: {coverage:.0%}"
                    continue

            # All checks passed — use this tier
            return tier, tier_model, {
                "fallback_used": tier != self.tier_priority[0],
                "fallback_reason": None,
                "attempted_tiers": attempted,
                "rejection_details": rejection_details,
            }

        # Fall back to tier0
        fallback = FALLBACK_TIER
        if fallback in self.tiers:
            # Determine fallback reason from the first rejected higher tier
            reason = "no_model_loaded"
            for t in self.tier_priority:
                if t in rejection_details:
                    reason = rejection_details[t].split(":")[0]
                    break
            return fallback, self.tiers[fallback], {
                "fallback_used": True,
                "fallback_reason": reason,
                "attempted_tiers": attempted,
                "rejection_details": rejection_details,
            }

        raise RuntimeError("No tier models available (not even tier0)")
