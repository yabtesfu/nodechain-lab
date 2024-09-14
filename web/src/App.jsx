import React, { useCallback, useEffect, useRef, useState } from 'react';
import {
  API,
  getOverview,
  getAccount,
  submitTransaction,
  mineOnce,
  startMining,
  stopMining,
  openEvents
} from './api.js';
import { createWallet, signTransaction } from './crypto.js';

const short = (s, n = 10) => (s && s.length > n ? `${s.slice(0, n)}…` : s || '');
const fmt = (n) => new Intl.NumberFormat().format(n ?? 0);
const timeAgo = (ts) => {
  if (!ts) return '';
  const secs = Math.max(0, Math.round((Date.now() - ts) / 1000));
  if (secs < 60) return `${secs}s ago`;
  if (secs < 3600) return `${Math.round(secs / 60)}m ago`;
  return `${Math.round(secs / 3600)}h ago`;
};

const WALLET_KEY = 'nodechain-wallet';

export default function App() {
  const [overview, setOverview] = useState(null);
  const [live, setLive] = useState(false);
  const [error, setError] = useState('');
  const [toast, setToast] = useState('');
  const [flash, setFlash] = useState(new Set());
  const [wallet, setWallet] = useState(() => {
    try {
      return JSON.parse(localStorage.getItem(WALLET_KEY)) || null;
    } catch {
      return null;
    }
  });

  const reqId = useRef(0);
  const refresh = useCallback(() => {
    const id = ++reqId.current;
    getOverview()
      .then((o) => {
        // Ignore a response that a newer refresh has already superseded, so a
        // burst of events can never render an out-of-order (stale) snapshot.
        if (id === reqId.current) {
          setOverview(o);
          setError(''); // recovered - clear any stale error banner
        }
      })
      .catch((e) => {
        if (id === reqId.current) {
          setError(e.message);
        }
      });
  }, []);

  useEffect(() => {
    refresh();
    const es = openEvents((type, data) => {
      if (type === 'block:added' && data?.block) {
        const idx = data.block.index;
        setFlash((prev) => new Set(prev).add(idx));
        setTimeout(() => {
          setFlash((prev) => {
            const next = new Set(prev);
            next.delete(idx);
            return next;
          });
        }, 1400);
      }
      refresh();
    }, setLive);
    const poll = setInterval(refresh, 6000); // fallback if the stream drops
    return () => {
      es.close();
      clearInterval(poll);
    };
  }, [refresh]);

  const flashMsg = (msg, isError = false) => {
    setError(isError ? msg : '');
    if (!isError) {
      setToast(msg);
      setTimeout(() => setToast(''), 2500);
    }
  };

  const onCreateWallet = () => {
    // Generated entirely in the browser - the private key never touches the node.
    const w = createWallet();
    setWallet(w);
    localStorage.setItem(WALLET_KEY, JSON.stringify(w));
    flashMsg('New wallet created (keys stay in your browser)');
  };

  if (!overview) {
    return (
      <div className="loading">
        <div className="spinner" />
        <p>Connecting to node at {API || 'this origin'}…</p>
        {error && <p className="error">{error}</p>}
      </div>
    );
  }

  const mining = overview.mining || {};

  return (
    <div className="app">
      <header className="topbar">
        <div className="brand">
          <span className="logo">⛓️</span>
          <div>
            <h1>Nodechain Lab</h1>
            <span className="sub">live node dashboard · {API || 'same origin'}</span>
          </div>
        </div>
        <div className={`live ${live ? 'on' : 'off'}`}>
          <span className="dot" /> {live ? 'LIVE' : 'reconnecting…'}
        </div>
      </header>

      {error && <div className="banner error">{error}</div>}
      {toast && <div className="banner ok">{toast}</div>}

      <section className="stats">
        <Stat label="Height" value={fmt(overview.height)} />
        <Stat label="Difficulty" value={overview.difficulty} hint={`next ${overview.nextDifficulty}`} />
        <Stat label="Cumulative work" value={fmt(overview.cumulativeWork)} />
        <Stat label="Mempool" value={fmt(overview.mempoolSize)} hint="pending tx" />
        <Stat label="Peers" value={fmt(overview.peers)} hint="connected" />
        <Stat
          label="Mining"
          value={mining.running ? 'ON' : 'OFF'}
          className={mining.running ? 'mining-on' : ''}
          hint={mining.running ? `${mining.blocksMined} mined` : 'idle'}
        />
      </section>

      <div className="grid">
        <div className="col main">
          <Panel title="Block feed" subtitle="newest first, live">
            <div className="blocks">
              {overview.recentBlocks.map((b) => (
                <BlockCard key={b.hash} block={b} flash={flash.has(b.index)} />
              ))}
            </div>
          </Panel>
        </div>

        <div className="col side">
          <Panel title="Mempool" subtitle={`${overview.mempoolSize} pending`}>
            {overview.mempool.length === 0 ? (
              <Empty>No pending transactions</Empty>
            ) : (
              <ul className="txlist">
                {overview.mempool.map((tx) => (
                  <li key={tx.id}>
                    <code>{short(tx.from, 8)}</code>
                    <span className="arrow">→</span>
                    <code>{short(tx.to, 8)}</code>
                    <span className="amt">{tx.amount}</span>
                    <span className="fee">fee {tx.fee}</span>
                  </li>
                ))}
              </ul>
            )}
          </Panel>

          <Panel title="Balances">
            {Object.keys(overview.balances).length === 0 ? (
              <Empty>No balances yet - mine a block</Empty>
            ) : (
              <ul className="balances">
                {Object.entries(overview.balances)
                  .sort((a, b) => b[1] - a[1])
                  .map(([addr, bal]) => (
                    <li key={addr} className={wallet && addr === wallet.address ? 'me' : ''}>
                      <code>{short(addr, 16)}</code>
                      <span className="bal">{fmt(bal)}</span>
                    </li>
                  ))}
              </ul>
            )}
          </Panel>

          <Panel title="Peers" subtitle={`${overview.peers} connected`}>
            {overview.connectedPeers.length === 0 ? (
              <Empty>Solo node - no peers</Empty>
            ) : (
              <ul className="peers">
                {overview.connectedPeers.map((p) => (
                  <li key={p}>
                    <span className="dot on" /> <code>{p}</code>
                  </li>
                ))}
              </ul>
            )}
          </Panel>
        </div>
      </div>

      <div className="grid controls">
        <WalletPanel wallet={wallet} onCreate={onCreateWallet} />
        <SendPanel wallet={wallet} onDone={flashMsg} />
        <MiningPanel wallet={wallet} mining={mining} onDone={flashMsg} />
      </div>

      <footer className="foot">
        Nodechain Lab · educational blockchain · real-time via Server-Sent Events
      </footer>
    </div>
  );
}

function Stat({ label, value, hint, className = '' }) {
  return (
    <div className={`stat ${className}`}>
      <div className="stat-value">{value}</div>
      <div className="stat-label">{label}</div>
      {hint && <div className="stat-hint">{hint}</div>}
    </div>
  );
}

function Panel({ title, subtitle, children }) {
  return (
    <section className="panel">
      <div className="panel-head">
        <h2>{title}</h2>
        {subtitle && <span className="panel-sub">{subtitle}</span>}
      </div>
      <div className="panel-body">{children}</div>
    </section>
  );
}

function Empty({ children }) {
  return <div className="empty">{children}</div>;
}

function BlockCard({ block, flash }) {
  const txCount = block.transactions.length;
  return (
    <div className={`block ${flash ? 'flash' : ''}`}>
      <div className="block-idx">#{block.index}</div>
      <div className="block-body">
        <code className="hash">{short(block.hash, 22)}</code>
        <div className="block-meta">
          <span>{txCount} tx</span>
          <span>diff {block.difficulty}</span>
          <span>miner {short(block.miner, 8) || '-'}</span>
          <span>{timeAgo(block.timestamp)}</span>
        </div>
      </div>
    </div>
  );
}

function WalletPanel({ wallet, onCreate }) {
  return (
    <Panel title="Wallet">
      {wallet ? (
        <div className="wallet">
          <label>Address</label>
          <code className="pill">{wallet.address}</code>
          <p className="ok-note">
            🔒 Private key stays in your browser - transactions are signed here and
            the key is never sent to the node.
          </p>
          <button className="ghost" onClick={onCreate}>
            New wallet
          </button>
        </div>
      ) : (
        <div className="wallet">
          <Empty>No wallet yet</Empty>
          <button onClick={onCreate}>Create wallet</button>
        </div>
      )}
    </Panel>
  );
}

function SendPanel({ wallet, onDone }) {
  const [to, setTo] = useState('');
  const [amount, setAmount] = useState('');
  const [fee, setFee] = useState('1');
  const [busy, setBusy] = useState(false);

  const submit = async (e) => {
    e.preventDefault();
    if (!wallet) return onDone('Create a wallet first', true);
    setBusy(true);
    try {
      // Ask the node only for the next nonce; sign locally; send the signature.
      const account = await getAccount(wallet.address);
      const signed = signTransaction(wallet, {
        to: to.trim(),
        amount: Number(amount),
        fee: Number(fee),
        nonce: account.nextNonce
      });
      await submitTransaction(signed);
      onDone('Transaction signed in-browser and submitted');
      setTo('');
      setAmount('');
    } catch (err) {
      onDone(err.message, true);
    } finally {
      setBusy(false);
    }
  };

  return (
    <Panel title="Send transaction">
      <form className="form" onSubmit={submit}>
        <label>To address</label>
        <input value={to} onChange={(e) => setTo(e.target.value)} placeholder="recipient address" />
        <div className="row">
          <div>
            <label>Amount</label>
            <input value={amount} onChange={(e) => setAmount(e.target.value)} type="number" min="0" />
          </div>
          <div>
            <label>Fee</label>
            <input value={fee} onChange={(e) => setFee(e.target.value)} type="number" min="0" />
          </div>
        </div>
        <button disabled={busy || !wallet}>{busy ? 'Sending…' : 'Send'}</button>
      </form>
    </Panel>
  );
}

function MiningPanel({ wallet, mining, onDone }) {
  const [interval, setIntervalMs] = useState('3000');
  const [mineEmpty, setMineEmpty] = useState(true);
  const [busy, setBusy] = useState(false);
  const address = mining.minerAddress || (wallet && wallet.address) || '';

  const act = async (fn, label) => {
    setBusy(true);
    try {
      await fn();
      onDone(label);
    } catch (err) {
      onDone(err.message, true);
    } finally {
      setBusy(false);
    }
  };

  const start = () => {
    if (!address) return onDone('Create a wallet (miner address) first', true);
    return act(
      () => startMining({ minerAddress: address, interval: Number(interval), mineEmpty }),
      'Auto-mining started'
    );
  };

  return (
    <Panel title="Mining" subtitle={mining.running ? 'running' : 'stopped'}>
      <div className="mining">
        <div className="mining-status">
          <span className={`dot ${mining.running ? 'on' : 'off'}`} />
          {mining.running
            ? `mining every ${mining.interval}ms · ${mining.blocksMined} blocks`
            : 'idle'}
        </div>
        <div className="row">
          <div>
            <label>Interval (ms)</label>
            <input value={interval} onChange={(e) => setIntervalMs(e.target.value)} type="number" min="10" />
          </div>
          <label className="check">
            <input type="checkbox" checked={mineEmpty} onChange={(e) => setMineEmpty(e.target.checked)} />
            mine empty
          </label>
        </div>
        <div className="btnrow">
          {mining.running ? (
            <button className="danger" disabled={busy} onClick={() => act(stopMining, 'Auto-mining stopped')}>
              Stop
            </button>
          ) : (
            <button disabled={busy} onClick={start}>
              Start auto-mine
            </button>
          )}
          <button
            className="ghost"
            disabled={busy || !address}
            onClick={() => act(() => mineOnce(address), 'Mined one block')}
          >
            Mine one
          </button>
        </div>
      </div>
    </Panel>
  );
}
