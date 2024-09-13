'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const SSEHub = require('../src/sse');

// A minimal fake Express response/request so we can drive the hub without sockets.
function fakeConn({ write = () => true, writableLength = 0 } = {}) {
  const writes = [];
  let closeHandler = null;
  const res = {
    writeHead() {},
    write(payload) {
      writes.push(payload);
      return write(payload);
    },
    end() {
      res.ended = true;
    },
    on() {},
    ended: false,
    writableLength
  };
  const req = {
    on(ev, fn) {
      if (ev === 'close') closeHandler = fn;
    }
  };
  return { req, res, writes, close: () => closeHandler && closeHandler() };
}

test('SSE hub delivers named events and cleans up on client close', () => {
  const hub = new SSEHub();
  const conn = fakeConn();
  hub.handler(conn.req, conn.res);
  assert.equal(hub.size, 1);

  hub.broadcast('block:added', { height: 1 });
  assert.ok(conn.writes.some((w) => w.includes('event: block:added')));
  assert.ok(conn.writes.some((w) => w.includes('"height":1')));

  conn.close(); // client disconnects
  assert.equal(hub.size, 0);
  assert.equal(conn.res.ssePing, null, 'ping interval cleared');
});

test('SSE hub drops a backpressured client that exceeds the buffer cap', () => {
  const hub = new SSEHub();
  // write() always reports backpressure and the buffer is over the 1MB cap.
  const conn = fakeConn({ write: () => false, writableLength: 2_000_000 });
  hub.handler(conn.req, conn.res); // the initial retry write already trips the cap
  assert.equal(hub.size, 0, 'slow client dropped, not buffered forever');
  assert.equal(conn.res.ended, true, 'its connection was ended');
});
