# auction-view

Court auction database built from 대한민국 법원경매정보 public data.
Three parts only: Windows laptop (collection) / Google Cloud Run (merge + master) /
GitHub (repository and data exchange). No Oracle, no Cloudflare.

## The rule that governs everything else

**The source deletes a case the day after its 기일.** Measured 2026-09-09: a case
is readable only while `saleDate >= today` (KST). The day after, the detail
endpoint answers HTTP 200 with an empty `dma_result` — no 기일내역, no 감정요항, no
매각물건명세서, nothing. 매각공고 search returns the current month only. There is no
historical archive to backfill; the public window is roughly two weeks forward.

Two consequences, both binding:

1. **Canonical is the only copy.** Once the source drops a case, our
   `data/auctions.json` is the sole remaining record of it.
2. **The winning price is decided on the 기일 and vanishes with it.** A case not
   scraped on its sale date loses its result permanently.

### Data preservation (never violate)

- **A 종국된 case's record and documents are never deleted or reduced in
  canonical.** 종국 is recorded as a status only: `status: 'expired'` plus
  `expiredAt`. The row, its documents, events, prices and coverage stay.
- A merge that drops an existing case id is refused by the merge guard
  (`lostCaseRecords`), even when `itemCount` is unchanged — rows can be swapped
  one-for-one and keep the count level.
- Back up canonical before emptying or overwriting it. Delta merges are id-based.

### Collection priority

`detail-enrich.js` has **one** decision point, `priority()`:

- **Tier 0** — `saleDate` is today or tomorrow (KST) **and** `winningPrice` is not
  yet captured. These are the only rows that can be lost forever, so they come
  before everything, most-incomplete first.
- **Tier 1+** — the older ordering: least-enriched first, then nearest 기일.

`collector-alert.js` records any case whose 기일 passed while still missing a
winning price. That number rising means the pipeline is leaking.

## Court access goes through one door

Every request to `courtauction.go.kr` must pass `court-gate.js`:

- machine-wide exclusive lock (`data/court-gate.lock`) — one caller at a time,
  because today's block came from two collectors querying in parallel
- shared pacing across processes (`data/court-gate.json`), default 3.4s + jitter
- a **latch**: on `ipcheck=false` / CAPTCHA / access-denied the gate shuts and
  every later `acquire()` throws `COURT_BLOCKED` until `node court-gate.js --clear`

Run court-facing scripts with the enforcer so an un-gated call cannot go out:

```
NODE_OPTIONS=--require ./court-gate-enforce.js node detail-enrich.js
```

Playwright traffic does not pass through `fetch`; browser-based access must wrap
its whole session in `courtGate.acquire()`.

**When blocked: stop.** No proxy rotation, no CAPTCHA bypass, no IP workaround, no
retrying through it — retrying extends the block. `court-recovery-watch.js` checks
once an hour with a single request and nothing else.

## Layout

| file | role |
|---|---|
| `laptop-worker.js` | laptop cycle: applies pending deltas locally, collects details, publishes a delta, restores canonical |
| `detail-enrich.js` | per-case detail collection, priority queue, expiry marking |
| `apply-worker-deltas.js` | merges `data/worker-deltas/**` into canonical by id |
| `cloud-master-once.js` | Cloud Run one-shot: clone → apply deltas → metrics → guard → push |
| `merge-guard-lib.js` | shrink + record-loss guard, stats coverage recount |
| `court-gate.js` / `court-gate-enforce.js` | the single door to the court |
| `court-recovery-watch.js` | hourly one-request block check |
| `measure-public-window.js` | measures how far the public window reaches |

Tests: `npm run test:guard`, `npm run test:gate`, `npm run test:priority`.

## Conventions

- The laptop never pushes canonical; it publishes `data/worker-deltas/laptop/*.json`
  only. Cloud master is the sole writer of `data/auctions.json`.
- Docker image `data/` is a build-time snapshot and is never the source of truth;
  the master job clones GitHub fresh every run.
- GitHub Actions workflows are `workflow_dispatch` only. No cron — it cost money.
- PATs live in Secret Manager, never in the image, source or repo.
- Dates that matter are KST. A UTC date is a day behind for most of the Korean
  working day and moves the expiry boundary by one.
