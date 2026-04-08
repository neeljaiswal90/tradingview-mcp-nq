#!/usr/bin/env node
/**
 * Filter JSONL log files to keep only the latest session.
 * Reads all .jsonl files in a directory, identifies the latest session_id,
 * and rewrites files to contain only that session's records.
 *
 * Usage: node scripts/filter-latest-session.mjs <logs-dir>
 */
import { readFileSync, writeFileSync, readdirSync } from 'fs';
import { join } from 'path';

const [,, logsDir] = process.argv;
if (!logsDir) { console.error('Usage: filter-latest-session.mjs <logs-dir>'); process.exit(1); }

// Find latest session from performance.json
const perf = JSON.parse(readFileSync(join(logsDir, 'performance.json'), 'utf8'));
const sessionId = perf.session_id;
console.log(`Filtering to session: ${sessionId}`);

const jsonlFiles = readdirSync(logsDir).filter(f => f.endsWith('.jsonl'));
for (const file of jsonlFiles) {
  const path = join(logsDir, file);
  const lines = readFileSync(path, 'utf8').split('\n').filter(l => l.trim());
  const filtered = lines.filter(l => {
    try {
      const obj = JSON.parse(l);
      return obj.session_id === sessionId;
    } catch { return false; }
  });
  const before = lines.length;
  const after = filtered.length;
  writeFileSync(path, filtered.join('\n') + '\n');
  if (before !== after) {
    console.log(`  ${file}: ${before} → ${after} lines`);
  }
}
console.log('Done.');
