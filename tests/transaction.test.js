'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const Transaction = require('../src/transaction');

test('verify() returns false (never throws) on a non-string public key', () => {
  const tx = new Transaction({
    from: 'aa', to: 'bob', amount: 5, fee: 1, nonce: 1, timestamp: 1, memo: '',
    publicKey: { x: 1 }, signature: 'ab'
  });
  assert.doesNotThrow(() => tx.verify());
  assert.equal(tx.verify(), false);
});

test('a deeply nested memo is rejected with a controlled error (no stack overflow)', () => {
  const deep = {};
  let cursor = deep;
  for (let i = 0; i < 5000; i += 1) {
    cursor.a = {};
    cursor = cursor.a;
  }
  assert.throws(
    () => new Transaction({ from: 'aa', to: 'b', amount: 1, fee: 0, nonce: 1, memo: deep }),
    /nested too deeply/
  );
});
