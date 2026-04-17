import { spawn, type ChildProcess } from 'child_process';

export interface RunnerShutdownRequestMessage {
  type: 'shutdown';
  reason: string;
}

export interface RunnerShutdownAckMessage {
  type: 'shutdownAck';
  reason: string;
}

export type RunnerIpcMessage =
  | RunnerShutdownRequestMessage
  | RunnerShutdownAckMessage;

export type GracefulShutdownOutcome =
  | 'acknowledged'
  | 'exited'
  | 'forced';

export interface RequestGracefulShutdownOptions {
  timeoutMs?: number;
  forceKill?: () => void;
}

type SendCallback = (error: Error | null) => void;

type ShutdownControllableChild = Pick<
  ChildProcess,
  'connected' | 'kill' | 'off' | 'on' | 'once' | 'pid' | 'send'
>;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

export function isRunnerShutdownRequestMessage(
  value: unknown,
): value is RunnerShutdownRequestMessage {
  return (
    isRecord(value) &&
    value['type'] === 'shutdown' &&
    typeof value['reason'] === 'string'
  );
}

export function isRunnerShutdownAckMessage(
  value: unknown,
): value is RunnerShutdownAckMessage {
  return (
    isRecord(value) &&
    value['type'] === 'shutdownAck' &&
    typeof value['reason'] === 'string'
  );
}

export function forceTerminateChildProcess(
  child: Pick<ChildProcess, 'kill' | 'pid'>,
): void {
  if (process.platform === 'win32' && child.pid) {
    spawn('taskkill', ['/PID', String(child.pid), '/T', '/F'], {
      windowsHide: true,
      stdio: 'ignore',
    });
    return;
  }

  child.kill('SIGKILL');
}

export async function requestGracefulShutdown(
  child: ShutdownControllableChild,
  reason: string,
  options: RequestGracefulShutdownOptions = {},
): Promise<GracefulShutdownOutcome> {
  const timeoutMs = options.timeoutMs ?? 5_000;
  const forceKill = options.forceKill ?? (() => {
    forceTerminateChildProcess(child);
  });

  if (typeof child.send !== 'function' || child.connected === false) {
    forceKill();
    return 'forced';
  }

  return new Promise<GracefulShutdownOutcome>((resolve, reject) => {
    let settled = false;

    const cleanup = (): void => {
      child.off('message', onMessage);
      child.off('disconnect', onDisconnect);
      child.off('exit', onExit);
      clearTimeout(timer);
    };

    const settle = (outcome: GracefulShutdownOutcome): void => {
      if (settled) return;
      settled = true;
      cleanup();
      resolve(outcome);
    };

    const rejectWith = (error: Error): void => {
      if (settled) return;
      settled = true;
      cleanup();
      reject(error);
    };

    const onMessage = (message: unknown): void => {
      if (isRunnerShutdownAckMessage(message)) {
        settle('acknowledged');
      }
    };

    const onDisconnect = (): void => {
      settle('exited');
    };

    const onExit = (): void => {
      settle('exited');
    };

    const timer = setTimeout(() => {
      try {
        forceKill();
      } catch (error) {
        rejectWith(error instanceof Error ? error : new Error(String(error)));
        return;
      }
      settle('forced');
    }, timeoutMs);
    timer.unref();

    child.on('message', onMessage);
    child.once('disconnect', onDisconnect);
    child.once('exit', onExit);

    child.send(
      { type: 'shutdown', reason } satisfies RunnerShutdownRequestMessage,
      (error?: Error | null) => {
        if (error) {
          rejectWith(error);
        }
      },
    );
  });
}

export async function sendRunnerShutdownAck(
  reason: string,
  send = process.send?.bind(process) as
    | ((message: RunnerShutdownAckMessage, callback?: SendCallback) => boolean)
    | undefined,
): Promise<void> {
  if (!send) return;

  await new Promise<void>((resolve, reject) => {
    send(
      { type: 'shutdownAck', reason },
      error => {
        if (error) {
          reject(error);
          return;
        }
        resolve();
      },
    );
  });
}
