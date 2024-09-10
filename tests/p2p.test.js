'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const Blockchain = require('../src/blockchain');
const Wallet = require('../src/wallet');
const { P2PNode } = require('../src/p2p');

// These exercise the gossip message handlers directly (no sockets needed):
// with no io attached, broadcast() targets nobody, so the handlers run in
// isolation. They lock in the fixes found by the adversarial review.

test('gossip handler survives a malformed transaction id without crashing', () => {
  const p2p = new P2PNode(new Blockchain({ difficulty: 1 }));
  // A hostile peer sends a numeric id; the old code did payload.id.slice() and
  // crashed the whole node. It must now be dropped quietly.
  assert.doesNotThrow(() =>
    p2p.handleNewTransaction({ id: 12345, from: 'x', to: 'y', amount: 1 }, null)
  );
  assert.doesNotThrow(() => p2p.handleNewTransaction({ id: { evil: true } }, null));
  assert.doesNotThrow(() => p2p.handleNewTransaction(null, null));
  assert.equal(p2p.blockchain.mempool.list().length, 0);
});

test('gossip handler drops coinbase transactions from peers', () => {
  const p2p = new P2PNode(new Blockchain({ difficulty: 1 }));
  const coinbase = {
    id: 'a'.repeat(64),
    from: 'SYSTEM',
    to: 'someone',
    amount: 100,
    fee: 0,
    nonce: 0
  };
  p2p.handleNewTransaction(coinbase, null);
  assert.equal(p2p.blockchain.mempool.list().length, 0, 'coinbase must not enter the mempool');
});

test('gossip handler accepts a valid next block that extends the head', () => {
  const source = new Blockchain({ difficulty: 1 });
  const miner = Wallet.create();
  source.minePendingTransactions(miner.address); // source is now length 2

  const p2p = new P2PNode(new Blockchain({ difficulty: 1 }));
  const nextBlock = source.chain[1].toJSON();
  p2p.handleNewBlock(nextBlock, null);

  assert.equal(p2p.blockchain.chain.length, 2);
  assert.equal(p2p.blockchain.lastBlock.hash, nextBlock.hash);
});

test('a re-gossiped block already on our chain is ignored (echo guard)', () => {
  const source = new Blockchain({ difficulty: 1 });
  const miner = Wallet.create();
  source.minePendingTransactions(miner.address);

  const p2p = new P2PNode(new Blockchain({ difficulty: 1 }));
  const nextBlock = source.chain[1].toJSON();
  p2p.handleNewBlock(nextBlock, null);
  assert.doesNotThrow(() => p2p.handleNewBlock(nextBlock, null)); // echo
  assert.equal(p2p.blockchain.chain.length, 2, 'echo must not double-add');
});

test('self-dial and duplicate-dial guards are URL-normalized', () => {
  const p2p = new P2PNode(new Blockchain(), { selfUrl: 'http://localhost:3000' });
  // Dialing itself under a different loopback spelling must be refused.
  assert.equal(p2p.connect('http://127.0.0.1:3000'), null);
  assert.equal(p2p.outbound.size, 0);
});

test('a malformed peer chain payload is rejected without crashing', () => {
  const p2p = new P2PNode(new Blockchain({ difficulty: 1 }));
  assert.doesNotThrow(() => p2p.handleChain(null, null));
  assert.doesNotThrow(() => p2p.handleChain({ chain: 'not-an-array' }, null));
  assert.doesNotThrow(() => p2p.handleChain({ chain: [{ garbage: true }] }, null));
  assert.equal(p2p.blockchain.chain.length, 1, 'genesis untouched');
});
