'use strict';

// setTimeout silently reduces any delay above the 32-bit signed max to 1ms, so
// we clamp the mining interval into a safe range to avoid an accidental runaway.
const MIN_INTERVAL = 10;
const MAX_INTERVAL = 2147483647;

function clampInterval(value, fallback) {
  const n = Number(value);
  if (!Number.isFinite(n)) {
    return fallback; // non-numeric (e.g. "abc", NaN) -> keep the current value
  }
  return Math.min(MAX_INTERVAL, Math.max(MIN_INTERVAL, Math.floor(n)));
}

// Accept only a real boolean or the exact string "true"; Boolean("false") is
// truthy, so naive coercion would enable empty mining when asked to disable it.
function toBool(value, fallback) {
  if (value === undefined) {
    return fallback;
  }
  return value === true || value === 'true';
}

// The miner-spirit: drives mining on its own so a node no longer needs a human
// to poke POST /mine. It watches the mempool and, on a steady tick, mines a
// block, shouts it to peers, and persists it.
class Miner {
  constructor(blockchain, { p2p = null, onBlock = null, logger = console } = {}) {
    this.blockchain = blockchain;
    this.p2p = p2p; // to broadcast freshly mined blocks
    this.onBlock = onBlock; // side effect after a block is mined (e.g. persist)
    this.logger = logger;

    this.minerAddress = null;
    this.interval = 5000; // ms between mining ticks
    this.mineEmpty = false; // also mine when the mempool is empty?
    this.timer = null;
    this.running = false;
    this.blocksMined = 0;
  }

  start({ minerAddress, interval, mineEmpty, immediate = true } = {}) {
    if (!minerAddress) {
      throw new Error('A miner address is required to start mining');
    }
    this.minerAddress = minerAddress;
    this.interval = clampInterval(interval, this.interval);
    this.mineEmpty = toBool(mineEmpty, this.mineEmpty);

    if (this.running) {
      // Already beating: apply the new settings to the in-flight loop by
      // rescheduling, so a stale long timer cannot keep the old cadence.
      if (this.timer) {
        clearTimeout(this.timer);
      }
      this.scheduleNext(this.interval);
      return this.status();
    }

    this.running = true;
    this.logger.log(
      `[miner] auto-mining to ${minerAddress} every ${this.interval}ms (mineEmpty=${this.mineEmpty})`
    );
    // immediate=false lets a booting node wait one interval so an initial peer
    // sync can finish before it mines (avoids wasted work on a stale head).
    this.scheduleNext(immediate ? 0 : this.interval);
    return this.status();
  }

  stop() {
    this.running = false;
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    this.logger.log('[miner] stopped');
    return this.status();
  }

  // We reschedule with setTimeout (not setInterval) so a slow grind can never
  // overlap with the next tick.
  scheduleNext(delay = this.interval) {
    if (!this.running) {
      return;
    }
    this.timer = setTimeout(() => this.tick(), delay);
    if (this.timer.unref) {
      this.timer.unref(); // do not keep the process alive just for mining
    }
  }

  tick() {
    if (!this.running) {
      return;
    }
    try {
      if (this.hasWork() || this.mineEmpty) {
        this.mineOnce();
      }
    } catch (err) {
      this.logger.log(`[miner] mining error: ${err.message}`);
    } finally {
      this.scheduleNext(this.interval);
    }
  }

  hasWork() {
    return this.blockchain.mempool.list().length > 0;
  }

  // Mine exactly one block and publish it. Used by the tick loop and callable
  // directly (e.g. for a one-shot mine or from a test).
  mineOnce(minerAddress = this.minerAddress) {
    if (!minerAddress) {
      throw new Error('A miner address is required to mine');
    }
    const block = this.blockchain.minePendingTransactions(minerAddress);
    this.blocksMined += 1;
    this.logger.log(
      `[miner] mined block ${block.index} (${block.hash.slice(0, 12)}) ` +
        `with ${block.transactions.length - 1} tx(s)`
    );
    // Persist BEFORE broadcasting (matching the /mine route), so we never gossip
    // a block to peers that failed to save locally.
    if (this.onBlock) {
      this.onBlock(block);
    }
    if (this.p2p) {
      this.p2p.broadcastBlock(block);
    }
    return block;
  }

  status() {
    return {
      running: this.running,
      minerAddress: this.minerAddress,
      interval: this.interval,
      mineEmpty: this.mineEmpty,
      blocksMined: this.blocksMined,
      height: this.blockchain.chain.length - 1,
      pending: this.blockchain.mempool.list().length
    };
  }
}

module.exports = Miner;
