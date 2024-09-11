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
  NEW_TRANSACTION: 'NEW_TRANSACTION', // "I just learned of this transaction"
  HELLO: 'HELLO', // "this is my address, remember me"
  QUERY_PEERS: 'QUERY_PEERS', // "who else do you know?"
  PEERS: 'PEERS' // "here are the peers I know"
};

// How many recently-seen transaction ids we remember to stop gossip echoes.
const SEEN_TX_LIMIT = 10_000;

// Give up dialing a dead peer after this many reconnection attempts so it can
// be evicted instead of retrying (and being re-advertised) forever.
const RECONNECT_ATTEMPTS = 10;

// Treat loopback spellings as one host so a node recognises itself and its
// peers no matter how the URL was written (localhost vs 127.0.0.1 vs ::1).
const LOOPBACK_HOSTS = new Set(['localhost', '127.0.0.1', '::1', '[::1]']);

// Turn a URL into a canonical origin, or null if it is not a parseable URL
// string. Returning null (rather than echoing the raw input) means a hostile or
// malformed peer address can never flow into connect() and crash the node.
function normalizeOrigin(url) {
  if (typeof url !== 'string' || url.length === 0) {
    return null;
  }
  try {
    const parsed = new URL(url);
    const host = LOOPBACK_HOSTS.has(parsed.hostname) ? 'localhost' : parsed.hostname;
    return `${parsed.protocol}//${host}:${parsed.port}`;
  } catch (err) {
    return null;
  }
}

class P2PNode {
  constructor(blockchain, { selfUrl = null, logger = console } = {}) {
    this.blockchain = blockchain;
    this.selfUrl = selfUrl ? normalizeOrigin(selfUrl) : null; // e.g. http://localhost:3000
    this.logger = logger;
    this.io = null; // socket.io server (accepts inbound peers)
    this.outbound = new Map(); // peerUrl -> client socket (peers we dialed)
    this.inbound = new Map(); // peerUrl -> server socket (peers that dialed us, learned via HELLO)
    this.knownPeers = new Set(); // every peer address we have ever heard of
    this.seenTx = new Set(); // recently seen tx ids (bounded echo guard)
  }

  // Attach a socket.io server onto the shared HTTP server so P2P and the
  // Express API live on the same port.
  attach(httpServer) {
    this.io = new Server(httpServer, { cors: { origin: '*' } });
    this.io.on('connection', (socket) => {
      this.logger.log(`[p2p] inbound peer connected (${socket.id})`);
      this.wireSocket(socket);
      this.greet(socket); // introduce ourselves, ask who they know, swap chains
    });
    return this;
  }

  // Dial another node and keep the connection alive (auto-reconnect).
  connect(peerUrl) {
    const url = normalizeOrigin(peerUrl);
    if (!url || url === this.selfUrl) {
      return null; // garbage, or ourselves (under any spelling)
    }
    if (this.outbound.has(url)) {
      return this.outbound.get(url); // already dialing this peer
    }
    if (this.inbound.has(url)) {
      return this.inbound.get(url); // already connected to this peer (they dialed us)
    }

    let socket;
    try {
      socket = connectClient(url, { reconnection: true, reconnectionAttempts: RECONNECT_ATTEMPTS });
    } catch (err) {
      this.logger.log(`[p2p] could not dial ${url}: ${err.message}`);
      return null;
    }
    socket.dialedUrl = url; // mark this as a peer WE dialed (outbound)
    this.knownPeers.add(url);
    this.outbound.set(url, socket);

    socket.on('connect', () => {
      this.logger.log(`[p2p] dialed peer ${url}`);
      this.greet(socket); // introduce ourselves, ask who they know, swap chains
    });
    socket.on('connect_error', (err) => {
      this.logger.log(`[p2p] cannot reach ${url}: ${err.message}`);
    });
    socket.on('disconnect', () => {
      if (!socket.dedupedClose) {
        this.logger.log(`[p2p] lost peer ${url}`);
      }
    });
    // Reconnection attempts exhausted -> the peer is gone; stop tracking it so
    // it is neither re-advertised nor counted.
    socket.io.on('reconnect_failed', () => {
      if (this.outbound.get(url) === socket) {
        this.outbound.delete(url);
      }
      this.logger.log(`[p2p] gave up on dead peer ${url}`);
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
    socket.on(MSG.HELLO, (payload) => this.handleHello(payload, socket));
    socket.on(MSG.QUERY_PEERS, () => this.handleQueryPeers(socket));
    socket.on(MSG.PEERS, (payload) => this.handlePeers(payload));
  }

  // Say hello (advertise our address), ask who the peer knows, and swap chains.
  greet(socket) {
    if (this.selfUrl) {
      socket.emit(MSG.HELLO, { url: this.selfUrl });
    }
    socket.emit(MSG.QUERY_PEERS);
    this.requestChain(socket);
    this.sendChain(socket);
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

  // ---- peer discovery (auto-assembling the tribe) ---------------------------

  // A peer told us its real address. Remember it, and if we happen to have BOTH
  // dialed them and been dialed by them, deterministically drop one link so the
  // pair keeps a single connection (the one initiated by the smaller address).
  handleHello(payload, socket) {
    const url = normalizeOrigin(payload && payload.url);
    if (!url) {
      return; // missing or non-string address -> ignore (cannot crash us)
    }

    if (url === this.selfUrl) {
      // The peer claims our own identity. If it is a socket WE dialed, we looped
      // back to ourselves (e.g. an alias of this host) -> tear it down.
      if (socket.dialedUrl && this.outbound.get(socket.dialedUrl) === socket) {
        this.outbound.delete(socket.dialedUrl);
        socket.dedupedClose = true;
        if (typeof socket.close === 'function') {
          socket.close();
        }
      }
      return; // never record ourselves as a peer
    }

    this.knownPeers.add(url);

    if (socket.dialedUrl) {
      return; // a peer WE dialed; already tracked in this.outbound
    }

    // Inbound peer: record its advertised address. Enforce one address per
    // socket so a peer cannot inflate the tribe by spamming HELLOs.
    if (socket.helloUrl && socket.helloUrl !== url && this.inbound.get(socket.helloUrl) === socket) {
      this.inbound.delete(socket.helloUrl); // drop the stale address it advertised before
    }
    socket.helloUrl = url;
    this.inbound.set(url, socket);

    if (!socket.helloCleanupBound) {
      socket.helloCleanupBound = true; // bind the cleanup listener only once
      socket.on('disconnect', () => {
        if (socket.helloUrl && this.inbound.get(socket.helloUrl) === socket) {
          this.inbound.delete(socket.helloUrl);
        }
      });
    }

    // Mutual dial: both of us dialed the other. The node with the greater
    // address gives up its outbound so exactly one link survives.
    if (this.outbound.has(url) && this.selfUrl && this.selfUrl > url) {
      const redundant = this.outbound.get(url);
      this.outbound.delete(url);
      if (redundant) {
        redundant.dedupedClose = true; // so the outbound 'disconnect' stays quiet
        redundant.close();
      }
      this.logger.log(`[p2p] deduped mutual dial with ${url} (kept inbound link)`);
    }
  }

  handleQueryPeers(socket) {
    socket.emit(MSG.PEERS, { peers: this.advertisedPeers() });
  }

  // A peer shared the addresses it knows. Dial any we are not connected to yet;
  // connect() dedups, so this converges to a fully-assembled network.
  handlePeers(payload) {
    if (!payload || !Array.isArray(payload.peers)) {
      return;
    }
    for (const raw of payload.peers) {
      const url = normalizeOrigin(raw); // returns null for non-strings / garbage
      if (!url || url === this.selfUrl) {
        continue;
      }
      this.knownPeers.add(url);
      if (!this.outbound.has(url) && !this.inbound.has(url)) {
        this.connect(url); // meet the newcomer (connect() is crash-safe)
      }
    }
  }

  // Only advertise peers we are actually connected to right now (plus ourselves).
  // Advertising dead/never-reached addresses would make them ripple across the
  // network and be re-dialed forever, so discovery would never settle.
  advertisedPeers() {
    const peers = new Set(this.connectedPeerUrls());
    if (this.selfUrl) {
      peers.add(this.selfUrl);
    }
    return Array.from(peers);
  }

  connectedPeerUrls() {
    const urls = new Set();
    for (const [url, socket] of this.outbound) {
      if (socket.connected) {
        urls.add(url);
      }
    }
    for (const url of this.inbound.keys()) {
      urls.add(url);
    }
    return Array.from(urls);
  }

  peerCount() {
    // After the HELLO dedup settles, each peer pair keeps exactly one link, so
    // counting live inbound + live outbound sockets does not double-count.
    return this.connectedPeerUrls().length;
  }

  close() {
    for (const socket of this.outbound.values()) {
      socket.close();
    }
    this.outbound.clear();
    this.inbound.clear();
    if (this.io) {
      this.io.close();
    }
  }
}

module.exports = { P2PNode, MSG, normalizeOrigin };
