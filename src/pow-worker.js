'use strict';

// The side-brain. Runs in a worker thread so the proof-of-work grind never
// blocks the node's main event loop (gossip, HTTP, timers stay responsive).
// It receives a block header and a difficulty, then varies the nonce until the
// hash has the required number of leading zeros, and posts the solution back.
const { parentPort, workerData } = require('worker_threads');
const { hashObject } = require('./crypto');

const { header, difficulty } = workerData;
const target = '0'.repeat(difficulty);

let nonce = Number.isFinite(header.nonce) ? header.nonce : 0;
let hash = hashObject({ ...header, nonce });

while (!hash.startsWith(target)) {
  nonce += 1;
  hash = hashObject({ ...header, nonce });
}

parentPort.postMessage({ nonce, hash });
