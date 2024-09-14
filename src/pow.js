'use strict';

const path = require('path');
const { Worker } = require('worker_threads');

const WORKER_FILE = path.join(__dirname, 'pow-worker.js');

// Safety leash: if a single grind runs longer than this it is abandoned, so an
// unexpectedly-hard difficulty can never permanently wedge the miner or leak a
// worker that pins a CPU core forever. Legitimate grinds finish well under this.
const DEFAULT_GRIND_TIMEOUT = 120_000;

// Grind a block header's proof-of-work in a worker thread. Resolves with
// { nonce, hash } once found. Pass an AbortSignal to cancel a now-stale grind
// (e.g. a better block arrived from a peer) - the worker is terminated and the
// promise rejects with an 'aborted' error. Exceeding `timeout` rejects with a
// 'grind timed out' error; either way the worker is always terminated.
function mineHeader(header, difficulty, { signal, timeout = DEFAULT_GRIND_TIMEOUT } = {}) {
  return new Promise((resolve, reject) => {
    if (signal && signal.aborted) {
      reject(new Error('aborted'));
      return;
    }

    const worker = new Worker(WORKER_FILE, { workerData: { header, difficulty } });
    let settled = false;
    let watchdog = null;

    const finish = (fn, arg) => {
      if (settled) {
        return;
      }
      settled = true;
      if (watchdog) {
        clearTimeout(watchdog);
      }
      if (signal) {
        signal.removeEventListener('abort', onAbort);
      }
      worker.terminate();
      fn(arg);
    };

    function onAbort() {
      finish(reject, new Error('aborted'));
    }

    worker.once('message', (solution) => finish(resolve, solution));
    worker.once('error', (err) => finish(reject, err));

    if (signal) {
      signal.addEventListener('abort', onAbort);
    }

    if (Number.isFinite(timeout) && timeout > 0) {
      watchdog = setTimeout(() => finish(reject, new Error('grind timed out')), timeout);
      if (watchdog.unref) {
        watchdog.unref(); // the worker keeps the loop alive; the leash need not
      }
    }
  });
}

module.exports = { mineHeader, WORKER_FILE, DEFAULT_GRIND_TIMEOUT };
