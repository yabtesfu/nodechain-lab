'use strict';

// If a client's unflushed write buffer grows past this, it cannot keep up
// (e.g. a suspended browser tab that stopped reading). We drop it rather than
// buffer events in node memory forever.
const MAX_BUFFER_BYTES = 1_000_000;

// A tiny Server-Sent Events hub: browsers open GET /events and keep the
// connection open; the node pushes a line whenever something happens (a block
// is mined/received, a transaction arrives, the chain is replaced). This is how
// the dashboard updates in real time without polling.
class SSEHub {
  constructor() {
    this.clients = new Set();
  }

  // Express handler for GET /events.
  handler(req, res) {
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      Connection: 'keep-alive',
      'Access-Control-Allow-Origin': '*'
    });
    this.clients.add(res);

    // Periodic comment keeps proxies from closing an idle connection.
    res.ssePing = setInterval(() => this.send(res, ': ping\n\n'), 25_000);
    if (res.ssePing.unref) {
      res.ssePing.unref();
    }

    // Clean up on a graceful close AND on an async socket error (EPIPE, reset).
    req.on('close', () => this.drop(res));
    res.on('error', () => this.drop(res));

    this.send(res, 'retry: 3000\n\n'); // tell the browser how fast to reconnect
  }

  drop(res) {
    if (res.ssePing) {
      clearInterval(res.ssePing);
      res.ssePing = null;
    }
    this.clients.delete(res);
  }

  // Write to one client, honoring backpressure. res.write() does NOT throw for a
  // stalled socket - it returns false and buffers - so we watch the buffer size
  // and drop a client that has fallen too far behind.
  send(res, payload) {
    try {
      const ok = res.write(payload);
      if (!ok && res.writableLength > MAX_BUFFER_BYTES) {
        this.drop(res);
        res.end();
      }
    } catch (err) {
      this.drop(res);
    }
  }

  broadcast(event, data) {
    const payload = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
    for (const res of this.clients) {
      this.send(res, payload);
    }
  }

  get size() {
    return this.clients.size;
  }

  close() {
    for (const res of this.clients) {
      if (res.ssePing) {
        clearInterval(res.ssePing);
        res.ssePing = null;
      }
      try {
        res.end();
      } catch (err) {
        // ignore
      }
    }
    this.clients.clear();
  }
}

module.exports = SSEHub;
