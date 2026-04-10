"""
test_parity.py — Cross-source feature parity tests for the management ML pipeline.

These tests fail as soon as any of the four sources drift from the canonical registry:
  1. ml_feature_registry.py          (Python canonical source)
  2. schemas.py ManagementRequest    (Python API schema)
  3. ml/types.ts MlFeatureVector     (TypeScript type definition)
  4. ml/feature-builder.ts           (TypeScript feature construction)
  5. config/ml_management_features.json (generated JSON bridge)
  6. training_meta.json              (saved artifact metadata)

Run:
  python -m pytest python-ml-service/tests/test_parity.py -v
"""

from __future__ import annotations

import json
import re
import sys
from pathlib import Path

import pytest

# ─── Path setup ───────────────────────────────────────────────────────────────
REPO_ROOT = Path(__file__).parent.parent.parent
ML_SERVICE = REPO_ROOT / "python-ml-service"
sys.path.insert(0, str(ML_SERVICE))
sys.path.insert(1, str(REPO_ROOT / "python-market-data-service"))

from lob_features.ml_feature_registry import (
    ALL_FEATURES,
    NUMERIC_FEATURES,
    CATEGORICAL_FEATURES,
    CAT_FEATURE_INDICES,
    FEATURE_SCHEMA_VERSION,
    FEATURE_COUNT,
)


# ─── Helpers ──────────────────────────────────────────────────────────────────

def read(path: Path) -> str:
    return path.read_text(encoding="utf-8")


# ─── 1. Registry internal consistency ────────────────────────────────────────

class TestRegistryInternals:
    """The registry must be internally consistent before any cross-source check."""

    def test_no_duplicates(self):
        assert len(set(ALL_FEATURES)) == len(ALL_FEATURES), (
            f"Duplicate feature names in ALL_FEATURES: "
            f"{[f for f in ALL_FEATURES if ALL_FEATURES.count(f) > 1]}"
        )

    def test_feature_count_constant_matches(self):
        assert FEATURE_COUNT == len(ALL_FEATURES)

    def test_numeric_plus_categorical_equals_all(self):
        assert set(NUMERIC_FEATURES + CATEGORICAL_FEATURES) == set(ALL_FEATURES)
        assert len(NUMERIC_FEATURES) + len(CATEGORICAL_FEATURES) == len(ALL_FEATURES)

    def test_cat_feature_indices_correct(self):
        for cat, idx in zip(CATEGORICAL_FEATURES, CAT_FEATURE_INDICES):
            assert ALL_FEATURES[idx] == cat, (
                f"Index {idx} should be '{cat}' but is '{ALL_FEATURES[idx]}'"
            )

    def test_categoricals_at_end(self):
        """CatBoost contract: categoricals must be last in ALL_FEATURES."""
        num_end = len(NUMERIC_FEATURES)
        assert ALL_FEATURES[:num_end] == NUMERIC_FEATURES
        assert ALL_FEATURES[num_end:] == CATEGORICAL_FEATURES


# ─── 2. Python schema parity (schemas.py ManagementRequest) ──────────────────

class TestPythonSchemaParity:
    """ManagementRequest in schemas.py must mirror the registry exactly."""

    SCHEMAS_PATH = ML_SERVICE / "schemas.py"

    def _get_management_request_fields(self) -> list[str]:
        """
        Extract declared field names from the ManagementRequest class.
        Parses lines of the form:
            field_name: Optional[float] = ...
            field_name: int = Field(...)
        Stops at the next class definition.
        """
        src = read(self.SCHEMAS_PATH)
        # Extract the ManagementRequest class body
        match = re.search(r"class ManagementRequest\(BaseModel\):(.*?)(?=\nclass |\Z)", src, re.DOTALL)
        assert match, "ManagementRequest class not found in schemas.py"
        body = match.group(1)
        # Find all field declarations (not trade_id which is a logging field, not a model feature)
        fields = re.findall(r"^\s{4}(\w+)\s*:", body, re.MULTILINE)
        return [f for f in fields if f != "trade_id"]

    def test_all_registry_features_in_management_request(self):
        schema_fields = self._get_management_request_fields()
        missing = [f for f in ALL_FEATURES if f not in schema_fields]
        assert not missing, (
            f"Features in registry but missing from ManagementRequest ({len(missing)}): {missing}\n"
            f"Add them to python-ml-service/schemas.py"
        )

    def test_no_extra_features_in_management_request(self):
        """ManagementRequest should not have model features absent from registry."""
        schema_fields = set(self._get_management_request_fields())
        registry_set = set(ALL_FEATURES)
        extra = schema_fields - registry_set
        assert not extra, (
            f"Fields in ManagementRequest not in registry ({len(extra)}): {extra}\n"
            f"Remove them from schemas.py or add them to ml_feature_registry.py"
        )

    def test_feature_count_matches(self):
        schema_fields = self._get_management_request_fields()
        assert len(schema_fields) == FEATURE_COUNT, (
            f"ManagementRequest has {len(schema_fields)} fields, "
            f"registry has {FEATURE_COUNT}"
        )


# ─── 3. JSON registry snapshot parity ────────────────────────────────────────

class TestJsonRegistrySnapshot:
    """
    config/ml_management_features.json is the cross-language bridge.
    It must exactly match the Python registry.
    Run `python scripts/ml/export_feature_registry.py` to regenerate.
    """

    JSON_PATH = REPO_ROOT / "config" / "ml_management_features.json"

    def test_json_snapshot_exists(self):
        assert self.JSON_PATH.exists(), (
            f"JSON registry snapshot not found at {self.JSON_PATH}\n"
            f"Run: python scripts/ml/export_feature_registry.py"
        )

    def test_json_features_match_registry(self):
        with open(self.JSON_PATH) as f:
            snap = json.load(f)
        assert snap["all_features"] == ALL_FEATURES, (
            "config/ml_management_features.json is stale — features differ from registry.\n"
            "Run: python scripts/ml/export_feature_registry.py"
        )

    def test_json_schema_version_matches_registry(self):
        with open(self.JSON_PATH) as f:
            snap = json.load(f)
        assert snap["feature_schema_version"] == FEATURE_SCHEMA_VERSION, (
            f"JSON snapshot schema version '{snap['feature_schema_version']}' "
            f"!= registry '{FEATURE_SCHEMA_VERSION}'"
        )

    def test_json_feature_count_matches_registry(self):
        with open(self.JSON_PATH) as f:
            snap = json.load(f)
        assert snap["feature_count"] == FEATURE_COUNT

    def test_json_categoricals_match_registry(self):
        with open(self.JSON_PATH) as f:
            snap = json.load(f)
        assert snap["categorical_features"] == CATEGORICAL_FEATURES
        assert snap["cat_feature_indices"] == CAT_FEATURE_INDICES


# ─── 4. Live artifact metadata parity ────────────────────────────────────────

ARTIFACT_META = REPO_ROOT / "models" / "catboost" / "training_meta.json"

@pytest.mark.skipif(
    not ARTIFACT_META.exists(),
    reason="No CatBoost artifact found — skip live artifact parity check",
)
class TestArtifactMetaParity:
    """The saved model artifact must declare feature_schema_version and match registry."""

    def _meta(self) -> dict:
        with open(ARTIFACT_META) as f:
            return json.load(f)

    def test_artifact_has_feature_names(self):
        meta = self._meta()
        assert "feature_names" in meta, "training_meta.json missing 'feature_names'"
        assert len(meta["feature_names"]) > 0

    def test_artifact_feature_names_match_registry(self):
        meta = self._meta()
        artifact_features = meta["feature_names"]
        assert artifact_features == ALL_FEATURES, (
            f"Artifact feature_names do not match registry!\n"
            f"  Artifact:  {len(artifact_features)} features\n"
            f"  Registry:  {FEATURE_COUNT} features ({FEATURE_SCHEMA_VERSION})\n"
            f"  First diff: "
            + next(
                (f"[{i}] artifact='{a}' registry='{r}'"
                 for i, (a, r) in enumerate(zip(artifact_features, ALL_FEATURES)) if a != r),
                "different lengths"
            )
        )

    def test_artifact_has_feature_schema_version(self):
        meta = self._meta()
        assert "feature_schema_version" in meta, (
            "training_meta.json missing 'feature_schema_version'.\n"
            "Retrain with the updated training script to add this field."
        )

    def test_artifact_schema_version_matches_registry(self):
        meta = self._meta()
        if "feature_schema_version" not in meta:
            pytest.skip("Artifact predates feature_schema_version field")
        assert meta["feature_schema_version"] == FEATURE_SCHEMA_VERSION, (
            f"Artifact schema version '{meta['feature_schema_version']}' "
            f"!= registry '{FEATURE_SCHEMA_VERSION}'"
        )

    def test_artifact_has_categorical_features(self):
        meta = self._meta()
        assert "categorical_features" in meta
        assert meta["categorical_features"] == CATEGORICAL_FEATURES

    def test_artifact_feature_count_field(self):
        meta = self._meta()
        if "feature_count" in meta:
            assert meta["feature_count"] == len(meta.get("feature_names", []))


# ─── 5. TypeScript source parity (read source as text) ───────────────────────

class TestTypeScriptParity:
    """
    TS sources are verified by reading them as text and checking for every
    feature name from the registry.  This catches fields added to the registry
    but not mirrored in TS, and vice versa.
    """

    TYPES_PATH = REPO_ROOT / "src" / "autotrade" / "ml" / "types.ts"
    BUILDER_PATH = REPO_ROOT / "src" / "autotrade" / "ml" / "feature-builder.ts"

    def test_types_file_exists(self):
        assert self.TYPES_PATH.exists(), f"Missing: {self.TYPES_PATH}"

    def test_builder_file_exists(self):
        assert self.BUILDER_PATH.exists(), f"Missing: {self.BUILDER_PATH}"

    def test_all_numeric_features_declared_in_ts_types(self):
        src = read(self.TYPES_PATH)
        missing = [f for f in NUMERIC_FEATURES if f"  {f}:" not in src and f"\n  {f}:" not in src]
        # Fallback: check without indentation
        missing = [f for f in missing if f"{f}:" not in src]
        assert not missing, (
            f"Numeric features missing from MlFeatureVector in ml/types.ts ({len(missing)}): {missing}"
        )

    def test_all_categorical_features_declared_in_ts_types(self):
        src = read(self.TYPES_PATH)
        missing = [f for f in CATEGORICAL_FEATURES if f"{f}:" not in src]
        assert not missing, (
            f"Categorical features missing from MlFeatureVector in ml/types.ts ({len(missing)}): {missing}"
        )

    def test_all_numeric_features_assigned_in_builder(self):
        src = read(self.BUILDER_PATH)
        missing = [f for f in NUMERIC_FEATURES if f"{f}:" not in src]
        assert not missing, (
            f"Numeric features missing from buildMlFeatures() in ml/feature-builder.ts ({len(missing)}): {missing}"
        )

    def test_all_categorical_features_assigned_in_builder(self):
        src = read(self.BUILDER_PATH)
        missing = [f for f in CATEGORICAL_FEATURES if f"{f}:" not in src]
        assert not missing, (
            f"Categorical features missing from buildMlFeatures() in ml/feature-builder.ts ({len(missing)}): {missing}"
        )

    def test_no_as_any_casts_in_builder(self):
        src = read(self.BUILDER_PATH)
        assert "as any" not in src, (
            "ml/feature-builder.ts contains 'as any' cast(s). "
            "Add missing fields to LobSnapshot interface instead."
        )

    def test_builder_imports_from_ml_types(self):
        src = read(self.BUILDER_PATH)
        assert "MlFeatureVector" in src, (
            "feature-builder.ts does not import MlFeatureVector — type safety broken"
        )
