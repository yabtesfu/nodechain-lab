'use strict';

const crypto = require('crypto');
const { secp256k1 } = require('@noble/curves/secp256k1.js');

// Real payloads/blocks nest only a few levels; cap recursion so a hostile,
// deeply-nested field (e.g. a memo) cannot blow the stack while hashing.
const MAX_CANONICALIZE_DEPTH = 64;

function canonicalize(value, depth = 0) {
  if (depth > MAX_CANONICALIZE_DEPTH) {
    throw new Error('value nested too deeply to canonicalize');
  }
  if (Array.isArray(value)) {
    return value.map((item) => canonicalize(item, depth + 1));
  }

  if (value && typeof value === 'object') {
    return Object.keys(value)
      .sort()
      .reduce((ordered, key) => {
        ordered[key] = canonicalize(value[key], depth + 1);
        return ordered;
      }, {});
  }

  return value;
}

function stableStringify(value) {
  return JSON.stringify(canonicalize(value));
}

function sha256(data) {
  return crypto.createHash('sha256').update(data).digest('hex');
}

function hashObject(value) {
  return sha256(stableStringify(value));
}

// Keys are plain hex so the exact same signing works in Node AND the browser
// (WebCrypto cannot do secp256k1, so we use @noble on both sides). A private key
// is 32 bytes (64 hex), a compressed public key is 33 bytes (66 hex), and a
// signature is compact r||s, 64 bytes (128 hex).
function sha256Bytes(data) {
  return crypto.createHash('sha256').update(data).digest();
}

function generateKeyPair() {
  const priv = secp256k1.utils.randomSecretKey();
  const privateKey = Buffer.from(priv).toString('hex');
  const publicKey = Buffer.from(secp256k1.getPublicKey(priv, true)).toString('hex');
  return {
    publicKey,
    privateKey,
    address: publicKeyToAddress(publicKey)
  };
}

function publicKeyToAddress(publicKey) {
  return sha256(publicKey).slice(0, 40);
}

function signPayload(privateKey, payload) {
  const hash = sha256Bytes(stableStringify(payload));
  const signature = secp256k1.sign(hash, Buffer.from(privateKey, 'hex'));
  return Buffer.from(signature).toString('hex');
}

function verifySignature(publicKey, payload, signature) {
  try {
    const hash = sha256Bytes(stableStringify(payload));
    return secp256k1.verify(
      Buffer.from(signature, 'hex'),
      hash,
      Buffer.from(publicKey, 'hex')
    );
  } catch (err) {
    return false; // malformed hex / bad key or signature -> invalid, never throw
  }
}

module.exports = {
  canonicalize,
  stableStringify,
  sha256,
  hashObject,
  generateKeyPair,
  publicKeyToAddress,
  signPayload,
  verifySignature
};

