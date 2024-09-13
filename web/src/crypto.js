import { secp256k1 } from '@noble/curves/secp256k1.js';
import { sha256 } from '@noble/hashes/sha2.js';
import { bytesToHex, hexToBytes } from '@noble/hashes/utils.js';

// This MUST match src/crypto.js on the node exactly, or the node will reject
// what we sign here. Keys are hex (secp256k1); the private key never leaves the
// browser — only the public key and signature are sent to the node.

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

function sha256Hex(str) {
  return bytesToHex(sha256(new TextEncoder().encode(str)));
}

export function createWallet() {
  const priv = secp256k1.utils.randomSecretKey();
  const privateKey = bytesToHex(priv);
  const publicKey = bytesToHex(secp256k1.getPublicKey(priv, true));
  const address = sha256Hex(publicKey).slice(0, 40);
  return { publicKey, privateKey, address };
}

// Build and sign a transaction in the browser. Returns exactly the fields the
// node expects (no private key) — the node re-hashes the same payload and
// verifies the signature against the public key.
export function signTransaction(wallet, { to, amount, fee, nonce, memo = '' }) {
  const payload = {
    from: wallet.address,
    to,
    amount: Number(amount),
    fee: Number(fee),
    nonce: Number(nonce),
    timestamp: Date.now(),
    memo
  };
  const hash = sha256(new TextEncoder().encode(stableStringify(payload)));
  const signature = bytesToHex(secp256k1.sign(hash, hexToBytes(wallet.privateKey)));
  return { ...payload, publicKey: wallet.publicKey, signature };
}
