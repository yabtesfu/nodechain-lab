'use strict';

const { hashObject, sha256 } = require('./crypto');
const Transaction = require('./transaction');

function toTransaction(tx) {
  return tx instanceof Transaction ? tx : new Transaction(tx);
}

function merkleRoot(transactions) {
  if (transactions.length === 0) {
    return sha256('');
  }

  let layer = transactions.map((tx) => tx.id || toTransaction(tx).calculateId());
  while (layer.length > 1) {
    const next = [];
    for (let i = 0; i < layer.length; i += 2) {
      const left = layer[i];
      const right = layer[i + 1] || left;
      next.push(sha256(left + right));
    }
    layer = next;
  }
  return layer[0];
}

class Block {
  constructor({
    index,
    timestamp = Date.now(),
    transactions = [],
    previousHash,
    difficulty = 2,
    nonce = 0,
    miner = '',
    metadata = {},
    hash = null,
    merkleRoot: existingMerkleRoot = null
  }) {
    this.index = index;
    this.timestamp = timestamp;
    this.transactions = transactions.map(toTransaction);
    this.previousHash = previousHash;
    this.difficulty = difficulty;
    this.nonce = nonce;
    this.miner = miner;
    this.metadata = metadata;
    this.merkleRoot = existingMerkleRoot || merkleRoot(this.transactions);
    this.hash = hash || this.calculateHash();
  }

  header() {
    return {
      index: this.index,
      timestamp: this.timestamp,
      previousHash: this.previousHash,
      difficulty: this.difficulty,
      nonce: this.nonce,
      miner: this.miner,
      merkleRoot: this.merkleRoot,
      metadata: this.metadata
    };
  }

  calculateHash() {
    return hashObject(this.header());
  }

  mine() {
    const target = '0'.repeat(this.difficulty);
    while (!this.hash.startsWith(target)) {
      this.nonce += 1;
      this.hash = this.calculateHash();
    }
    return this;
  }

  hasValidHash() {
    return this.hash === this.calculateHash() &&
      this.hash.startsWith('0'.repeat(this.difficulty)) &&
      this.merkleRoot === merkleRoot(this.transactions);
  }

  toJSON() {
    return {
      index: this.index,
      timestamp: this.timestamp,
      transactions: this.transactions.map((tx) => tx.toJSON()),
      previousHash: this.previousHash,
      difficulty: this.difficulty,
      nonce: this.nonce,
      miner: this.miner,
      metadata: this.metadata,
      merkleRoot: this.merkleRoot,
      hash: this.hash
    };
  }
}

Block.merkleRoot = merkleRoot;

module.exports = Block;

