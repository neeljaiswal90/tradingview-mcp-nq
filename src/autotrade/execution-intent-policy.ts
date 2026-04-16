/**
 * Stamp for execution_intents.jsonl rows — correlates broker surface + ML policy.
 */
export function buildExecutionIntentPolicyStamp(
  executionMode: string,
  opts: {
    mlPolicyMode: string;
    mlInferenceEnabled: boolean;
    mlBrokerExecutionEnabled: boolean;
  },
): string {
  return (
    `exec_mode=${executionMode};ml_policy=${opts.mlPolicyMode};` +
    `ml_inf=${opts.mlInferenceEnabled ? 'on' : 'off'};` +
    `ml_exec=${opts.mlBrokerExecutionEnabled ? 'on' : 'off'}`
  );
}
