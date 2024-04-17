# Nodechain Lab

Nodechain Lab is a hands-on blockchain playground written in Node.js. It starts from the classic educational blockchain idea, then adds the pieces that make the model feel more realistic:

- proof-of-work mining with adjustable difficulty
- signed transactions using elliptic-curve keys
- account balances, nonces, transaction fees, and miner rewards
- a mempool that prioritizes higher-fee transactions
- Merkle roots for block transaction integrity
- chain validation, cumulative-work comparison, and peer consensus
- optional JSON persistence for local experiments
- an HTTP API for mining, transactions, wallets, nodes, and chain inspection

This is not a production cryptocurrency. It is a lab for learning how the moving parts fit together.

## Getting Started

```bash
npm install
npm test
npm start
```

The server defaults to `http://localhost:3000`. Use `PORT=3001 npm start` to run another node.

## API Quick Tour

Create a wallet:

```bash
curl -X POST http://localhost:3000/wallets
```

Mine a block:

```bash
curl -X POST http://localhost:3000/mine \
  -H "Content-Type: application/json" \
  -d "{\"minerAddress\":\"your-wallet-address\"}"
```

Submit a signed transaction:

```bash
curl -X POST http://localhost:3000/transactions/new \
  -H "Content-Type: application/json" \
  -d "{\"privateKey\":\"...\",\"publicKey\":\"...\",\"to\":\"recipient-address\",\"amount\":5,\"fee\":1}"
```

Inspect the chain:

```bash
curl http://localhost:3000/chain
```

Register peers and resolve conflicts:

```bash
curl -X POST http://localhost:3000/nodes/register \
  -H "Content-Type: application/json" \
  -d "{\"nodes\":[\"http://localhost:3001\"]}"

curl http://localhost:3000/nodes/resolve
```

## Project Layout

- `src/block.js` - block shape, hashing, mining, and Merkle root support
- `src/blockchain.js` - chain state, validation, mining, difficulty, and consensus helpers
- `src/transaction.js` - transaction model, signing payloads, and verification
- `src/wallet.js` - local key generation and transaction signing helpers
- `src/mempool.js` - pending transaction collection and fee ordering
- `src/storage.js` - simple JSON persistence
- `src/server.js` - Express API
- `tests/` - Node test runner coverage for core behavior

