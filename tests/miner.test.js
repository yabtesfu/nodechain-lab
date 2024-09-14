'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const Blockchain = require('../src/blockchain');
const Wallet = require('../src/wallet');
const Miner = require('../src/miner');

test('start requires a miner address', () => {
  const miner = new Miner(new Blockchain({ difficulty: 1 }));
  assert.throws(() => miner.start({}), /miner address is required/);
});

test('mineOnce mines pending transactions, drains the mempool, and broadcasts', async () => {
  const chain = new Blockchain({ difficulty: 1 });
  const alice = Wallet.create();
  const bob = Wallet.create();

  const setup = new Miner(chain);
  await setup.mineOnce(alice.address); // give alice a block reward to spend

  const tx = alice.createTransaction({
    to: bob.address,
    amount: 5,
    fee: 1,
    nonce: chain.nextNonce(alice.address)
  });
  chain.addTransaction(tx);

  const broadcasts = [];
  const miner = new Miner(chain, { p2p: { broadcastBlock: (b) => broadcasts.push(b) } });
  const block = await miner.mineOnce(alice.address);

  assert.ok(block, 'a block was produced');
  assert.ok(block.transactions.some((t) => t.id === tx.id), 'tx included in the block');
  assert.equal(chain.mempool.list().length, 0, 'mempool drained');
  assert.equal(broadcasts.length, 1, 'block broadcast to peers');
  assert.equal(chain.getBalance(bob.address), 5);
  setup.close();
  miner.close();
});

test('a tick with no pending txs and mineEmpty=false mines nothing', async () => {
  const chain = new Blockchain({ difficulty: 1 });
  const miner = new Miner(chain);
  miner.running = true;
  miner.mineEmpty = false;
  miner.minerAddress = Wallet.create().address;
  await miner.tick();
  assert.equal(miner.blocksMined, 0);
  assert.equal(chain.chain.length, 1, 'still just genesis');
  miner.close();
});

test('a tick with mineEmpty=true mines an empty (coinbase-only) block', async () => {
  const chain = new Blockchain({ difficulty: 1 });
  const miner = new Miner(chain);
  miner.running = true;
  miner.mineEmpty = true;
  miner.minerAddress = Wallet.create().address;
  await miner.tick();
  assert.equal(miner.blocksMined, 1);
  assert.equal(chain.lastBlock.transactions.length, 1, 'only the coinbase tx');
  miner.close();
});

test('a grind that exceeds its timeout is abandoned, not latched forever', async () => {
  const chain = new Blockchain({ difficulty: 7 }); // effectively never completes fast
  const miner = new Miner(chain, { grindTimeout: 150 }); // tiny leash

  const first = await miner.mineOnce(Wallet.create().address);
  assert.equal(first, null, 'timed-out grind returns null');
  assert.equal(miner.grinding, false, 'grinding flag cleared (miner is not wedged)');

  // Crucially, a second attempt still runs - the miner did not latch.
  const second = await miner.mineOnce(Wallet.create().address);
  assert.equal(second, null);
  assert.equal(miner.grinding, false);
  assert.equal(chain.chain.length, 1, 'no block was produced at this difficulty');
  miner.close();
});

test('a grind is aborted when the chain head moves under it (no stale double-mine)', async () => {
  const chain = new Blockchain({ difficulty: 6 }); // slow grind, so we can interrupt it
  const alice = Wallet.create();
  const miner = new Miner(chain);

  const mining = miner.mineOnce(alice.address); // do not await yet - it is grinding
  await new Promise((resolve) => setTimeout(resolve, 50)); // let the worker start

  // A competing block arrives (from a peer, here forged on a chain sharing genesis).
  const peer = new Blockchain({ difficulty: 1 });
  peer.minePendingTransactions(Wallet.create().address);
  chain.addBlock(peer.chain[1]); // advances our head -> should abort the grind

  const result = await mining;
  assert.equal(result, null, 'the stale grind was abandoned');
  assert.equal(chain.chain.length, 2, 'the peer block is the head; no double block was mined');
  miner.close();
});

test('interval is clamped into a safe range (no setTimeout overflow / 1ms runaway)', () => {
  const addr = Wallet.create().address;

  const big = new Miner(new Blockchain({ difficulty: 1 }));
  assert.equal(big.start({ minerAddress: addr, interval: 3000000000 }).interval, 2147483647);
  big.stop();

  const tiny = new Miner(new Blockchain({ difficulty: 1 }));
  assert.equal(tiny.start({ minerAddress: addr, interval: 1 }).interval, 10);
  tiny.stop();

  const bad = new Miner(new Blockchain({ difficulty: 1 }));
  assert.equal(bad.start({ minerAddress: addr, interval: 'abc' }).interval, 5000); // keeps default
  bad.stop();
});

test('mineEmpty is coerced strictly (string "false" stays false)', () => {
  const addr = Wallet.create().address;

  const m1 = new Miner(new Blockchain({ difficulty: 1 }));
  assert.equal(m1.start({ minerAddress: addr, mineEmpty: 'false' }).mineEmpty, false);
  m1.stop();

  const m2 = new Miner(new Blockchain({ difficulty: 1 }));
  assert.equal(m2.start({ minerAddress: addr, mineEmpty: 'true' }).mineEmpty, true);
  m2.stop();

  const m3 = new Miner(new Blockchain({ difficulty: 1 }));
  assert.equal(m3.start({ minerAddress: addr, mineEmpty: true }).mineEmpty, true);
  m3.stop();
});

test('changing interval on a running miner applies it and reschedules a single timer', () => {
  const addr = Wallet.create().address;
  const miner = new Miner(new Blockchain({ difficulty: 1 }));
  miner.start({ minerAddress: addr, interval: 500 });
  const firstTimer = miner.timer;
  miner.start({ minerAddress: addr, interval: 1500 }); // update while running
  assert.equal(miner.interval, 1500);
  assert.notEqual(miner.timer, firstTimer, 'the timer was rescheduled, not duplicated');
  miner.stop();
});

test('status reports running state and settings', () => {
  const chain = new Blockchain({ difficulty: 1 });
  const miner = new Miner(chain);
  const addr = Wallet.create().address;
  const status = miner.start({ minerAddress: addr, interval: 1234, mineEmpty: true });
  miner.stop(); // clear the scheduled tick before the timer can fire

  assert.equal(status.running, true);
  assert.equal(status.minerAddress, addr);
  assert.equal(status.interval, 1234);
  assert.equal(status.mineEmpty, true);
  assert.equal(miner.status().running, false, 'stopped after stop()');
});
