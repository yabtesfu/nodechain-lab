'use strict';

const { Server } = require('socket.io');
const { io: connectClient } = require('socket.io-client');

// The words the drums can beat. Phase 1a only needs "send me your chain"
// and "here is a chain"; later phases add live block/tx gossip and peer swap.
const MSG = {
  QUERY_ALL: 'QUERY_ALL', // "beat me your whole chain"
  CHAIN: 'CHAIN' // "here is my whole chain"
};

class P2PNode {
  constructor(blockchain, { selfUrl = null, logger = console } = {}) {
    this.blockchain = blockchain;
    this.selfUrl = selfUrl; // e.g. http://localhost:3000
    this.logger = logger;
    this.io = null; // socket.io server (accepts inbound peers)
    this.outbound = new Map(); // peerUrl -> client socket (peers we dialed)
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
    if (!peerUrl || peerUrl === this.selfUrl) {
      return null;
    }
    if (this.outbound.has(peerUrl)) {
      return this.outbound.get(peerUrl);
    }

    const socket = connectClient(peerUrl, { reconnection: true });
    this.outbound.set(peerUrl, socket);

    socket.on('connect', () => {
      this.logger.log(`[p2p] dialed peer ${peerUrl}`);
      this.requestChain(socket);
      this.sendChain(socket);
    });
    socket.on('connect_error', (err) => {
      this.logger.log(`[p2p] cannot reach ${peerUrl}: ${err.message}`);
    });
    socket.on('disconnect', () => {
      this.logger.log(`[p2p] lost peer ${peerUrl}`);
    });

    this.wireSocket(socket);
    return socket;
  }

  connectToPeers(peerUrls = []) {
    peerUrls.forEach((url) => this.connect(url));
  }

  // Register message handlers on any socket (works for both the inbound
  // server-side sockets and the outbound client sockets).
  wireSocket(socket) {
    socket.on(MSG.QUERY_ALL, () => this.sendChain(socket));
    socket.on(MSG.CHAIN, (payload) => this.handleChain(payload));
  }

  requestChain(socket) {
    socket.emit(MSG.QUERY_ALL);
  }

  sendChain(socket) {
    socket.emit(MSG.CHAIN, {
      chain: this.blockchain.chain.map((block) => block.toJSON()),
      cumulativeWork: this.blockchain.cumulativeWork()
    });
  }

  // A peer sent us their chain. Let the blockchain decide if it is stronger;
  // replaceChain already validates and compares cumulative work.
  handleChain(payload) {
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
    }
    return replaced;
  }

  peerCount() {
    const inbound = this.io ? this.io.engine.clientsCount : 0;
    return inbound + this.outbound.size;
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
