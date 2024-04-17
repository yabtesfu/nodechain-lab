'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { Blockchain, Wallet, Transaction } = require('../src');

test('mines rewards and processes a signed transaction', () => {
  const blockchain = new Blockchain({ difficulty: 2, miningReward: 25 });
  const alice = Wallet.create();
  const bob = Wallet.create();

  blockchain.minePendingTransactions(alice.address);
  assert.equal(blockchain.getBalance(alice.address), 25);

  const tx = alice.createTransaction({
    to: bob.address,
    amount: 7,
    fee: 1,
    nonce: blockchain.nextNonce(alice.address),
    memo: 'coffee'
  });

  blockchain.addTransaction(tx);
  blockchain.minePendingTransactions(alice.address);

  assert.equal(blockchain.getBalance(bob.address), 7);
  assert.equal(blockchain.getBalance(alice.address), 25 - 8 + 26);
  assert.equal(blockchain.isValidChain(blockchain.chain), true);
});

test('rejects unsigned spending transactions', () => {
  const blockchain = new Blockchain({ difficulty: 1 });
  const alice = Wallet.create();
  const bob = Wallet.create();

  blockchain.minePendingTransactions(alice.address);
  const tx = new Transaction({
    from: alice.address,
    to: bob.address,
    amount: 5,
    nonce: 1
  });

  assert.throws(() => blockchain.addTransaction(tx), /Invalid transaction/);
});

test('detects tampered chains', () => {
  const blockchain = new Blockchain({ difficulty: 1 });
  const miner = Wallet.create();
  blockchain.minePendingTransactions(miner.address);

  const tampered = blockchain.chain.map((block) => block.toJSON());
  tampered[1].transactions[0].amount = 999;

  assert.equal(blockchain.isValidChain(tampered), false);
});

