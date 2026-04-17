import { EventEmitter } from 'events';

import { describe, expect, it, vi } from 'vitest';

import {
  isRunnerShutdownAckMessage,
  isRunnerShutdownRequestMessage,
  requestGracefulShutdown,
  sendRunnerShutdownAck,
} from '../../src/autotrade/runner-ipc.js';

class FakeChildProcess extends EventEmitter {
  connected = true;
  pid = 4242;
  readonly sentMessages: unknown[] = [];

  send(message: unknown, callback?: (error?: Error | null) => void): boolean {
    this.sentMessages.push(message);
    callback?.(null);
    return true;
  }

  kill(): boolean {
    this.emit('exit', 0, null);
    return true;
  }
}

describe('runner IPC shutdown protocol', () => {
  it('recognizes structured shutdown request and ack messages', () => {
    expect(isRunnerShutdownRequestMessage({ type: 'shutdown', reason: 'test' })).toBe(true);
    expect(isRunnerShutdownAckMessage({ type: 'shutdownAck', reason: 'test' })).toBe(true);
    expect(isRunnerShutdownRequestMessage({ type: 'other', reason: 'test' })).toBe(false);
    expect(isRunnerShutdownAckMessage({ type: 'shutdownAck' })).toBe(false);
  });

  it('sends an IPC shutdown request and resolves when the child acknowledges it', async () => {
    const child = new FakeChildProcess();
    const forceKill = vi.fn();

    const shutdownPromise = requestGracefulShutdown(child, 'test_ack', {
      timeoutMs: 100,
      forceKill,
    });

    expect(child.sentMessages).toEqual([{ type: 'shutdown', reason: 'test_ack' }]);
    child.emit('message', { type: 'shutdownAck', reason: 'test_ack' });

    await expect(shutdownPromise).resolves.toBe('acknowledged');
    expect(forceKill).not.toHaveBeenCalled();
  });

  it('forces termination when the child does not acknowledge shutdown before timeout', async () => {
    const child = new FakeChildProcess();
    const forceKill = vi.fn();

    await expect(
      requestGracefulShutdown(child, 'timeout_case', {
        timeoutMs: 10,
        forceKill,
      }),
    ).resolves.toBe('forced');

    expect(forceKill).toHaveBeenCalledTimes(1);
  });

  it('treats disconnect/exit races as completed shutdown without forcing a kill', async () => {
    const child = new FakeChildProcess();
    const forceKill = vi.fn();

    const shutdownPromise = requestGracefulShutdown(child, 'disconnect_case', {
      timeoutMs: 100,
      forceKill,
    });

    child.emit('disconnect');
    child.emit('exit', 0, null);

    await expect(shutdownPromise).resolves.toBe('exited');
    expect(forceKill).not.toHaveBeenCalled();
  });

  it('sends shutdown acknowledgements through the provided IPC sender', async () => {
    const send = vi.fn((_message: unknown, callback?: (error: Error | null) => void) => {
      callback?.(null);
      return true;
    });

    await sendRunnerShutdownAck('ack_reason', send);

    expect(send).toHaveBeenCalledWith(
      { type: 'shutdownAck', reason: 'ack_reason' },
      expect.any(Function),
    );
  });
});
