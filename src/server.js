'use strict';

const http = require('http');
const express = require('express');
const Blockchain = require('./blockchain');
const Transaction = require('./transaction');
const Wallet = require('./wallet');
const { P2PNode } = require('./p2p');
const { loadSnapshot, saveSnapshot } = require('./storage');

const DEFAULT_DATA_FILE = process.env.NODECHAIN_DATA || 'data/nodechain.json';

function createBlockchain() {
  const snapshot = loadSnapshot(DEFAULT_DATA_FILE);
  if (snapshot) {
    return Blockchain.fromJSON(snapshot, snapshot.settings);
  }
  return new Blockchain();
}

function createApp(blockchain = createBlockchain()) {
  const app = express();
  app.use(express.json({ limit: '1mb' }));

  app.get('/health', (req, res) => {
    res.json({ status: 'ok', height: blockchain.chain.length - 1 });
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

  app.get('/mempool', (req, res) => {
    res.json({ transactions: blockchain.mempool.toJSON() });
  });

  app.post('/wallets', (req, res) => {
    res.status(201).json(Wallet.create().toJSON());
  });

  app.post('/transactions/new', (req, res, next) => {
    try {
      const values = req.body || {};
      let transaction;

      if (values.privateKey && values.publicKey) {
        const wallet = new Wallet({
          privateKey: values.privateKey,
          publicKey: values.publicKey,
          address: values.from
        });
        transaction = wallet.createTransaction({
          to: values.to,
          amount: values.amount,
          fee: values.fee || 0,
          nonce: values.nonce || blockchain.nextNonce(wallet.address),
          memo: values.memo || ''
        });
      } else {
        transaction = new Transaction(values);
      }

      const accepted = blockchain.addTransaction(transaction);
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
      res.status(201).json({
        message: 'New block mined',
        block: block.toJSON()
      });
    } catch (error) {
      next(error);
    }
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

  app.use((error, req, res, next) => {
    if (res.headersSent) {
      next(error);
      return;
    }
    res.status(400).json({ error: error.message });
  });

  return app;
}

// Boot a full node: HTTP API + P2P drums sharing one port, plus any peers
// we should dial on startup.
function startNode({
  port = Number(process.env.PORT || 3000),
  peers = [],
  blockchain = createBlockchain()
} = {}) {
  const app = createApp(blockchain);
  const server = http.createServer(app);
  const selfUrl = `http://localhost:${port}`;
  const p2p = new P2PNode(blockchain, { selfUrl });
  p2p.attach(server);

  server.listen(port, () => {
    console.log(`Nodechain Lab (HTTP + P2P) listening on ${selfUrl}`);
    if (peers.length > 0) {
      console.log(`[p2p] dialing initial peers: ${peers.join(', ')}`);
    }
    p2p.connectToPeers(peers);
  });

  return { app, server, p2p, blockchain };
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

