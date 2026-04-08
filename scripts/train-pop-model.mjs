#!/usr/bin/env node
/**
 * train-pop-model.mjs — Train logistic regression models for in-trade PoP estimation.
 *
 * Trains 3 binary classifiers (T1, T2, Runner) using full-batch gradient descent
 * with L2 regularization. No external dependencies — pure JavaScript.
 *
 * Input:  logs/training_dataset.jsonl  (built by build-training-dataset.mjs)
 * Output: models/pop_model_v1.json
 *
 * Usage:
 *   node scripts/train-pop-model.mjs [--dataset logs/training_dataset.jsonl] [--out models/pop_model_v1.json]
 */

import { readFileSync, existsSync, writeFileSync, mkdirSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(__dirname, '..');

function argVal(flag) {
  const i = process.argv.indexOf(flag);
  return i >= 0 ? process.argv[i + 1] : null;
}

const datasetPath = argVal('--dataset') ?? join(repoRoot, 'logs', 'training_dataset.jsonl');
const outPath = argVal('--out') ?? join(repoRoot, 'models', 'pop_model_v1.json');

// ─── Load dataset ──────────────────────────────────────────────────────────────

if (!existsSync(datasetPath)) {
  console.error(`Dataset not found: ${datasetPath}`);
  console.error('Run: node scripts/build-training-dataset.mjs first');
  process.exit(1);
}

const rows = readFileSync(datasetPath, 'utf8')
  .split('\n').filter(l => l.trim())
  .map(l => { try { return JSON.parse(l); } catch { return null; } })
  .filter(Boolean);

console.log(`Loaded ${rows.length} rows from ${datasetPath}`);

// ─── Feature names (must match build-training-dataset.mjs) ────────────────────

const FEATURE_NAMES = [
  'geo_ratio_t1', 'geo_ratio_t2',
  'current_r', 'mfe_r', 'mae_r',
  't1_dist_r', 't2_dist_r', 'stop_dist_r',
  'partial_exit_done', 'hold_seconds_norm',
  'is_long',
  'setup_trend_pullback', 'setup_breakout_retest', 'setup_failed_break',
  'regime_trending_up', 'regime_trending_down',
];
const N_FEATURES = FEATURE_NAMES.length;

// ─── Validation split by trade_id (prevent leakage between snapshots) ─────────

const tradeIds = [...new Set(rows.map(r => r.trade_id))];
// Deterministic shuffle using a simple hash
tradeIds.sort((a, b) => {
  let ha = 0, hb = 0;
  for (let i = 0; i < a.length; i++) ha = (ha * 31 + a.charCodeAt(i)) >>> 0;
  for (let i = 0; i < b.length; i++) hb = (hb * 31 + b.charCodeAt(i)) >>> 0;
  return ha - hb;
});
const valTradeCount = Math.floor(tradeIds.length * 0.2);
const valTradeSet = new Set(tradeIds.slice(0, valTradeCount));
const trainRows = rows.filter(r => !valTradeSet.has(r.trade_id));
const valRows = rows.filter(r => valTradeSet.has(r.trade_id));
console.log(`Train: ${trainRows.length} rows (${tradeIds.length - valTradeCount} trades)  |  Val: ${valRows.length} rows (${valTradeCount} trades)`);

// ─── Feature normalization ─────────────────────────────────────────────────────

function computeNormStats(rows) {
  const means = new Array(N_FEATURES).fill(0);
  const stds = new Array(N_FEATURES).fill(0);
  let n = 0;
  for (const r of rows) {
    if (!r.features || r.features.length !== N_FEATURES) continue;
    for (let i = 0; i < N_FEATURES; i++) means[i] += r.features[i];
    n++;
  }
  for (let i = 0; i < N_FEATURES; i++) means[i] /= n;
  for (const r of rows) {
    if (!r.features || r.features.length !== N_FEATURES) continue;
    for (let i = 0; i < N_FEATURES; i++) {
      const d = r.features[i] - means[i];
      stds[i] += d * d;
    }
  }
  for (let i = 0; i < N_FEATURES; i++) stds[i] = Math.sqrt(stds[i] / n);
  return { means, stds };
}

const { means: featureMeans, stds: featureStds } = computeNormStats(trainRows);

function normalize(features) {
  return features.map((x, i) => (x - featureMeans[i]) / (featureStds[i] + 1e-8));
}

// ─── Logistic regression training ─────────────────────────────────────────────

function sigmoid(z) { return 1 / (1 + Math.exp(-z)); }

function logLoss(preds, labels, posWeight = 1) {
  let loss = 0;
  let n = 0;
  for (let i = 0; i < preds.length; i++) {
    if (labels[i] === null) continue;
    const p = Math.max(1e-12, Math.min(1 - 1e-12, preds[i]));
    const w = labels[i] === 1 ? posWeight : 1;
    loss += w * (-labels[i] * Math.log(p) - (1 - labels[i]) * Math.log(1 - p));
    n++;
  }
  return n > 0 ? loss / n : 0;
}

function computeAUC(preds, labels) {
  const pairs = preds.map((p, i) => ({ p, y: labels[i] })).filter(x => x.y !== null);
  pairs.sort((a, b) => b.p - a.p);
  let tp = 0, fp = 0, totalPos = pairs.filter(x => x.y === 1).length;
  let totalNeg = pairs.filter(x => x.y === 0).length;
  if (totalPos === 0 || totalNeg === 0) return null;
  let auc = 0, prevFpr = 0, prevTpr = 0;
  for (const { y } of pairs) {
    if (y === 1) tp++;
    else fp++;
    const tpr = tp / totalPos;
    const fpr = fp / totalNeg;
    auc += (fpr - prevFpr) * (tpr + prevTpr) / 2;
    prevFpr = fpr;
    prevTpr = tpr;
  }
  return Math.round(auc * 1000) / 1000;
}

function brierScore(preds, labels) {
  const pairs = preds.map((p, i) => ({ p, y: labels[i] })).filter(x => x.y !== null);
  if (pairs.length === 0) return null;
  return Math.round(pairs.reduce((s, { p, y }) => s + (p - y) ** 2, 0) / pairs.length * 1000) / 1000;
}

/**
 * Train a logistic regression model.
 * @param {Array<{features: number[], label: number|null}>} data - training rows (null label = skip)
 * @param {number} posWeight - weight multiplier for positive class (for class imbalance)
 * @returns {{ weights: number[], bias: number }}
 */
function trainLogistic(data, posWeight = 1) {
  const weights = new Array(N_FEATURES).fill(0);
  let bias = 0;

  const LR_INIT = 0.05;
  const LAMBDA = 0.001;  // L2 regularization
  const MAX_EPOCHS = 500;
  const EARLY_STOP_PATIENCE = 10;
  const EARLY_STOP_TOL = 1e-6;

  // Filter to valid rows (non-null labels)
  const valid = data.filter(d => d.label !== null);
  if (valid.length === 0) return { weights, bias };

  const xs = valid.map(d => normalize(d.features));
  const ys = valid.map(d => d.label);

  let prevLoss = Infinity;
  let stuckCount = 0;

  for (let epoch = 0; epoch < MAX_EPOCHS; epoch++) {
    const lr = LR_INIT / (1 + 0.01 * epoch);
    const gradW = new Array(N_FEATURES).fill(0);
    let gradB = 0;
    let epochLoss = 0;
    let n = 0;

    for (let i = 0; i < xs.length; i++) {
      const z = xs[i].reduce((s, x, j) => s + weights[j] * x, bias);
      const p = sigmoid(z);
      const w = ys[i] === 1 ? posWeight : 1;
      const error = w * (p - ys[i]);
      const logP = Math.max(1e-12, Math.min(1 - 1e-12, p));
      epochLoss += w * (-ys[i] * Math.log(logP) - (1 - ys[i]) * Math.log(1 - logP));
      for (let j = 0; j < N_FEATURES; j++) gradW[j] += error * xs[i][j];
      gradB += error;
      n++;
    }

    const scale = 1 / n;
    for (let j = 0; j < N_FEATURES; j++) {
      weights[j] -= lr * (gradW[j] * scale + LAMBDA * weights[j]);
    }
    bias -= lr * gradB * scale;
    epochLoss *= scale;

    // Early stop check
    const lossDelta = Math.abs(prevLoss - epochLoss);
    if (lossDelta < EARLY_STOP_TOL) {
      stuckCount++;
      if (stuckCount >= EARLY_STOP_PATIENCE) {
        console.log(`    Early stop at epoch ${epoch + 1} (Δloss=${lossDelta.toExponential(2)})`);
        break;
      }
    } else {
      stuckCount = 0;
    }
    prevLoss = epochLoss;

    if ((epoch + 1) % 100 === 0) {
      console.log(`    Epoch ${epoch + 1}/${MAX_EPOCHS}: loss=${epochLoss.toFixed(4)}`);
    }
  }

  return { weights: weights.map(w => Math.round(w * 1e6) / 1e6), bias: Math.round(bias * 1e6) / 1e6 };
}

// ─── Train each model ──────────────────────────────────────────────────────────

function trainAndEval(name, trainData, valData, posWeight = 1) {
  console.log(`\nTraining ${name} model (posWeight=${posWeight.toFixed(2)})...`);
  const { weights, bias } = trainLogistic(trainData, posWeight);

  // Evaluate
  function predict(rows) {
    return rows.map(d => {
      if (!d.features || d.label === null) return null;
      const xn = normalize(d.features);
      const z = xn.reduce((s, x, j) => s + weights[j] * x, bias);
      return sigmoid(z);
    });
  }

  const trainPreds = predict(trainData);
  const valPreds = predict(valData);
  const trainLabels = trainData.map(d => d.label);
  const valLabels = valData.map(d => d.label);

  const trainLoss = logLoss(trainPreds.filter(p => p !== null), trainLabels.filter(l => l !== null), posWeight);
  const valLoss = logLoss(valPreds.filter(p => p !== null), valLabels.filter(l => l !== null), posWeight);
  const valAUC = computeAUC(valPreds.filter((p, i) => p !== null && valLabels[i] !== null), valLabels.filter(l => l !== null));
  const valBrier = brierScore(valPreds.filter((p, i) => p !== null && valLabels[i] !== null), valLabels.filter(l => l !== null));

  const nTrain = trainData.filter(d => d.label !== null).length;
  const nPos = trainData.filter(d => d.label === 1).length;

  console.log(`  ${name}: train_loss=${trainLoss.toFixed(4)}  val_loss=${valLoss.toFixed(4)}  val_auc=${valAUC}  val_brier=${valBrier}  n=${nTrain}  pos=${nPos}(${(nPos/nTrain*100).toFixed(1)}%)`);

  return {
    weights,
    bias,
    train_log_loss: Math.round(trainLoss * 1e4) / 1e4,
    val_log_loss: Math.round(valLoss * 1e4) / 1e4,
    val_auc: valAUC,
    val_brier: valBrier,
    n_train: nTrain,
    n_positive: nPos,
  };
}

// T1: predict hit_target_1 (skip rows where T1 already done = label_t1 is null)
const t1Train = trainRows.map(r => ({ features: r.features, label: r.label_t1 }));
const t1Val   = valRows.map(r => ({ features: r.features, label: r.label_t1 }));
const t1PosCount = t1Train.filter(d => d.label === 1).length;
const t1NegCount = t1Train.filter(d => d.label === 0).length;
const t1Model = trainAndEval('T1', t1Train, t1Val, 1); // ~46% positive — no reweighting needed

// T2: predict r_multiple > 2.0 proxy
const t2Train = trainRows.map(r => ({ features: r.features, label: r.label_t2 }));
const t2Val   = valRows.map(r => ({ features: r.features, label: r.label_t2 }));
const t2PosCount = t2Train.filter(d => d.label === 1).length;
const t2NegCount = t2Train.filter(d => d.label === 0).length;
const t2PosWeight = t2PosCount > 0 ? Math.min(t2NegCount / t2PosCount, 10) : 1; // cap at 10x
const t2Model = trainAndEval('T2', t2Train, t2Val, t2PosWeight);

// Runner: predict r_multiple > 1.5
const runnerTrain = trainRows.map(r => ({ features: r.features, label: r.label_runner }));
const runnerVal   = valRows.map(r => ({ features: r.features, label: r.label_runner }));
const runnerPosCount = runnerTrain.filter(d => d.label === 1).length;
const runnerNegCount = runnerTrain.filter(d => d.label === 0).length;
const runnerPosWeight = runnerPosCount > 0 ? Math.min(runnerNegCount / runnerPosCount, 5) : 1;
const runnerModel = trainAndEval('Runner', runnerTrain, runnerVal, runnerPosWeight);

// ─── Write weights file ────────────────────────────────────────────────────────

mkdirSync(dirname(outPath), { recursive: true });

const modelOutput = {
  schema_version: '1',
  model_name: 'trained_lr_v1',
  model_version: '1.0.0',
  trained_at: new Date().toISOString(),
  training_samples: {
    t1: t1Model.n_train,
    t2: t2Model.n_train,
    runner: runnerModel.n_train,
  },
  feature_names: FEATURE_NAMES,
  feature_means: featureMeans.map(v => Math.round(v * 1e6) / 1e6),
  feature_stds: featureStds.map(v => Math.round(v * 1e6) / 1e6),
  t1_model:     { weights: t1Model.weights, bias: t1Model.bias, train_log_loss: t1Model.train_log_loss, val_log_loss: t1Model.val_log_loss, val_auc: t1Model.val_auc, val_brier: t1Model.val_brier },
  t2_model:     { weights: t2Model.weights, bias: t2Model.bias, train_log_loss: t2Model.train_log_loss, val_log_loss: t2Model.val_log_loss, val_auc: t2Model.val_auc, val_brier: t2Model.val_brier },
  runner_model: { weights: runnerModel.weights, bias: runnerModel.bias, train_log_loss: runnerModel.train_log_loss, val_log_loss: runnerModel.val_log_loss, val_auc: runnerModel.val_auc, val_brier: runnerModel.val_brier },
  min_pop: 0.05,
  max_pop: 0.95,
};

writeFileSync(outPath, JSON.stringify(modelOutput, null, 2), 'utf8');
console.log(`\nModel saved: ${outPath}`);

// ─── Quick feature importance (weight magnitude) ───────────────────────────────
console.log('\nT1 model — top feature weights (by |weight|):');
const t1Ranked = FEATURE_NAMES.map((n, i) => ({ name: n, w: t1Model.weights[i] }))
  .sort((a, b) => Math.abs(b.w) - Math.abs(a.w));
for (const { name, w } of t1Ranked.slice(0, 8)) {
  const bar = '█'.repeat(Math.min(20, Math.round(Math.abs(w) * 10)));
  console.log(`  ${name.padEnd(24)} ${w >= 0 ? '+' : ''}${w.toFixed(4)}  ${bar}`);
}
