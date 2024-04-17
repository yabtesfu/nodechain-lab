'use strict';

const Block = require('./block');
const Mempool = require('./mempool');
const Transaction = require('./transaction');

function cloneState(state) {
  return {
    balances: new Map(state.balances),
    nonces: new Map(state.nonces)
  };
}

class Blockchain {
  constructor({
    difficulty = 3,
    miningReward = 50,
    adjustmentInterval = 5,
    targetBlockTime = 30_000,
    genesisTimestamp = 0
  } = {}) {
    this.difficulty = difficulty;
    this.miningReward = miningReward;
    this.adjustmentInterval = adjustmentInterval;
    this.targetBlockTime = targetBlockTime;
    this.mempool = new Mempool();
    this.nodes = new Set();
    this.chain = [this.createGenesisBlock(genesisTimestamp)];
  }

  static fromJSON(snapshot, options = {}) {
    const blockchain = new Blockchain(options);
    blockchain.chain = snapshot.chain.map((block) => new Block(block));
    if (snapshot.mempool) {
      snapshot.mempool.forEach((tx) => blockchain.mempool.add(tx));
    }
    if (snapshot.nodes) {
      snapshot.nodes.forEach((node) => blockchain.registerNode(node));
    }
    return blockchain;
  }

  createGenesisBlock(timestamp) {
    const block = new Block({
      index: 0,
      timestamp,
      transactions: [],
      previousHash: '0',
      difficulty: 1,
      miner: 'genesis',
      metadata: { network: 'nodechain-lab' }
    });
    return block.mine();
  }

  get lastBlock() {
    return this.chain[this.chain.length - 1];
  }

  registerNode(address) {
    const parsed = new URL(address);
    this.nodes.add(parsed.origin);
  }

  nextDifficulty() {
    if (this.chain.length < this.adjustmentInterval + 1) {
      return this.difficulty;
    }

    if ((this.chain.length - 1) % this.adjustmentInterval !== 0) {
      return this.lastBlock.difficulty;
    }

    const last = this.lastBlock;
    const anchor = this.chain[this.chain.length - 1 - this.adjustmentInterval];
    const expected = this.targetBlockTime * this.adjustmentInterval;
    const actual = last.timestamp - anchor.timestamp;

    if (actual < expected / 2) {
      return Math.min(last.difficulty + 1, 6);
    }
    if (actual > expected * 2) {
      return Math.max(last.difficulty - 1, 1);
    }
    return last.difficulty;
  }

  addTransaction(input) {
    const tx = input instanceof Transaction ? input : new Transaction(input);
    const state = this.stateWithPending();
    this.assertValidTransaction(tx, state);
    return this.mempool.add(tx);
  }

  stateWithPending() {
    const state = this.getState();
    for (const tx of this.mempool.ordered()) {
      if (this.isValidTransaction(tx, state)) {
        this.applyTransaction(tx, state);
      }
    }
    return state;
  }

  getState(chain = this.chain) {
    const state = { balances: new Map(), nonces: new Map() };

    for (const block of chain) {
      const transactions = block.transactions.map((tx) =>
        tx instanceof Transaction ? tx : new Transaction(tx)
      );
      const coinbase = transactions.find((tx) => tx.isCoinbase());
      const regular = transactions.filter((tx) => !tx.isCoinbase());

      for (const tx of regular) {
        this.applyTransaction(tx, state);
      }
      if (coinbase) {
        this.credit(state, coinbase.to, coinbase.amount);
      }
    }

    return state;
  }

  getBalance(address) {
    return this.getState().balances.get(address) || 0;
  }

  nextNonce(address) {
    return (this.stateWithPending().nonces.get(address) || 0) + 1;
  }

  assertValidTransaction(tx, state) {
    if (!this.isValidTransaction(tx, state)) {
      throw new Error(`Invalid transaction ${tx.id}`);
    }
  }

  isValidTransaction(tx, state) {
    if (!tx.verify()) {
      return false;
    }
    if (!tx.to || tx.amount <= 0 || tx.fee < 0) {
      return false;
    }
    if (tx.isCoinbase()) {
      return true;
    }

    const balance = state.balances.get(tx.from) || 0;
    const expectedNonce = (state.nonces.get(tx.from) || 0) + 1;
    return balance >= tx.amount + tx.fee && tx.nonce === expectedNonce;
  }

  applyTransaction(tx, state) {
    if (tx.isCoinbase()) {
      this.credit(state, tx.to, tx.amount);
      return;
    }

    this.debit(state, tx.from, tx.amount + tx.fee);
    this.credit(state, tx.to, tx.amount);
    state.nonces.set(tx.from, tx.nonce);
  }

  credit(state, address, amount) {
    state.balances.set(address, (state.balances.get(address) || 0) + amount);
  }

  debit(state, address, amount) {
    state.balances.set(address, (state.balances.get(address) || 0) - amount);
  }

  selectTransactions(limit = 100) {
    const state = this.getState();
    const selected = [];
    let fees = 0;

    for (const tx of this.mempool.ordered(limit)) {
      if (this.isValidTransaction(tx, state)) {
        selected.push(tx);
        fees += tx.fee;
        this.applyTransaction(tx, state);
      }
    }

    return { selected, fees };
  }

  minePendingTransactions(minerAddress) {
    if (!minerAddress) {
      throw new Error('A miner address is required');
    }

    const { selected, fees } = this.selectTransactions();
    const reward = Transaction.reward(
      minerAddress,
      this.miningReward + fees,
      this.chain.length,
      fees
    );

    const block = new Block({
      index: this.chain.length,
      timestamp: Date.now(),
      transactions: [reward, ...selected],
      previousHash: this.lastBlock.hash,
      difficulty: this.nextDifficulty(),
      miner: minerAddress
    }).mine();

    this.addBlock(block);
    this.mempool.clearIncluded(selected);
    return block;
  }

  addBlock(input) {
    const block = input instanceof Block ? input : new Block(input);
    if (block.index !== this.chain.length) {
      throw new Error('Block index does not follow the local chain');
    }
    if (block.previousHash !== this.lastBlock.hash) {
      throw new Error('Block previous hash does not match local head');
    }
    if (!block.hasValidHash()) {
      throw new Error('Block hash is invalid');
    }

    const candidate = [...this.chain, block];
    if (!this.isValidChain(candidate)) {
      throw new Error('Block transactions are invalid');
    }

    this.chain.push(block);
    return block;
  }

  isValidChain(chainInput) {
    const chain = chainInput.map((block) => block instanceof Block ? block : new Block(block));
    if (chain.length === 0 || chain[0].previousHash !== '0') {
      return false;
    }

    const state = { balances: new Map(), nonces: new Map() };

    for (let i = 0; i < chain.length; i += 1) {
      const block = chain[i];
      if (!block.hasValidHash()) {
        return false;
      }
      if (i > 0 && block.previousHash !== chain[i - 1].hash) {
        return false;
      }

      const transactions = block.transactions.map((tx) =>
        tx instanceof Transaction ? tx : new Transaction(tx)
      );
      const coinbases = transactions.filter((tx) => tx.isCoinbase());
      const regular = transactions.filter((tx) => !tx.isCoinbase());
      const working = cloneState(state);
      let fees = 0;

      for (const tx of regular) {
        if (!this.isValidTransaction(tx, working)) {
          return false;
        }
        fees += tx.fee;
        this.applyTransaction(tx, working);
      }

      if (i === 0) {
        if (coinbases.length > 0) {
          return false;
        }
      } else {
        if (coinbases.length !== 1) {
          return false;
        }
        const reward = coinbases[0];
        if (!reward.verify() || reward.amount > this.miningReward + fees) {
          return false;
        }
        this.applyTransaction(reward, working);
      }

      state.balances = working.balances;
      state.nonces = working.nonces;
    }

    return true;
  }

  cumulativeWork(chain = this.chain) {
    return chain.reduce((work, block) => work + (2 ** block.difficulty), 0);
  }

  replaceChain(candidate) {
    const blocks = candidate.map((block) => new Block(block));
    if (!this.isValidChain(blocks)) {
      return false;
    }
    if (this.cumulativeWork(blocks) <= this.cumulativeWork()) {
      return false;
    }
    this.chain = blocks;
    return true;
  }

  snapshot() {
    return {
      chain: this.chain.map((block) => block.toJSON()),
      mempool: this.mempool.toJSON(),
      nodes: Array.from(this.nodes),
      settings: {
        difficulty: this.difficulty,
        miningReward: this.miningReward,
        adjustmentInterval: this.adjustmentInterval,
        targetBlockTime: this.targetBlockTime
      }
    };
  }
}

module.exports = Blockchain;

