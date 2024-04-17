'use strict';

const Transaction = require('./transaction');

class Mempool {
  constructor() {
    this.transactions = new Map();
  }

  add(transaction) {
    const tx = transaction instanceof Transaction ? transaction : new Transaction(transaction);
    if (this.transactions.has(tx.id)) {
      throw new Error('Transaction already exists in mempool');
    }
    this.transactions.set(tx.id, tx);
    return tx;
  }

  remove(id) {
    return this.transactions.delete(id);
  }

  clearIncluded(transactions) {
    for (const tx of transactions) {
      this.remove(tx.id);
    }
  }

  list() {
    return Array.from(this.transactions.values());
  }

  ordered(limit = 100) {
    return this.list()
      .sort((a, b) => b.fee - a.fee || a.timestamp - b.timestamp)
      .slice(0, limit);
  }

  toJSON() {
    return this.list().map((tx) => tx.toJSON());
  }
}

module.exports = Mempool;

