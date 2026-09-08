// Makes the gate structural rather than a convention.
//
//   NODE_OPTIONS=--require ./court-gate-enforce.js node whatever.js
//
// Replaces global fetch. A request to the court host that is not inside
// courtGate.acquire() throws COURT_UNGATED instead of going out, so a script that
// forgets the gate cannot reach the court at all. Everything else passes through
// untouched. Responses are sniffed for block markers so a 200 that says
// ipcheck=false still latches the gate.
//
// Known gap, stated rather than papered over: Playwright drives a real browser,
// whose traffic never passes through this fetch. Browser-based court access must
// call courtGate.acquire() around the whole session - see court-browser-fallback.

const gate = require('./court-gate');

if (!global.__COURT_GATE_RAW_FETCH__) {
  const raw = global.fetch;
  global.__COURT_GATE_RAW_FETCH__ = raw;

  global.fetch = async function gatedFetch(input, init) {
    const url = typeof input === 'string' ? input : (input?.url || String(input));
    if (!url.includes(gate.COURT_HOST)) return raw(input, init);

    const s = gate.status();
    if (s.blocked) {
      const e = new Error(`court gate is latched (${s.blocked.reason} at ${s.blocked.at}); refusing ${url}`);
      e.code = 'COURT_BLOCKED';
      throw e;
    }
    if (!global.__COURT_GATE_OPEN__) {
      const e = new Error(
        `ungated court request refused: ${url}\n` +
        'wrap it in require("./court-gate").acquire(owner, fn) or use courtGate.request()'
      );
      e.code = 'COURT_UNGATED';
      throw e;
    }

    const res = await raw(input, init);
    // Peek without consuming the caller's body.
    try {
      const clone = res.clone();
      const text = await clone.text();
      gate.inspect(text, url);
    } catch {}
    return res;
  };

  if (process.env.COURT_GATE_VERBOSE) {
    console.error('[court-gate-enforce] global fetch is gated for ' + gate.COURT_HOST);
  }
}
