/**
 * Regression test: verify zero Claude/Anthropic dependencies remain in the codebase.
 */

import { describe, it, expect } from 'vitest';
import { readFileSync, existsSync } from 'fs';

describe('Zero Claude/Anthropic dependency', () => {
  const runnerSource = readFileSync('src/autotrade/runner.ts', 'utf8');

  it('claude-reasoning directory does not exist', () => {
    expect(existsSync('src/autotrade/claude-reasoning')).toBe(false);
  });

  it('runner.ts has no Claude imports', () => {
    expect(runnerSource).not.toContain('claude-reasoning');
    expect(runnerSource).not.toContain('ClaudeReasoningService');
    expect(runnerSource).not.toContain('ClaudeTriggerScheduler');
  });

  it('runner.ts has no Claude runtime wiring', () => {
    expect(runnerSource).not.toContain('claudeService');
    expect(runnerSource).not.toContain('claudeTriggerScheduler');
    expect(runnerSource).not.toContain('ANTHROPIC');
  });

  it('runner.ts preserves ML management', () => {
    expect(runnerSource).toContain('getMlDecision');
    expect(runnerSource).toContain('mlConfig');
  });

  it('runner.ts preserves rules-based management', () => {
    expect(runnerSource).toContain('managementEngine.evaluate');
    expect(runnerSource).toContain('positionManager.evaluate');
  });
});
