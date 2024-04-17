'use strict';

const { generateKeyPair } = require('./crypto');
const Transaction = require('./transaction');

class Wallet {
  constructor({ publicKey, privateKey, address }) {
    this.publicKey = publicKey;
    this.privateKey = privateKey;
    this.address = address;
  }

  static create() {
    return new Wallet(generateKeyPair());
  }

  createTransaction({ to, amount, fee = 0, nonce, memo = '' }) {
    return new Transaction({
      from: this.address,
      to,
      amount,
      fee,
      nonce,
      memo
    }).sign(this.privateKey, this.publicKey);
  }

  toJSON() {
    return {
      address: this.address,
      publicKey: this.publicKey,
      privateKey: this.privateKey
    };
  }
}

module.exports = Wallet;

