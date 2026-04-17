#!/usr/bin/env node

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'fs';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'path';
import { spawnSync } from 'child_process';

const EXPECTED_COEFS_FILES = [
  'long_1s_coefs.json',
  'long_3s_coefs.json',
  'long_5s_coefs.json',
  'short_1s_coefs.json',
  'short_3s_coefs.json',
  'short_5s_coefs.json',
];

function fail(message) {
  console.error(`[BOOTSTRAP:scalper-artifacts] ${message}`);
  process.exit(1);
}

function toPortableRelativePath(pathValue) {
  return pathValue.split(sep).join('/');
}

function isPathInsideRepoRoot(repoRoot, absolutePath) {
  const relativePath = relative(repoRoot, absolutePath);
  return (
    relativePath === '' ||
    (!relativePath.startsWith('..') && !isAbsolute(relativePath))
  );
}

function resolveOutputPath(repoRoot, pathValue, label) {
  const absolutePath = resolve(repoRoot, pathValue);
  if (!isPathInsideRepoRoot(repoRoot, absolutePath)) {
    fail(`${label} must stay inside repo root ${repoRoot}: ${pathValue}`);
  }
  return {
    absolutePath,
    relativePath: toPortableRelativePath(relative(repoRoot, absolutePath)),
  };
}

function resolveInputPath(cwd, pathValue, label) {
  const absolutePath = resolve(cwd, pathValue);
  if (!existsSync(absolutePath)) {
    fail(`${label} not found: ${absolutePath}`);
  }
  return absolutePath;
}

function utcTimestampTag() {
  return new Date().toISOString().replace(/[:.]/g, '-');
}

function parseArgs(argv) {
  const out = {
    repoRoot: process.cwd(),
    python: 'python',
    candidates: 'logs/lob_mbo_scalp_candidates.jsonl',
    ticks: 'logs/lob_top_of_book.jsonl',
    labeledOut: 'data/lob_mbo_scalp_candidates_labeled.jsonl',
    datasetOut: 'data/lob_mbo_scalp_dataset.csv',
    expectancyOut: 'reports/ml/lob_mbo_scalp/expectancy_buckets.json',
    modelOutDir: null,
    minN: null,
    tickSize: null,
    costPts: null,
    seed: null,
    trainFrac: null,
    minRows: null,
    minPerClass: null,
    threshold: null,
    l2: null,
    enforceSampleWeight: null,
    promote: true,
  };

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    const next = argv[index + 1] ?? null;
    if (arg === '--repo-root') {
      out.repoRoot = next ?? fail('missing value for --repo-root');
      index += 1;
    } else if (arg === '--python') {
      out.python = next ?? fail('missing value for --python');
      index += 1;
    } else if (arg === '--candidates') {
      out.candidates = next ?? fail('missing value for --candidates');
      index += 1;
    } else if (arg === '--ticks') {
      out.ticks = next ?? fail('missing value for --ticks');
      index += 1;
    } else if (arg === '--labeled-out') {
      out.labeledOut = next ?? fail('missing value for --labeled-out');
      index += 1;
    } else if (arg === '--dataset-out') {
      out.datasetOut = next ?? fail('missing value for --dataset-out');
      index += 1;
    } else if (arg === '--expectancy-out') {
      out.expectancyOut = next ?? fail('missing value for --expectancy-out');
      index += 1;
    } else if (arg === '--model-out-dir') {
      out.modelOutDir = next ?? fail('missing value for --model-out-dir');
      index += 1;
    } else if (arg === '--min-n') {
      out.minN = next ?? fail('missing value for --min-n');
      index += 1;
    } else if (arg === '--tick-size') {
      out.tickSize = next ?? fail('missing value for --tick-size');
      index += 1;
    } else if (arg === '--cost-pts') {
      out.costPts = next ?? fail('missing value for --cost-pts');
      index += 1;
    } else if (arg === '--seed') {
      out.seed = next ?? fail('missing value for --seed');
      index += 1;
    } else if (arg === '--train-frac') {
      out.trainFrac = next ?? fail('missing value for --train-frac');
      index += 1;
    } else if (arg === '--min-rows') {
      out.minRows = next ?? fail('missing value for --min-rows');
      index += 1;
    } else if (arg === '--min-per-class') {
      out.minPerClass = next ?? fail('missing value for --min-per-class');
      index += 1;
    } else if (arg === '--threshold') {
      out.threshold = next ?? fail('missing value for --threshold');
      index += 1;
    } else if (arg === '--l2') {
      out.l2 = next ?? fail('missing value for --l2');
      index += 1;
    } else if (arg === '--enforce-sample-weight') {
      out.enforceSampleWeight = true;
    } else if (arg === '--no-enforce-sample-weight') {
      out.enforceSampleWeight = false;
    } else if (arg === '--promote') {
      out.promote = true;
    } else if (arg === '--no-promote') {
      out.promote = false;
    } else if (arg === '--help' || arg === '-h') {
      console.log(
        'Usage: node scripts/bootstrap-scalper-readiness-artifacts.mjs ' +
          '[--repo-root DIR] [--python python] [--candidates PATH] [--ticks PATH] ' +
          '[--labeled-out PATH] [--dataset-out PATH] [--expectancy-out PATH] ' +
          '[--model-out-dir DIR] [--min-n N] [--tick-size F] [--cost-pts F] ' +
          '[--seed N] [--train-frac F] [--min-rows N] [--min-per-class N] ' +
          '[--threshold F] [--l2 F] [--enforce-sample-weight|--no-enforce-sample-weight] ' +
          '[--promote|--no-promote]'
      );
      process.exit(0);
    } else {
      fail(`unknown argument: ${arg}`);
    }
  }

  return out;
}

function runStep(command, args, cwd, label) {
  console.log(`[BOOTSTRAP:scalper-artifacts] ${label}`);
  console.log(`[BOOTSTRAP:scalper-artifacts]   cwd=${cwd}`);
  console.log(`[BOOTSTRAP:scalper-artifacts]   cmd=${command} ${args.join(' ')}`);
  const result = spawnSync(command, args, {
    cwd,
    stdio: 'inherit',
    shell: false,
  });
  if (result.status !== 0) {
    fail(`${label} failed with exit code ${result.status ?? 'null'}`);
  }
}

function verifyModelArtifacts(modelDir) {
  for (const fileName of EXPECTED_COEFS_FILES) {
    const filePath = join(modelDir, fileName);
    if (!existsSync(filePath)) {
      fail(`expected trained model artifact missing: ${filePath}`);
    }
  }
  const summaryPath = join(modelDir, 'training_summary.json');
  if (!existsSync(summaryPath)) {
    fail(`training summary missing: ${summaryPath}`);
  }
  return summaryPath;
}

function writePromotedPointer(repoRoot, modelDir) {
  const version = modelDir.split(/[\\/]/).at(-1);
  if (!version) {
    fail(`cannot infer model version from ${modelDir}`);
  }
  const promotedPath = resolveOutputPath(repoRoot, 'models/lob_mbo_scalp/promoted.json', 'promoted pointer');
  mkdirSync(dirname(promotedPath.absolutePath), { recursive: true });
  writeFileSync(
    promotedPath.absolutePath,
    JSON.stringify({
      version,
      promoted_at: new Date().toISOString(),
    }, null, 2),
    'utf8',
  );
  return promotedPath;
}

const args = parseArgs(process.argv.slice(2));
const repoRoot = resolve(args.repoRoot);
const candidatesPath = resolveInputPath(process.cwd(), args.candidates, 'candidate log');
const ticksPath = resolveInputPath(process.cwd(), args.ticks, 'tick log');
const labeledOut = resolveOutputPath(repoRoot, args.labeledOut, 'labeled output');
const datasetOut = resolveOutputPath(repoRoot, args.datasetOut, 'dataset output');
const expectancyOut = resolveOutputPath(repoRoot, args.expectancyOut, 'expectancy output');
const modelOutDir = resolveOutputPath(
  repoRoot,
  args.modelOutDir ?? `models/lob_mbo_scalp/versions/${utcTimestampTag()}`,
  'model output directory',
);

mkdirSync(dirname(labeledOut.absolutePath), { recursive: true });
mkdirSync(dirname(datasetOut.absolutePath), { recursive: true });
mkdirSync(dirname(expectancyOut.absolutePath), { recursive: true });
mkdirSync(modelOutDir.absolutePath, { recursive: true });

runStep(
  'node',
  [
    'scripts/run-lob-mbo-forward-labeler.mjs',
    '--candidates', candidatesPath,
    '--ticks', ticksPath,
    '--out', labeledOut.absolutePath,
  ],
  repoRoot,
  'label scalper candidates',
);

runStep(
  args.python,
  [
    'scripts/ml/build_lob_mbo_scalp_dataset.py',
    '--input', labeledOut.absolutePath,
    '--output', datasetOut.absolutePath,
  ],
  repoRoot,
  'build scalper training dataset',
);

const bucketArgs = [
  'scripts/build-scalper-expectancy-bucket-table.mjs',
  '--in', datasetOut.absolutePath,
  '--out', expectancyOut.absolutePath,
];
if (args.minN !== null) {
  bucketArgs.push('--min-n', String(args.minN));
}
if (args.tickSize !== null) {
  bucketArgs.push('--tick-size', String(args.tickSize));
}
runStep('node', bucketArgs, repoRoot, 'build scalper expectancy buckets');

const trainerArgs = [
  'scripts/ml/train_logistic_lob_mbo_scalp.py',
  '--input', datasetOut.absolutePath,
  '--out-dir', modelOutDir.absolutePath,
];
if (args.costPts !== null) trainerArgs.push('--cost-pts', String(args.costPts));
if (args.seed !== null) trainerArgs.push('--seed', String(args.seed));
if (args.trainFrac !== null) trainerArgs.push('--train-frac', String(args.trainFrac));
if (args.minRows !== null) trainerArgs.push('--min-rows', String(args.minRows));
if (args.minPerClass !== null) trainerArgs.push('--min-per-class', String(args.minPerClass));
if (args.threshold !== null) trainerArgs.push('--threshold', String(args.threshold));
if (args.l2 !== null) trainerArgs.push('--l2', String(args.l2));
if (args.enforceSampleWeight === true) trainerArgs.push('--enforce-sample-weight');
if (args.enforceSampleWeight === false) trainerArgs.push('--no-enforce-sample-weight');

runStep(args.python, trainerArgs, repoRoot, 'train scalper logistic artifacts');

const summaryPath = verifyModelArtifacts(modelOutDir.absolutePath);
const summary = JSON.parse(readFileSync(summaryPath, 'utf8'));
const promotedPath = args.promote ? writePromotedPointer(repoRoot, modelOutDir.absolutePath) : null;

console.log(`[BOOTSTRAP:scalper-artifacts] repo_root=${repoRoot}`);
console.log(`[BOOTSTRAP:scalper-artifacts] candidates=${candidatesPath}`);
console.log(`[BOOTSTRAP:scalper-artifacts] ticks=${ticksPath}`);
console.log(`[BOOTSTRAP:scalper-artifacts] labeled_out=${labeledOut.relativePath}`);
console.log(`[BOOTSTRAP:scalper-artifacts] dataset_out=${datasetOut.relativePath}`);
console.log(`[BOOTSTRAP:scalper-artifacts] expectancy_out=${expectancyOut.relativePath}`);
console.log(`[BOOTSTRAP:scalper-artifacts] model_out_dir=${modelOutDir.relativePath}`);
if (promotedPath) {
  console.log(`[BOOTSTRAP:scalper-artifacts] promoted_pointer=${promotedPath.relativePath}`);
}
console.log(
  `[BOOTSTRAP:scalper-artifacts] trained_targets=${summary.targets?.filter?.((t) => t?.status === 'ok')?.length ?? 'unknown'}`
);
