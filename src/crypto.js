'use strict';

const crypto = require('crypto');

function canonicalize(value) {
  if (Array.isArray(value)) {
    return value.map(canonicalize);
  }

  if (value && typeof value === 'object') {
    return Object.keys(value)
      .sort()
      .reduce((ordered, key) => {
        ordered[key] = canonicalize(value[key]);
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

function generateKeyPair() {
  const { publicKey, privateKey } = crypto.generateKeyPairSync('ec', {
    namedCurve: 'secp256k1',
    publicKeyEncoding: { type: 'spki', format: 'pem' },
    privateKeyEncoding: { type: 'pkcs8', format: 'pem' }
  });

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
  const signer = crypto.createSign('SHA256');
  signer.update(stableStringify(payload));
  signer.end();
  return signer.sign(privateKey, 'hex');
}

function verifySignature(publicKey, payload, signature) {
  const verifier = crypto.createVerify('SHA256');
  verifier.update(stableStringify(payload));
  verifier.end();
  return verifier.verify(publicKey, signature, 'hex');
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

