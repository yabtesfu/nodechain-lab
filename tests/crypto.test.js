'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  generateKeyPair,
  publicKeyToAddress,
  signPayload,
  verifySignature
} = require('../src/crypto');

test('generateKeyPair returns hex keys and a derived address', () => {
  const { publicKey, privateKey, address } = generateKeyPair();
  assert.match(privateKey, /^[0-9a-f]{64}$/, '32-byte private key');
  assert.match(publicKey, /^[0-9a-f]{66}$/, '33-byte compressed public key');
  assert.equal(address, publicKeyToAddress(publicKey));
  assert.equal(address.length, 40);
});

test('sign then verify round-trips; tampering the payload fails', () => {
  const { publicKey, privateKey } = generateKeyPair();
  const payload = { from: 'a', to: 'b', amount: 5, fee: 1, nonce: 1, timestamp: 123, memo: '' };
  const sig = signPayload(privateKey, payload);
  assert.match(sig, /^[0-9a-f]{128}$/, '64-byte compact signature');
  assert.equal(verifySignature(publicKey, payload, sig), true);
  assert.equal(verifySignature(publicKey, { ...payload, amount: 6 }, sig), false);
});

test('a signature is bound to its exact public key', () => {
  const w1 = generateKeyPair();
  const w2 = generateKeyPair();
  const payload = { hello: 'world' };
  const sig = signPayload(w1.privateKey, payload);
  assert.equal(verifySignature(w1.publicKey, payload, sig), true);
  assert.equal(verifySignature(w2.publicKey, payload, sig), false);
});

test('verifySignature never throws on malformed input (returns false)', () => {
  const { publicKey } = generateKeyPair();
  assert.doesNotThrow(() => verifySignature(publicKey, { a: 1 }, 'not-hex-at-all'));
  assert.equal(verifySignature(publicKey, { a: 1 }, 'zz'), false);
  assert.equal(verifySignature('bad-pub', { a: 1 }, 'abcd'), false);
});
