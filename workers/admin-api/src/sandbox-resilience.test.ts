import test from 'node:test';
import assert from 'node:assert/strict';

import { isSandboxNotReadyError, withRetry } from './sandbox-resilience.ts';

test('isSandboxNotReadyError matches common sandbox cold-start messages', () => {
  assert.equal(isSandboxNotReadyError(new Error("Session 'sandbox-openclaw-xx' is not ready or shell has died")), true);
  assert.equal(isSandboxNotReadyError(new Error('ECONNRESET')), true);
  assert.equal(isSandboxNotReadyError(new Error('some other error')), false);
});

test('withRetry retries on sandbox-not-ready errors then succeeds', async () => {
  let calls = 0;
  const res = await withRetry(async () => {
    calls++;
    if (calls < 3) throw new Error("Session 'sandbox-openclaw-xx' is not ready or shell has died");
    return 'ok';
  }, { retries: 5, baseDelayMs: 1, maxDelayMs: 5, jitter: false });

  assert.equal(res.value, 'ok');
  assert.equal(res.attempts, 3);
});

test('withRetry stops on non-retryable errors', async () => {
  let calls = 0;
  const res = await withRetry(async () => {
    calls++;
    throw new Error('permission denied');
  }, { retries: 5, baseDelayMs: 1, maxDelayMs: 5, jitter: false });

  assert.equal(res.value, undefined);
  assert.equal(calls, 1);
  assert.ok(res.lastError);
});
