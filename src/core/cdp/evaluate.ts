import type CDP from 'chrome-remote-interface';

export type CDPClient = CDP.Client;

export interface EvaluateOpts {
  awaitPromise?: boolean;
  returnByValue?: boolean;
  [key: string]: unknown;
}

export async function evaluate(
  client: CDPClient,
  expression: string,
  opts: EvaluateOpts = {},
): Promise<unknown> {
  const result = await client.Runtime.evaluate({
    expression,
    returnByValue: true,
    awaitPromise: opts.awaitPromise ?? false,
    ...opts,
  });
  if (result.exceptionDetails) {
    const msg =
      result.exceptionDetails.exception?.description ??
      result.exceptionDetails.text ??
      'Unknown evaluation error';
    throw new Error(`JS evaluation error: ${msg}`);
  }
  return result.result?.value;
}

export async function evaluateAsync(
  client: CDPClient,
  expression: string,
): Promise<unknown> {
  return evaluate(client, expression, { awaitPromise: true });
}

export function safeString(str: string): string {
  return JSON.stringify(String(str));
}

export function requireFinite(value: unknown, name: string): number {
  const n = Number(value);
  if (!Number.isFinite(n))
    throw new Error(`${name} must be a finite number, got: ${value}`);
  return n;
}
