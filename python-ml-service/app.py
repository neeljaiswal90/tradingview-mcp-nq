"""
app.py — FastAPI inference service for ML-based position management.

Loads the CatBoost walk-forward winner and serves management predictions.

Endpoints:
  GET  /health              — service health, model status, feature contract
  POST /predict_management  — single-tick management decision
  POST /predict_entry       — entry timing (STUB — no model trained yet)

Start:
  cd python-ml-service
  uvicorn app:app --host 127.0.0.1 --port 5001

  Or from repo root:
  python python-ml-service/app.py

Feature contract
  The service enforces a strict contract between the saved artifact and the
  runtime feature registry.  If they disagree, /health reports status="incompatible"
  and /predict_management returns HTTP 503.  See loaders.py for details.
"""

from __future__ import annotations

import os
import sys
import time
from contextlib import asynccontextmanager

from fastapi import FastAPI, HTTPException
from fastapi.middleware.cors import CORSMiddleware

from schemas import (
    ManagementRequest,
    ManagementResponse,
    ManagementAction,
    HealthResponse,
    EntryRequest,
    EntryPredictionResponse,
)
from loaders import ManagementModels, TieredManagementModels

# ─── Global state ─────────────────────────────────────────────────────────────

models = ManagementModels()
tiered_models = TieredManagementModels()
START_TIME = time.time()

# Configurable thresholds for action policy
HOLD_THRESHOLD = 0.55       # P(hold) > this -> HOLD
EXIT_THRESHOLD = 0.30       # P(hold) < this -> EXIT_ALL
REDUCE_THRESHOLD = 0.40     # P(hold) between exit and hold -> consider partial
REMAINING_R_EXIT = -0.3     # predicted remaining R below this -> EXIT
BE_MOVE_R_TRIGGER = 0.2     # if unrealized_r > this and stop not at BE -> suggest BE


# ─── Lifespan (model loading) ────────────────────────────────────────────────

def _resolve_model_dir() -> str | None:
    env_dir = os.environ.get("MODEL_DIR", "")
    if env_dir:
        return env_dir
    candidates = [
        os.path.join(os.path.dirname(__file__), "..", "models", "catboost"),
        os.path.join(os.getcwd(), "models", "catboost"),
        "models/catboost",
    ]
    for c in candidates:
        if os.path.exists(os.path.join(c, "hold_classifier.cbm")):
            return c
    return None


@asynccontextmanager
async def lifespan(app: FastAPI):
    """Load models at startup, enforce feature contract, cleanup at shutdown."""
    model_dir = _resolve_model_dir()
    if not model_dir:
        print("[ML-SERVICE] WARNING: No model directory found. /predict_management will return 503.")
        print("[ML-SERVICE] Set MODEL_DIR env var or place artifacts in models/catboost/")
    else:
        try:
            models.load(model_dir)
            if models.schema_compatible:
                print(f"[ML-SERVICE] Ready. Model: {models.model_name} v{models.model_version}")
                print(f"[ML-SERVICE] Features: {models.artifact_feature_count} ({models.feature_schema_version})")
            else:
                # Loaded but incompatible — service starts in degraded mode
                print(f"[ML-SERVICE] DEGRADED: Model loaded but feature contract FAILED.")
                print(f"[ML-SERVICE]   {models.schema_error}")
                print(f"[ML-SERVICE]   /predict_management will return 503 until retrain.")
        except Exception as e:
            models.load_error = str(e)
            print(f"[ML-SERVICE] ERROR loading models: {e}")

        # Also load tiered models (additive — does not replace flat model)
        try:
            tiered_models.load_all(model_dir)
        except Exception as e:
            print(f"[ML-SERVICE] Tiered model loading failed (non-fatal): {e}")
    yield  # Server runs here
    print("[ML-SERVICE] Shutting down.")


# ─── App setup ────────────────────────────────────────────────────────────────

app = FastAPI(
    title="NQ Management ML Service",
    description="Local inference for trade management models (CatBoost)",
    version="1.0.0",
    lifespan=lifespan,
)

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_methods=["*"],
    allow_headers=["*"],
)


# ─── Action policy ────────────────────────────────────────────────────────────

def decide_action(
    hold_prob: float,
    remaining_r: float,
    req: ManagementRequest,
) -> tuple[ManagementAction, float, list[str]]:
    """
    Convert raw model outputs into a discrete management action.

    Policy rules (deterministic, no randomness):
      1. If remaining_r < REMAINING_R_EXIT -> EXIT_ALL (model predicts loss ahead)
      2. If hold_prob < EXIT_THRESHOLD -> EXIT_ALL (low confidence in holding)
      3. If hold_prob < REDUCE_THRESHOLD and pt1_hit -> EXIT_PARTIAL
      4. If unrealized_r > BE_MOVE_R_TRIGGER and not stop_at_breakeven -> MOVE_TO_BREAKEVEN
      5. If hold_prob > HOLD_THRESHOLD -> HOLD
      6. Otherwise -> NO_ACTION (ambiguous zone)
    """
    notes: list[str] = []
    confidence = hold_prob  # base confidence is hold probability

    # Rule 1: Model predicts significant loss ahead
    if remaining_r < REMAINING_R_EXIT:
        notes.append(f"remaining_r={remaining_r:.3f} < {REMAINING_R_EXIT} threshold")
        return ManagementAction.EXIT_ALL, 1.0 - hold_prob, notes

    # Rule 2: Very low hold probability
    if hold_prob < EXIT_THRESHOLD:
        notes.append(f"hold_prob={hold_prob:.3f} < {EXIT_THRESHOLD} exit threshold")
        return ManagementAction.EXIT_ALL, 1.0 - hold_prob, notes

    # Rule 3: Low-moderate hold probability, PT1 already taken -> reduce
    if hold_prob < REDUCE_THRESHOLD and req.pt1_hit == 1:
        notes.append(f"hold_prob={hold_prob:.3f} < {REDUCE_THRESHOLD}, pt1 done, suggest reduce")
        return ManagementAction.EXIT_PARTIAL, 1.0 - hold_prob, notes

    # Rule 4: In profit but stop not at breakeven -> suggest BE move
    if req.unrealized_r > BE_MOVE_R_TRIGGER and req.stop_at_breakeven == 0:
        notes.append(f"unrealized_r={req.unrealized_r:.3f} > {BE_MOVE_R_TRIGGER}, stop not at BE")
        return ManagementAction.MOVE_TO_BREAKEVEN, hold_prob, notes

    # Rule 5: High hold probability
    if hold_prob > HOLD_THRESHOLD:
        notes.append(f"hold_prob={hold_prob:.3f} > {HOLD_THRESHOLD} hold threshold")
        return ManagementAction.HOLD, hold_prob, notes

    # Rule 6: Ambiguous
    notes.append(f"hold_prob={hold_prob:.3f} in ambiguous zone [{EXIT_THRESHOLD}, {HOLD_THRESHOLD}]")
    return ManagementAction.NO_ACTION, hold_prob, notes


# ─── Health ───────────────────────────────────────────────────────────────────

def _overall_status() -> str:
    """
    Derive overall status string from model state.

    "ok"           — model loaded and feature contract verified
    "incompatible" — model loaded but feature list doesn't match registry
    "degraded"     — model not loaded (no artifact found or load error)
    """
    if not models.loaded:
        return "degraded"
    if not models.schema_compatible:
        return "incompatible"
    return "ok"


@app.get("/health", response_model=HealthResponse)
def health():
    return HealthResponse(
        status=_overall_status(),
        uptime_sec=round(time.time() - START_TIME, 1),
        # Management model
        model_loaded=models.loaded,
        model_name=models.model_name,
        model_version=models.model_version,
        # Feature contract
        feature_schema_version=models.feature_schema_version,
        feature_count=models.feature_count,
        schema_compatible=models.schema_compatible,
        schema_error=models.schema_error,
        # Entry model — always stub until a real entry timing model is trained
        entry_model_loaded=False,
        entry_model_status="stub_disabled",
        # Tiered model info
        loaded_model_dir=tiered_models.model_dir or None,
        available_tiers=tiered_models.available_tiers,
        tier_feature_counts={
            t: len(tiered_models.tiers[t].artifact_feature_names)
            for t in tiered_models.available_tiers
            if t in tiered_models.tiers
        },
        loaded_at=tiered_models.loaded_at or None,
        model_file_paths={
            t: os.path.join(tiered_models.model_dir, t)
            for t in tiered_models.available_tiers
        },
    )


# ─── Management inference ─────────────────────────────────────────────────────

@app.post("/predict_management", response_model=ManagementResponse)
def predict_management(req: ManagementRequest):
    req_dict = req.model_dump()

    # Try tiered models first, fall back to flat model
    tier_used: str | None = None
    fallback_reason: str | None = None
    active_model: ManagementModels | None = None

    if tiered_models.available_tiers:
        try:
            bbo_age = None  # BBO age not in request; tier selection uses field presence
            tier_name, tier_model, selection_meta = tiered_models.select_tier(req_dict, bbo_age)
            if tier_model.schema_compatible:
                active_model = tier_model
                tier_used = tier_name
                fallback_reason = selection_meta.get("fallback_reason")
        except RuntimeError:
            pass  # fall through to flat model

    if active_model is None:
        # Use flat model
        if not models.loaded:
            raise HTTPException(status_code=503, detail="Models not loaded — no artifact found")
        if not models.schema_compatible:
            raise HTTPException(
                status_code=503,
                detail=(
                    f"Inference refused: feature contract incompatible. "
                    f"{models.schema_error or 'See /health for details.'}"
                ),
            )
        active_model = models

    try:
        raw = active_model.predict(req_dict)

        hold_prob: float = raw["hold_prob"]
        remaining_r: float = raw["remaining_r"]
        inference_ms: float = raw["inference_ms"]

        action, confidence, notes = decide_action(hold_prob, remaining_r, req)

        if tier_used and fallback_reason:
            notes.append(f"Fell back to {tier_used}: {fallback_reason}")

        size_fraction = None
        stop_price = None

        if action == ManagementAction.EXIT_PARTIAL:
            size_fraction = 0.5

        if action == ManagementAction.MOVE_TO_BREAKEVEN:
            entry_price = (
                req.current_price - req.pnl_pts
                if req.is_short == 0
                else req.current_price + abs(req.pnl_pts)
            )
            stop_price = round(entry_price, 2)

        return ManagementResponse(
            action=action,
            action_confidence=round(confidence, 4),
            prob_hold=hold_prob,
            prob_pt2_before_stop=None,
            prob_continue_next_window=None,
            ev_hold_r=round(req.unrealized_r + remaining_r, 4),
            ev_exit_now_r=round(req.unrealized_r, 4),
            ev_reduce_r=None,
            recommended_size_fraction=size_fraction,
            recommended_stop_price=stop_price,
            model_name=active_model.model_name,
            model_version=active_model.model_version,
            inference_ms=inference_ms,
            notes=notes,
            tier_used=tier_used,
            fallback_reason=fallback_reason,
        )

    except HTTPException:
        raise
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"Inference error: {str(e)}")


# ─── Entry ML (stub) ──────────────────────────────────────────────────────────
# No entry timing model has been trained yet.
# This endpoint accepts the correct EntryRequest schema (for forward compatibility)
# but always returns a safe default and clearly identifies itself as a stub.
# /health exposes entry_model_status="stub_disabled" so callers know not to rely on it.

@app.post("/predict_entry", response_model=EntryPredictionResponse)
def predict_entry(req: EntryRequest):
    """
    Entry timing prediction — STUB.

    No trained entry model exists.  Returns confirmed=True (safe default: don't
    block entries on a missing model) but clearly marks itself as a stub via
    model_name and reasons fields.

    When a real entry model is deployed:
      1. Add entry model path to _resolve_model_dir() logic
      2. Load it in the lifespan handler
      3. Replace this stub with real inference
      4. Update /health to set entry_model_loaded=True, entry_model_status="loaded"
    """
    return EntryPredictionResponse(
        confirmed=True,          # safe default: don't block entries on a missing model
        confidence=0.0,          # 0.0 signals "no model opinion"
        expected_r=None,
        entry_quality_prob=None,
        model_name="stub_no_model",
        inference_ms=0.0,
        reasons=["entry_model_not_trained", "stub_returns_confirmed_true_as_safe_default"],
    )


# ─── Direct run ───────────────────────────────────────────────────────────────

if __name__ == "__main__":
    import uvicorn
    port = int(os.environ.get("ML_SERVICE_PORT", "5001"))
    print(f"[ML-SERVICE] Starting on http://127.0.0.1:{port}")
    # Pass app object directly — NOT the string "app:app" — because
    # loaders.py adds python-market-data-service to sys.path, and
    # uvicorn's string-based import can resolve "app" to the sidecar's
    # app.py instead of this file's app.
    uvicorn.run(app, host="127.0.0.1", port=port, log_level="info")
