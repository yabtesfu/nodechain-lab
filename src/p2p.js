'use strict';

const { Server } = require('socket.io');
const { io: connectClient } = require('socket.io-client');
const Block = require('./block');
const Transaction = require('./transaction');

// The words the drums can beat.
const MSG = {
  QUERY_ALL: 'QUERY_ALL', // "beat me your whole chain"
  CHAIN: 'CHAIN', // "here is my whole chain"
  NEW_BLOCK: 'NEW_BLOCK', // "I just learned of this block"
  NEW_TRANSACTION: 'NEW_TRANSACTION' // "I just learned of this transaction"
};

// How many recently-seen transaction ids we remember to stop gossip echoes.
const SEEN_TX_LIMIT = 10_000;

// Treat loopback spellings as one host so a node recognises itself and its
// peers no matter how the URL was written (localhost vs 127.0.0.1 vs ::1).
const LOOPBACK_HOSTS = new Set(['localhost', '127.0.0.1', '::1', '[::1]']);

function normalizeOrigin(url) {
  try {
    const parsed = new URL(url);
    const host = LOOPBACK_HOSTS.has(parsed.hostname) ? 'localhost' : parsed.hostname;
    return `${parsed.protocol}//${host}:${parsed.port}`;
  } catch (err) {
    return url;
  }
}

class P2PNode {
  constructor(blockchain, { selfUrl = null, logger = console } = {}) {
    this.blockchain = blockchain;
    this.selfUrl = selfUrl ? normalizeOrigin(selfUrl) : null; // e.g. http://localhost:3000
    this.logger = logger;
    this.io = null; // socket.io server (accepts inbound peers)
    this.outbound = new Map(); // peerUrl -> client socket (peers we dialed)
    this.seenTx = new Set(); // recently seen tx ids (bounded echo guard)
  }

  // Attach a socket.io server onto the shared HTTP server so P2P and the
  // Express API live on the same port.
  attach(httpServer) {
    this.io = new Server(httpServer, { cors: { origin: '*' } });
    this.io.on('connection', (socket) => {
      this.logger.log(`[p2p] inbound peer connected (${socket.id})`);
      this.wireSocket(socket);
      // Greet the newcomer: ask for their chain and offer ours.
      this.requestChain(socket);
      this.sendChain(socket);
    });
    return this;
  }

  // Dial another node and keep the connection alive (auto-reconnect).
  connect(peerUrl) {
    if (!peerUrl) {
      return null;
    }
    const url = normalizeOrigin(peerUrl);
    if (url === this.selfUrl) {
      return null; // never dial ourselves, under any spelling
    }
    if (this.outbound.has(url)) {
      return this.outbound.get(url); // already dialing this peer
    }

    const socket = connectClient(url, { reconnection: true });
    this.outbound.set(url, socket);

    socket.on('connect', () => {
      this.logger.log(`[p2p] dialed peer ${url}`);
      this.requestChain(socket);
      this.sendChain(socket);
    });
    socket.on('connect_error', (err) => {
      this.logger.log(`[p2p] cannot reach ${url}: ${err.message}`);
    });
    socket.on('disconnect', () => {
      this.logger.log(`[p2p] lost peer ${url}`);
    });

    this.wireSocket(socket);
    return socket;
  }

  connectToPeers(peerUrls = []) {
    peerUrls.forEach((url) => this.connect(url));
  }

  // Register message handlers on any socket (works for both the inbound
  // server-side sockets and the outbound client sockets). The socket the
  // message arrived on is passed along as the "origin" so relays skip it.
  wireSocket(socket) {
    socket.on(MSG.QUERY_ALL, () => this.sendChain(socket));
    socket.on(MSG.CHAIN, (payload) => this.handleChain(payload, socket));
    socket.on(MSG.NEW_BLOCK, (payload) => this.handleNewBlock(payload, socket));
    socket.on(MSG.NEW_TRANSACTION, (payload) => this.handleNewTransaction(payload, socket));
  }

  // ---- outbound shouts (local origin -> everyone) ---------------------------

  broadcastBlock(block) {
    const data = block instanceof Block ? block.toJSON() : block;
    this.broadcast(MSG.NEW_BLOCK, data, null);
  }

  broadcastTransaction(tx) {
    const data = tx instanceof Transaction ? tx.toJSON() : tx;
    if (data && data.id) {
      this.rememberTx(data.id);
    }
    this.broadcast(MSG.NEW_TRANSACTION, data, null);
  }

  // Send a message to every connected peer, optionally skipping the socket the
  // message originated from (so a relay never bounces straight back).
  broadcast(type, data, originSocket = null) {
    for (const socket of this.everySocket()) {
      // Skip the sender (no bounce-back) and any peer that is not currently
      // connected, so socket.io does not buffer gossip for a dead link forever.
      if (socket !== originSocket && socket.connected) {
        socket.emit(type, data);
      }
    }
  }

  everySocket() {
    const inbound = this.io ? Array.from(this.io.sockets.sockets.values()) : [];
    return [...inbound, ...this.outbound.values()];
  }

  // ---- inbound drumbeats ----------------------------------------------------

  requestChain(socket) {
    socket.emit(MSG.QUERY_ALL);
  }

  sendChain(socket) {
    socket.emit(MSG.CHAIN, {
      chain: this.blockchain.chain.map((block) => block.toJSON()),
      cumulativeWork: this.blockchain.cumulativeWork()
    });
  }

  // A peer sent us their whole chain. Let the blockchain decide if it is
  // stronger; replaceChain validates and compares cumulative work.
  handleChain(payload, originSocket = null) {
    if (!payload || !Array.isArray(payload.chain)) {
      return false;
    }

    const before = this.blockchain.chain.length;
    let replaced = false;
    try {
      replaced = this.blockchain.replaceChain(payload.chain);
    } catch (err) {
      this.logger.log(`[p2p] rejected peer chain: ${err.message}`);
      return false;
    }

    if (replaced) {
      this.logger.log(
        `[p2p] adopted stronger peer chain: ${before} -> ${this.blockchain.chain.length} blocks`
      );
      // Pass the good news on so peers downstream of us also catch up
      // (skip the peer we just learned it from).
      this.broadcast(MSG.NEW_BLOCK, this.blockchain.lastBlock.toJSON(), originSocket);
    }
    return replaced;
  }

  // A peer learned of a new block. If it extends our head, add and relay. If it
  // is further ahead than we can attach, we are missing blocks -> resync.
  handleNewBlock(payload, originSocket) {
    if (!payload || typeof payload.index !== 'number') {
      return;
    }

    const height = this.blockchain.chain.length; // head index is height - 1

    // Already have this exact block on our chain? Then it is an echo -> drop it.
    const localAtIndex = payload.index >= 0 && payload.index < height
      ? this.blockchain.chain[payload.index]
      : null;
    if (localAtIndex && localAtIndex.hash === payload.hash) {
      return;
    }

    if (payload.index === height) {
      let block;
      try {
        block = new Block(payload);
        this.blockchain.addBlock(block);
      } catch (err) {
        // Does not attach to our head (fork or invalid) -> pull the full chain
        // so replaceChain can compare cumulative work and decide.
        this.logger.log(`[p2p] block ${payload.index} did not attach: ${err.message}`);
        if (originSocket) {
          this.requestChain(originSocket);
        }
        return;
      }
      this.logger.log(`[p2p] accepted gossiped block ${block.index} (${block.hash.slice(0, 12)})`);
      this.broadcast(MSG.NEW_BLOCK, payload, originSocket); // flood to the rest
      return;
    }

    // Either we are behind (index > height) or the peer has an UNKNOWN block at
    // a height we already occupy (a competing / heavier-but-shorter fork).
    // Consensus is most-cumulative-work, not longest-chain, so we must let the
    // full chain be judged rather than silently ignore it.
    this.logger.log(`[p2p] unknown/ahead block ${payload.index} (our head ${height - 1}); requesting chain`);
    if (originSocket) {
      this.requestChain(originSocket);
    }
  }

  // A peer learned of a new transaction. Add to our mempool if fresh and valid,
  // then relay to the rest of the tribe.
  handleNewTransaction(payload, originSocket) {
    // Ids must be strings; a non-string id from a hostile peer would otherwise
    // blow up the dedup/log paths and crash the whole node.
    if (!payload || typeof payload.id !== 'string') {
      return;
    }
    if (this.seenTx.has(payload.id) || this.blockchain.mempool.transactions.has(payload.id)) {
      return; // already know it; do not relay (kills the echo)
    }

    let tx;
    try {
      tx = new Transaction(payload);
      if (tx.isCoinbase()) {
        // Coinbase (block reward) txs are minted by miners inside a block, never
        // gossiped loose; accepting one would corrupt the mempool and break mining.
        return;
      }
      this.blockchain.addTransaction(tx);
    } catch (err) {
      this.logger.log(`[p2p] dropped gossiped tx ${String(payload.id).slice(0, 12)}: ${err.message}`);
      return;
    }

    this.rememberTx(tx.id);
    this.logger.log(`[p2p] accepted gossiped tx ${String(tx.id).slice(0, 12)}`);
    this.broadcast(MSG.NEW_TRANSACTION, payload, originSocket); // flood to the rest
  }

  rememberTx(id) {
    this.seenTx.add(id);
    if (this.seenTx.size > SEEN_TX_LIMIT) {
      // Sets keep insertion order, so the first key is the oldest.
      const oldest = this.seenTx.values().next().value;
      this.seenTx.delete(oldest);
    }
  }

  peerCount() {
    const inbound = this.io ? this.io.sockets.sockets.size : 0;
    let outbound = 0;
    for (const socket of this.outbound.values()) {
      if (socket.connected) {
        outbound += 1;
      }
    }
    // Note: a peer we both dialed and that dialed us is counted twice until the
    // Phase 1c identity handshake lets us dedup peers by node id.
    return inbound + outbound;
  }

  close() {
    for (const socket of this.outbound.values()) {
      socket.close();
    }
    this.outbound.clear();
    if (this.io) {
      this.io.close();
    }
  }
}

module.exports = { P2PNode, MSG };
