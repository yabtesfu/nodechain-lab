'use strict';

const {
  hashObject,
  publicKeyToAddress,
  signPayload,
  verifySignature
} = require('./crypto');

const SYSTEM_SENDER = 'SYSTEM';

class Transaction {
  constructor({
    id,
    from,
    to,
    amount,
    fee = 0,
    nonce = 0,
    timestamp = Date.now(),
    memo = '',
    publicKey = null,
    signature = null
  }) {
    this.from = from;
    this.to = to;
    this.amount = Number(amount);
    this.fee = Number(fee);
    this.nonce = Number(nonce);
    this.timestamp = timestamp;
    this.memo = memo;
    this.publicKey = publicKey;
    this.signature = signature;
    this.id = id || this.calculateId();
  }

  static reward(to, amount, height, feeTotal = 0) {
    return new Transaction({
      from: SYSTEM_SENDER,
      to,
      amount,
      fee: 0,
      nonce: height,
      memo: `block reward + ${feeTotal} fees`
    });
  }

  payload() {
    return {
      from: this.from,
      to: this.to,
      amount: this.amount,
      fee: this.fee,
      nonce: this.nonce,
      timestamp: this.timestamp,
      memo: this.memo
    };
  }

  calculateId() {
    return hashObject({
      payload: this.payload(),
      publicKey: this.publicKey,
      signature: this.signature
    });
  }

  sign(privateKey, publicKey) {
    this.publicKey = publicKey;
    this.from = publicKeyToAddress(publicKey);
    this.signature = signPayload(privateKey, this.payload());
    this.id = this.calculateId();
    return this;
  }

  isCoinbase() {
    return this.from === SYSTEM_SENDER;
  }

  verify() {
    if (this.isCoinbase()) {
      return Boolean(this.to) && this.amount >= 0;
    }

    if (!this.publicKey || !this.signature) {
      return false;
    }

    if (publicKeyToAddress(this.publicKey) !== this.from) {
      return false;
    }

    return verifySignature(this.publicKey, this.payload(), this.signature);
  }

  toJSON() {
    return {
      id: this.id,
      from: this.from,
      to: this.to,
      amount: this.amount,
      fee: this.fee,
      nonce: this.nonce,
      timestamp: this.timestamp,
      memo: this.memo,
      publicKey: this.publicKey,
      signature: this.signature
    };
  }
}

Transaction.SYSTEM_SENDER = SYSTEM_SENDER;

module.exports = Transaction;

