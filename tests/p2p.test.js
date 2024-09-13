'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const Blockchain = require('../src/blockchain');
const Wallet = require('../src/wallet');
const { P2PNode, normalizeOrigin } = require('../src/p2p');

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

test('normalizeOrigin collapses loopback spellings and trailing slashes', () => {
  assert.equal(normalizeOrigin('http://127.0.0.1:3001'), 'http://localhost:3001');
  assert.equal(normalizeOrigin('http://localhost:3001/'), 'http://localhost:3001');
  assert.equal(normalizeOrigin('http://[::1]:3001'), 'http://localhost:3001');
});

test('peer exchange never dials self and dedups spellings of the same peer', () => {
  const p2p = new P2PNode(new Blockchain(), { selfUrl: 'http://localhost:3000' });
  const dialed = [];
  // Stub connect() but keep its dedup contract (populate outbound like the real one).
  p2p.connect = (raw) => {
    const url = normalizeOrigin(raw);
    if (url === p2p.selfUrl || p2p.outbound.has(url) || p2p.inbound.has(url)) {
      return null;
    }
    dialed.push(url);
    p2p.outbound.set(url, { connected: true, close() {}, emit() {} });
    return null;
  };

  p2p.handlePeers({
    peers: [
      'http://localhost:3000', // ourselves -> must be skipped
      'http://localhost:3001',
      'http://127.0.0.1:3001', // same as 3001 -> must dedup
      'http://localhost:3002'
    ]
  });

  assert.deepEqual(dialed.sort(), ['http://localhost:3001', 'http://localhost:3002']);
  assert.ok(p2p.knownPeers.has('http://localhost:3001'));
});

test('advertisedPeers includes self and live peers, but not dead ones', () => {
  const p2p = new P2PNode(new Blockchain(), { selfUrl: 'http://localhost:3000' });
  p2p.outbound.set('http://localhost:3001', { connected: true });
  p2p.outbound.set('http://localhost:3999', { connected: false }); // never reached / dead
  p2p.knownPeers.add('http://localhost:3999');
  const advertised = p2p.advertisedPeers();
  assert.ok(advertised.includes('http://localhost:3000'), 'self advertised');
  assert.ok(advertised.includes('http://localhost:3001'), 'live peer advertised');
  assert.ok(!advertised.includes('http://localhost:3999'), 'dead peer must NOT be advertised');
});

test('malformed PEERS entries (numbers, booleans, junk) never crash the node', () => {
  const p2p = new P2PNode(new Blockchain(), { selfUrl: 'http://localhost:3000' });
  assert.doesNotThrow(() =>
    p2p.handlePeers({ peers: [5000, true, null, {}, 'not a url', ''] })
  );
  assert.equal(p2p.outbound.size, 0, 'no bogus dials attempted');
});

test('malformed HELLO (non-string url) is ignored, not recorded', () => {
  const p2p = new P2PNode(new Blockchain(), { selfUrl: 'http://localhost:3000' });
  const fakeSocket = { on() {} };
  assert.doesNotThrow(() => p2p.handleHello({ url: 5000 }, fakeSocket));
  assert.doesNotThrow(() => p2p.handleHello({ url: {} }, fakeSocket));
  assert.doesNotThrow(() => p2p.handleHello(null, fakeSocket));
  assert.equal(p2p.inbound.size, 0);
  assert.equal(p2p.knownPeers.size, 0);
});

test('repeated HELLOs on one socket keep exactly one advertised address', () => {
  const p2p = new P2PNode(new Blockchain(), { selfUrl: 'http://localhost:3000' });
  const fakeSocket = { on() {} }; // inbound (no dialedUrl)
  p2p.handleHello({ url: 'http://localhost:4001' }, fakeSocket);
  p2p.handleHello({ url: 'http://localhost:4002' }, fakeSocket);
  p2p.handleHello({ url: 'http://localhost:4003' }, fakeSocket);
  assert.equal(p2p.inbound.size, 1, 'one socket => one advertised peer');
  assert.ok(p2p.inbound.has('http://localhost:4003'), 'keeps the latest address');
});

test('multi-host mutual dial: the greater address drops its outbound (one link survives)', () => {
  // Two nodes on real hostnames (as in docker-compose), both dialed each other.
  const node2 = new P2PNode(new Blockchain(), { selfUrl: 'http://node2:3000' });
  let closed = false;
  node2.outbound.set('http://node1:3000', {
    dialedUrl: 'http://node1:3000',
    connected: true,
    close() { closed = true; },
    on() {},
    emit() {}
  });
  // node1 dialed us too; its HELLO advertises its ADVERTISED_URL.
  node2.handleHello({ url: 'http://node1:3000' }, { on() {} });

  assert.equal(closed, true, 'node2 (greater address) dropped its redundant outbound');
  assert.equal(node2.outbound.has('http://node1:3000'), false);
  assert.ok(node2.inbound.has('http://node1:3000'), 'kept exactly one (inbound) link');
});

test('multi-host mutual dial: the smaller address keeps its outbound', () => {
  const node1 = new P2PNode(new Blockchain(), { selfUrl: 'http://node1:3000' });
  let closed = false;
  node1.outbound.set('http://node2:3000', {
    dialedUrl: 'http://node2:3000',
    connected: true,
    close() { closed = true; },
    on() {},
    emit() {}
  });
  node1.handleHello({ url: 'http://node2:3000' }, { on() {} });

  assert.equal(closed, false, 'node1 (smaller address) keeps its outbound; node2 drops its own');
  assert.ok(node1.outbound.has('http://node2:3000'));
});

test('a self-loop via a non-loopback alias is detected and torn down', () => {
  const p2p = new P2PNode(new Blockchain(), { selfUrl: 'http://localhost:3000' });
  let closed = false;
  const socket = { dialedUrl: 'http://192.168.1.5:3000', close() { closed = true; }, on() {} };
  p2p.outbound.set('http://192.168.1.5:3000', socket);
  // The "peer" we dialed reveals (via HELLO) that it is actually us.
  p2p.handleHello({ url: 'http://localhost:3000' }, socket);
  assert.equal(closed, true, 'self-loop socket closed');
  assert.equal(p2p.outbound.has('http://192.168.1.5:3000'), false, 'removed from outbound');
  assert.equal(p2p.inbound.size, 0);
  assert.equal(p2p.knownPeers.size, 0, 'we never record ourselves as a peer');
});
