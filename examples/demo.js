'use strict';

const { Blockchain, Wallet } = require('../src');

const chain = new Blockchain({ difficulty: 2 });
const alice = Wallet.create();
const bob = Wallet.create();

chain.minePendingTransactions(alice.address);

const payment = alice.createTransaction({
  to: bob.address,
  amount: 12,
  fee: 1,
  nonce: chain.nextNonce(alice.address),
  memo: 'demo transfer'
});

chain.addTransaction(payment);
chain.minePendingTransactions(alice.address);

console.log({
  height: chain.chain.length - 1,
  alice: chain.getBalance(alice.address),
  bob: chain.getBalance(bob.address),
  valid: chain.isValidChain(chain.chain)
});

