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
// Playwright drives a real browser, whose traffic never reaches this fetch. That
// hole is closed further down by gating postJson/warmup on both of the library's
// client classes - the single choke point every transport goes through - and
// court-browser-fallback gates its own page.evaluate call the same way.

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

// court-auction-notice-search reaches the court two ways: an HTTP client and a
// Playwright client. Both funnel through postJson (and warmup), so gating those
// two methods covers every exported search/detail function and both transports,
// including the browser traffic that never touches global fetch.
function gateClientClass(cls, label) {
  if (!cls || !cls.prototype || cls.prototype.__courtGated__) return false;
  for (const method of ['postJson', 'warmup']) {
    const original = cls.prototype[method];
    if (typeof original !== 'function') continue;
    cls.prototype[method] = function gated(...args) {
      return gate.acquire(`${label}.${method}`, async () => {
        const out = await original.apply(this, args);
        try { gate.inspect(out, `${label}.${method}`); } catch {}
        return out;
      });
    };
  }
  cls.prototype.__courtGated__ = true;
  return true;
}

try {
  const lib = require('court-auction-notice-search');
  const httpGated = gateClientClass(lib.CourtAuctionHttpClient, 'lib:http');
  const pwGated = gateClientClass(lib.CourtAuctionPlaywrightClient, 'lib:playwright');
  if (process.env.COURT_GATE_VERBOSE) {
    console.error(`[court-gate-enforce] library clients gated: http=${httpGated} playwright=${pwGated}`);
  }
} catch (e) {
  console.error('[court-gate-enforce] could not gate court-auction-notice-search: ' + (e.message || e));
}
