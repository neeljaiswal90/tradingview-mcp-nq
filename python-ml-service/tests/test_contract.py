"""
test_contract.py — Tests for ML service startup, feature contract, and health reporting.

Run from repo root:
    cd python-ml-service
    python -m pytest tests/test_contract.py -v

Or:
    python -m pytest python-ml-service/tests/test_contract.py -v
"""

from __future__ import annotations

import importlib
import importlib.util
import json
import os
import sys
import tempfile
from pathlib import Path
from unittest.mock import MagicMock, patch

import pytest

# ─── Path setup ───────────────────────────────────────────────────────────────
# Insert ML service FIRST so `import schemas/loaders` resolve correctly.
# loaders.py will then insert python-market-data-service into sys.path[0],
# potentially shadowing this service's app.py.  We therefore load app.py
# explicitly by file path (as "ml_app") rather than via `import app`.
REPO_ROOT = Path(__file__).parent.parent.parent
ML_SERVICE = REPO_ROOT / "python-ml-service"
sys.path.insert(0, str(ML_SERVICE))
sys.path.insert(1, str(REPO_ROOT / "python-market-data-service"))


def _load_ml_app():
    """
    Load python-ml-service/app.py by absolute path and cache it as 'ml_app'
    in sys.modules.  Prevents the sidecar's app.py (added to sys.path by
    loaders.py) from shadowing it when tests run in a single process.
    """
    if "ml_app" in sys.modules:
        return sys.modules["ml_app"]
    spec = importlib.util.spec_from_file_location(
        "ml_app", str(ML_SERVICE / "app.py")
    )
    module = importlib.util.module_from_spec(spec)  # type: ignore[arg-type]
    sys.modules["ml_app"] = module
    spec.loader.exec_module(module)  # type: ignore[union-attr]
    return module


# Load eagerly at collection time so the module is cached before any test
# that calls `import app` might accidentally grab the sidecar's copy.
_ML_APP = _load_ml_app()


# ─── Import tests ─────────────────────────────────────────────────────────────

class TestImports:
    """Verify the service modules import cleanly."""

    def test_schemas_imports(self):
        from schemas import (
            ManagementRequest, ManagementResponse, ManagementAction,
            HealthResponse, EntryRequest, EntryPredictionResponse,
        )

    def test_loaders_imports(self):
        from loaders import ManagementModels, check_feature_contract, FEATURE_ORDER

    def test_registry_imports(self):
        from lob_features.ml_feature_registry import (
            ALL_FEATURES, FEATURE_SCHEMA_VERSION, FEATURE_COUNT,
        )

    def test_health_response_has_contract_fields(self):
        from schemas import HealthResponse
        fields = HealthResponse.model_fields
        assert "feature_schema_version" in fields
        assert "feature_count" in fields
        assert "schema_compatible" in fields
        assert "schema_error" in fields
        assert "entry_model_loaded" in fields
        assert "entry_model_status" in fields

    def test_app_imports_without_error(self):
        """Importing app.py must not raise even when no model dir exists."""
        # The lifespan loads models — we test only the module-level import here
        assert _ML_APP.app is not None


# ─── Feature contract logic ───────────────────────────────────────────────────

class TestCheckFeatureContract:
    """Unit tests for the check_feature_contract function."""

    def setup_method(self):
        from loaders import check_feature_contract
        self.check = check_feature_contract

    def test_identical_lists_returns_none(self):
        features = ["a", "b", "c"]
        assert self.check(features, features, "v1") is None

    def test_count_mismatch_returns_error(self):
        err = self.check(["a", "b"], ["a", "b", "c"], "v1")
        assert err is not None
        assert "count" in err.lower()
        assert "2" in err
        assert "3" in err

    def test_order_mismatch_returns_error(self):
        err = self.check(["a", "c", "b"], ["a", "b", "c"], "v1")
        assert err is not None
        assert "[1]" in err  # first mismatch at index 1

    def test_name_mismatch_returns_error(self):
        err = self.check(["a", "x", "c"], ["a", "b", "c"], "v1")
        assert err is not None
        assert "x" in err or "b" in err

    def test_many_mismatches_truncated(self):
        artifact = [f"feat_{i}" for i in range(10)]
        registry = [f"other_{i}" for i in range(10)]
        err = self.check(artifact, registry, "v1")
        assert err is not None
        assert "..." in err  # truncated after 5

    def test_empty_lists_match(self):
        assert self.check([], [], "v0") is None


# ─── ManagementModels without real artifacts ──────────────────────────────────

class TestManagementModelsNoArtifact:
    """Tests for model loading when no artifact files exist."""

    def test_initial_state_is_not_loaded(self):
        from loaders import ManagementModels
        m = ManagementModels()
        assert m.loaded is False
        assert m.schema_compatible is False

    def test_load_missing_classifier_raises(self):
        from loaders import ManagementModels
        m = ManagementModels()
        with pytest.raises(FileNotFoundError):
            m.load("/nonexistent/path")

    def test_predict_without_load_raises(self):
        from loaders import ManagementModels
        m = ManagementModels()
        with pytest.raises(RuntimeError, match="not loaded"):
            m.predict({})

    def test_predict_when_incompatible_raises(self):
        """If loaded but schema_compatible=False, predict must refuse."""
        from loaders import ManagementModels
        m = ManagementModels()
        # Simulate a loaded-but-incompatible state
        m.loaded = True
        m.schema_compatible = False
        m.schema_error = "count mismatch: 22 vs 45"
        m.classifier = MagicMock()
        m.regressor = MagicMock()

        with pytest.raises(RuntimeError, match="contract incompatible"):
            m.predict({"is_short": 0})


# ─── Feature contract against live registry ───────────────────────────────────

class TestFeatureContractVsRegistry:
    """Verify the registry is internally consistent."""

    def test_registry_has_no_duplicates(self):
        from lob_features.ml_feature_registry import ALL_FEATURES
        assert len(set(ALL_FEATURES)) == len(ALL_FEATURES)

    def test_registry_feature_count_matches_constant(self):
        from lob_features.ml_feature_registry import ALL_FEATURES, FEATURE_COUNT
        assert len(ALL_FEATURES) == FEATURE_COUNT

    def test_cat_feature_indices_valid(self):
        from lob_features.ml_feature_registry import ALL_FEATURES, CATEGORICAL_FEATURES, CAT_FEATURE_INDICES
        for cat, idx in zip(CATEGORICAL_FEATURES, CAT_FEATURE_INDICES):
            assert ALL_FEATURES[idx] == cat


# ─── ManagementModels with mock artifact ─────────────────────────────────────

class TestManagementModelsWithMockArtifact:
    """Tests for model loading and contract checking using a mock model directory."""

    def _make_meta(self, feature_names: list[str], tmpdir: str) -> str:
        """Write a training_meta.json and return the directory path."""
        meta = {
            "generated_at": "20260101_000000",
            "feature_names": feature_names,
            "feature_schema_version": "v3_advanced_mbo",
            "categorical_features": ["setup_type", "regime_at_entry"],
        }
        meta_path = os.path.join(tmpdir, "training_meta.json")
        with open(meta_path, "w") as f:
            json.dump(meta, f)
        return meta_path

    def test_no_meta_file_sets_incompatible(self):
        """A model dir with .cbm files but no meta should be marked incompatible."""
        from loaders import ManagementModels

        with tempfile.TemporaryDirectory() as tmpdir:
            # Create fake .cbm files (empty — won't load as real models)
            open(os.path.join(tmpdir, "hold_classifier.cbm"), "w").close()
            open(os.path.join(tmpdir, "remaining_r_regressor.cbm"), "w").close()
            # No training_meta.json

            m = ManagementModels()
            # Mock the actual CatBoost loading to avoid needing real artifacts
            with patch("loaders.CatBoostClassifier") as MockClf, \
                 patch("loaders.CatBoostRegressor") as MockReg:
                MockClf.return_value.load_model = MagicMock()
                MockReg.return_value.load_model = MagicMock()
                m.load(tmpdir)

            assert m.loaded is True
            assert m.schema_compatible is False
            assert m.schema_error is not None
            assert "training_meta.json" in m.schema_error

    def test_matching_features_sets_compatible(self):
        """Artifact feature list matching the registry → schema_compatible=True."""
        from loaders import ManagementModels, FEATURE_ORDER

        with tempfile.TemporaryDirectory() as tmpdir:
            open(os.path.join(tmpdir, "hold_classifier.cbm"), "w").close()
            open(os.path.join(tmpdir, "remaining_r_regressor.cbm"), "w").close()
            self._make_meta(FEATURE_ORDER, tmpdir)

            m = ManagementModels()
            with patch("loaders.CatBoostClassifier") as MockClf, \
                 patch("loaders.CatBoostRegressor") as MockReg:
                MockClf.return_value.load_model = MagicMock()
                MockReg.return_value.load_model = MagicMock()
                m.load(tmpdir)

            assert m.loaded is True
            assert m.schema_compatible is True
            assert m.schema_error is None
            assert m.artifact_feature_count == len(FEATURE_ORDER)

    def test_mismatched_features_sets_incompatible(self):
        """Artifact feature list differing from registry → schema_compatible=False."""
        from loaders import ManagementModels

        with tempfile.TemporaryDirectory() as tmpdir:
            open(os.path.join(tmpdir, "hold_classifier.cbm"), "w").close()
            open(os.path.join(tmpdir, "remaining_r_regressor.cbm"), "w").close()
            # 22-feature v1 schema (old artifact)
            old_features = [
                "is_short", "confidence_at_entry", "initial_risk_pts",
                "current_price", "stop_current", "quantity_remaining",
                "pnl_pts", "unrealized_r", "mfe_pts_so_far", "mae_pts_so_far",
                "time_in_trade_sec", "distance_to_stop_pts", "pt1_hit", "pt2_hit",
                "stop_at_breakeven", "trail_active", "trail_ratchet_count",
                "management_events_count", "entry_hour_utc", "tick_hour_utc",
                "setup_type", "regime_at_entry",
            ]
            self._make_meta(old_features, tmpdir)

            m = ManagementModels()
            with patch("loaders.CatBoostClassifier") as MockClf, \
                 patch("loaders.CatBoostRegressor") as MockReg:
                MockClf.return_value.load_model = MagicMock()
                MockReg.return_value.load_model = MagicMock()
                m.load(tmpdir)

            assert m.loaded is True
            assert m.schema_compatible is False
            assert m.schema_error is not None
            assert "22" in m.schema_error or "count" in m.schema_error.lower()


# ─── Live artifact contract check ─────────────────────────────────────────────

class TestLiveArtifactContract:
    """
    Check the actual artifact in models/catboost/ against the registry.
    Skipped if the artifact doesn't exist (CI without model files).
    """

    ARTIFACT_META = REPO_ROOT / "models" / "catboost" / "training_meta.json"

    @pytest.mark.skipif(
        not (REPO_ROOT / "models" / "catboost" / "training_meta.json").exists(),
        reason="No artifact found at models/catboost/ — skipping live contract check",
    )
    def test_live_artifact_matches_registry(self):
        from loaders import check_feature_contract, FEATURE_ORDER
        from lob_features.ml_feature_registry import FEATURE_SCHEMA_VERSION

        with open(self.ARTIFACT_META) as f:
            meta = json.load(f)

        artifact_features = meta.get("feature_names", [])
        error = check_feature_contract(artifact_features, FEATURE_ORDER, FEATURE_SCHEMA_VERSION)
        assert error is None, (
            f"Live artifact does not match registry!\n{error}\n\n"
            f"Artifact features ({len(artifact_features)}): {artifact_features}\n"
            f"Registry features ({len(FEATURE_ORDER)}): {FEATURE_ORDER}"
        )


# ─── Health response shape ─────────────────────────────────────────────────────

class TestHealthEndpoint:
    """Test the /health endpoint via FastAPI test client."""

    @pytest.fixture
    def client(self):
        from fastapi.testclient import TestClient
        return TestClient(_ML_APP.app)

    def test_health_returns_200(self, client):
        resp = client.get("/health")
        assert resp.status_code == 200

    def test_health_has_required_fields(self, client):
        data = client.get("/health").json()
        required = [
            "status", "uptime_sec",
            "model_loaded", "model_name", "model_version",
            "feature_schema_version", "feature_count",
            "schema_compatible", "schema_error",
            "entry_model_loaded", "entry_model_status",
        ]
        for field in required:
            assert field in data, f"Missing field: {field}"

    def test_health_entry_model_is_stub(self, client):
        data = client.get("/health").json()
        assert data["entry_model_loaded"] is False
        assert data["entry_model_status"] == "stub_disabled"

    def test_health_status_degraded_when_no_model(self, client):
        """When no artifact is present, status must not be 'ok'."""
        original_loaded = _ML_APP.models.loaded
        original_compatible = _ML_APP.models.schema_compatible
        try:
            _ML_APP.models.loaded = False
            _ML_APP.models.schema_compatible = False
            data = client.get("/health").json()
            assert data["status"] in ("degraded", "incompatible")
            assert data["model_loaded"] is False
        finally:
            _ML_APP.models.loaded = original_loaded
            _ML_APP.models.schema_compatible = original_compatible

    def test_health_status_incompatible_when_contract_broken(self, client):
        """schema_compatible=False → status must be 'incompatible'."""
        original_loaded = _ML_APP.models.loaded
        original_compatible = _ML_APP.models.schema_compatible
        original_error = _ML_APP.models.schema_error
        try:
            _ML_APP.models.loaded = True
            _ML_APP.models.schema_compatible = False
            _ML_APP.models.schema_error = "count mismatch: 22 vs 45"
            data = client.get("/health").json()
            assert data["status"] == "incompatible"
            assert data["schema_compatible"] is False
            assert data["schema_error"] is not None
        finally:
            _ML_APP.models.loaded = original_loaded
            _ML_APP.models.schema_compatible = original_compatible
            _ML_APP.models.schema_error = original_error


# ─── predict_management blocked when incompatible ─────────────────────────────

class TestPredictManagementContract:

    @pytest.fixture
    def client(self):
        from fastapi.testclient import TestClient
        return TestClient(_ML_APP.app)

    def _minimal_request(self) -> dict:
        """Minimal valid ManagementRequest payload."""
        return {
            "is_short": 0,
            "confidence_at_entry": 8.0,
            "initial_risk_pts": 10.0,
            "current_price": 24000.0,
            "stop_current": 23990.0,
            "quantity_remaining": 1.0,
            "pnl_pts": 5.0,
            "unrealized_r": 0.5,
            "mfe_pts_so_far": 8.0,
            "mae_pts_so_far": 2.0,
            "time_in_trade_sec": 120,
            "distance_to_stop_pts": 10.0,
            "pt1_hit": 0,
            "pt2_hit": 0,
            "stop_at_breakeven": 0,
            "trail_active": 0,
            "trail_ratchet_count": 0,
            "management_events_count": 1,
            "entry_hour_utc": 14,
            "tick_hour_utc": 14,
            "setup_type": "trend_pullback_long",
            "regime_at_entry": "trending_up",
        }

    def test_predict_management_503_when_not_loaded(self, client):
        original = _ML_APP.models.loaded
        try:
            _ML_APP.models.loaded = False
            resp = client.post("/predict_management", json=self._minimal_request())
            assert resp.status_code == 503
            assert "not loaded" in resp.json()["detail"].lower()
        finally:
            _ML_APP.models.loaded = original

    def test_predict_management_503_when_incompatible(self, client):
        orig_loaded = _ML_APP.models.loaded
        orig_compat = _ML_APP.models.schema_compatible
        orig_error = _ML_APP.models.schema_error
        try:
            _ML_APP.models.loaded = True
            _ML_APP.models.schema_compatible = False
            _ML_APP.models.schema_error = "count mismatch"
            resp = client.post("/predict_management", json=self._minimal_request())
            assert resp.status_code == 503
            detail = resp.json()["detail"]
            assert "incompatible" in detail.lower() or "contract" in detail.lower()
        finally:
            _ML_APP.models.loaded = orig_loaded
            _ML_APP.models.schema_compatible = orig_compat
            _ML_APP.models.schema_error = orig_error


# ─── predict_entry stub behaviour ─────────────────────────────────────────────

class TestPredictEntryStub:

    @pytest.fixture
    def client(self):
        from fastapi.testclient import TestClient
        return TestClient(_ML_APP.app)

    def _entry_request(self) -> dict:
        return {
            "direction_is_short": 0,
            "confidence_score": 8.0,
            "hour_utc": 14,
            "is_rth": 1,
            "is_opening_drive_window": 0,
            "setup_type": "trend_pullback_long",
            "regime_at_signal": "trending_up",
        }

    def test_predict_entry_returns_200(self, client):
        resp = client.post("/predict_entry", json=self._entry_request())
        assert resp.status_code == 200

    def test_predict_entry_model_name_is_stub(self, client):
        data = client.post("/predict_entry", json=self._entry_request()).json()
        assert data["model_name"] == "stub_no_model"

    def test_predict_entry_confidence_is_zero(self, client):
        """Confidence=0.0 signals 'no model opinion'."""
        data = client.post("/predict_entry", json=self._entry_request()).json()
        assert data["confidence"] == 0.0

    def test_predict_entry_reasons_expose_stub(self, client):
        data = client.post("/predict_entry", json=self._entry_request()).json()
        assert any("stub" in r or "not_trained" in r for r in data["reasons"])

    def test_predict_entry_confirmed_true_safe_default(self, client):
        """Stub always returns confirmed=True so it doesn't block entries."""
        data = client.post("/predict_entry", json=self._entry_request()).json()
        assert data["confirmed"] is True
