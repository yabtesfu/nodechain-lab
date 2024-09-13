'use strict';

const http = require('http');
const path = require('path');
const fs = require('fs');
const express = require('express');
const Blockchain = require('./blockchain');
const Transaction = require('./transaction');
const Wallet = require('./wallet');
const { P2PNode } = require('./p2p');
const Miner = require('./miner');
const SSEHub = require('./sse');
const { loadSnapshot, saveSnapshot } = require('./storage');

const WEB_DIST = path.join(__dirname, '..', 'web', 'dist');

const DEFAULT_DATA_FILE = process.env.NODECHAIN_DATA || 'data/nodechain.json';

function createBlockchain() {
  const snapshot = loadSnapshot(DEFAULT_DATA_FILE);
  if (snapshot) {
    return Blockchain.fromJSON(snapshot, snapshot.settings);
  }
  return new Blockchain();
}

function createApp(blockchain = createBlockchain(), { p2p = null, miner = null } = {}) {
  const app = express();
  app.use(express.json({ limit: '1mb' }));

  // Allow the dashboard (Vite dev server on another port) to call the API.
  app.use((req, res, next) => {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET,POST,OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
    if (req.method === 'OPTIONS') {
      res.sendStatus(204);
      return;
    }
    next();
  });

  // ---- live event stream for the dashboard ----------------------------------
  const events = new SSEHub();
  app.get('/events', (req, res) => events.handler(req, res));

  blockchain.on('block:added', (block) => {
    events.broadcast('block:added', {
      block: block.toJSON(),
      height: blockchain.chain.length - 1,
      cumulativeWork: blockchain.cumulativeWork()
    });
  });
  blockchain.on('chain:replaced', () => {
    events.broadcast('chain:replaced', {
      height: blockchain.chain.length - 1,
      cumulativeWork: blockchain.cumulativeWork()
    });
  });
  blockchain.on('transaction:added', (tx) => {
    events.broadcast('transaction:added', {
      transaction: tx.toJSON(),
      mempoolSize: blockchain.mempool.list().length
    });
  });

  app.get('/health', (req, res) => {
    res.json({
      status: 'ok',
      height: blockchain.chain.length - 1,
      peers: p2p ? p2p.peerCount() : 0
    });
  });

  app.get('/peers', (req, res) => {
    res.json({
      count: p2p ? p2p.peerCount() : 0,
      connected: p2p ? p2p.connectedPeerUrls() : [],
      known: p2p ? Array.from(p2p.knownPeers) : []
    });
  });

  app.get('/chain', (req, res) => {
    res.json({
      chain: blockchain.chain.map((block) => block.toJSON()),
      length: blockchain.chain.length,
      cumulativeWork: blockchain.cumulativeWork()
    });
  });

  app.get('/state', (req, res) => {
    const state = blockchain.getState();
    res.json({
      balances: Object.fromEntries(state.balances),
      nonces: Object.fromEntries(state.nonces)
    });
  });

  // What a wallet needs to build & sign its next transaction (client-side).
  app.get('/accounts/:address', (req, res) => {
    const { address } = req.params;
    res.json({
      address,
      balance: blockchain.getBalance(address),
      nextNonce: blockchain.nextNonce(address)
    });
  });

  // One call the dashboard makes on load to paint the whole picture at once.
  app.get('/overview', (req, res) => {
    const state = blockchain.getState();
    res.json({
      height: blockchain.chain.length - 1,
      cumulativeWork: blockchain.cumulativeWork(),
      difficulty: blockchain.lastBlock.difficulty,
      nextDifficulty: blockchain.nextDifficulty(),
      miningReward: blockchain.miningReward,
      mempoolSize: blockchain.mempool.list().length,
      mempool: blockchain.mempool.toJSON(),
      peers: p2p ? p2p.peerCount() : 0,
      connectedPeers: p2p ? p2p.connectedPeerUrls() : [],
      mining: miner ? miner.status() : null,
      recentBlocks: blockchain.chain.slice(-12).reverse().map((b) => b.toJSON()),
      balances: Object.fromEntries(state.balances)
    });
  });

  app.get('/mempool', (req, res) => {
    res.json({ transactions: blockchain.mempool.toJSON() });
  });

  app.post('/wallets', (req, res) => {
    res.status(201).json(Wallet.create().toJSON());
  });

  app.post('/transactions/new', (req, res, next) => {
    try {
      // Only accept an already-signed transaction. The node never receives a
      // private key — signing happens in the wallet/browser (see web/src/crypto.js).
      const transaction = new Transaction(req.body || {});
      const accepted = blockchain.addTransaction(transaction);
      if (p2p) {
        p2p.broadcastTransaction(accepted); // shout it to the tribe
      }
      res.status(201).json({
        message: `Transaction queued for block ${blockchain.chain.length}`,
        transaction: accepted.toJSON()
      });
    } catch (error) {
      next(error);
    }
  });

  app.post('/mine', (req, res, next) => {
    try {
      const minerAddress = req.body?.minerAddress || req.query.miner;
      const block = blockchain.minePendingTransactions(minerAddress);
      saveSnapshot(DEFAULT_DATA_FILE, blockchain);
      if (p2p) {
        p2p.broadcastBlock(block); // shout the fresh block to the tribe
      }
      res.status(201).json({
        message: 'New block mined',
        block: block.toJSON()
      });
    } catch (error) {
      next(error);
    }
  });

  // ---- auto-mining control ---------------------------------------------------

  app.get('/mining', (req, res) => {
    if (!miner) {
      res.status(501).json({ error: 'auto-mining is not enabled on this node' });
      return;
    }
    res.json(miner.status());
  });

  app.post('/mining/start', (req, res, next) => {
    try {
      if (!miner) {
        res.status(501).json({ error: 'auto-mining is not enabled on this node' });
        return;
      }
      const status = miner.start({
        minerAddress: req.body?.minerAddress || req.query.miner,
        interval: req.body?.interval,
        mineEmpty: req.body?.mineEmpty
      });
      res.json({ message: 'Auto-mining started', ...status });
    } catch (error) {
      next(error);
    }
  });

  app.post('/mining/stop', (req, res) => {
    if (!miner) {
      res.status(501).json({ error: 'auto-mining is not enabled on this node' });
      return;
    }
    res.json({ message: 'Auto-mining stopped', ...miner.stop() });
  });

  app.post('/nodes/register', (req, res, next) => {
    try {
      const nodes = req.body?.nodes;
      if (!Array.isArray(nodes)) {
        res.status(400).json({ error: 'nodes must be an array of URLs' });
        return;
      }
      nodes.forEach((node) => blockchain.registerNode(node));
      res.status(201).json({
        message: 'Nodes registered',
        nodes: Array.from(blockchain.nodes)
      });
    } catch (error) {
      next(error);
    }
  });

  app.get('/nodes/resolve', async (req, res, next) => {
    try {
      let replaced = false;
      for (const node of blockchain.nodes) {
        const response = await fetch(`${node}/chain`);
        if (!response.ok) {
          continue;
        }
        const remote = await response.json();
        if (blockchain.replaceChain(remote.chain)) {
          replaced = true;
        }
      }
      if (replaced) {
        saveSnapshot(DEFAULT_DATA_FILE, blockchain);
      }
      res.json({
        message: replaced ? 'Chain replaced with stronger peer chain' : 'Local chain kept',
        chain: blockchain.chain.map((block) => block.toJSON())
      });
    } catch (error) {
      next(error);
    }
  });

  // Serve the built dashboard (web/dist) if it has been built, so a single
  // `npm start` gives you the API, P2P, and the UI on one port.
  if (fs.existsSync(WEB_DIST)) {
    app.use(express.static(WEB_DIST));
    app.get('*', (req, res, next) => {
      if (req.path.includes('.') || req.method !== 'GET') {
        next();
        return;
      }
      res.sendFile(path.join(WEB_DIST, 'index.html')); // SPA fallback
    });
  }

  app.use((error, req, res, next) => {
    if (res.headersSent) {
      next(error);
      return;
    }
    res.status(400).json({ error: error.message });
  });

  app.locals.events = events; // expose the SSE hub for shutdown/testing
  return app;
}

// Boot a full node: HTTP API + P2P drums sharing one port, plus any peers
// we should dial on startup.
function startNode({
  port = Number(process.env.PORT || 3000),
  peers = [],
  blockchain = createBlockchain(),
  // The address we advertise to peers. Defaults to localhost for single-machine
  // labs; set ADVERTISED_URL (or pass selfUrl) when nodes live on different hosts.
  selfUrl = process.env.ADVERTISED_URL || `http://localhost:${port}`
} = {}) {
  const p2p = new P2PNode(blockchain, { selfUrl });
  const miner = new Miner(blockchain, {
    p2p,
    onBlock: () => saveSnapshot(DEFAULT_DATA_FILE, blockchain), // persist each mined block
    grindTimeout: Number(process.env.GRIND_TIMEOUT) || undefined
  });
  const app = createApp(blockchain, { p2p, miner });
  const server = http.createServer(app);
  p2p.attach(server);

  server.listen(port, () => {
    console.log(`Nodechain Lab (HTTP + P2P) listening on ${selfUrl}`);
    if (peers.length > 0) {
      console.log(`[p2p] dialing initial peers: ${peers.join(', ')}`);
    }
    p2p.connectToPeers(peers);

    // Auto-start mining if the environment asks for it. Wait one interval before
    // the first block so the initial peer sync can complete first.
    if (process.env.MINER_ADDRESS) {
      miner.start({
        minerAddress: process.env.MINER_ADDRESS,
        interval: Number(process.env.MINE_INTERVAL) || undefined,
        mineEmpty: process.env.MINE_EMPTY === 'true',
        immediate: false
      });
    }
  });

  return { app, server, p2p, miner, blockchain };
}

if (require.main === module) {
  const port = Number(process.env.PORT || 3000);
  const peers = (process.env.PEERS || '')
    .split(',')
    .map((value) => value.trim())
    .filter(Boolean);
  startNode({ port, peers });
}

module.exports = {
  createApp,
  createBlockchain,
  startNode
};

