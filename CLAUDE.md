# auction-view

Court auction database built from 대한민국 법원경매정보 public data.
Windows laptop (collection) / Google Cloud Run (merge + master) / GitHub
(repository and data exchange) / Cloudflare Pages + KV (the only thing any screen
reads). No Oracle. Cloudflare was ruled out originally and brought back on
2026-09-09 because ZibTok, which shows this data, runs on Cloudflare Pages.

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

- **Tier 0** — `saleDate` is today (KST) **and** `winningPrice` is not yet
  captured. These vanish tonight, so they come before everything else.
- **Tier 1** — `saleDate` is tomorrow and no winning price. Next in line, but not
  lost tonight, so it must not share tier 0: with both in it, a pass took 8.2
  hours and today's cases were revisited about once before midnight.
- **Tier 2+** — the older ordering: least-enriched first, then nearest 기일.

A re-check of a tier-0 case skips the 현황조사서 request; it needs only the result.

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

## Secrets (violating this is treated as a top-severity incident)

A token, PAT or secret string goes to Secret Manager or an untracked `.env` the
moment it exists, and is **never written again** - not in a report, a log, a
commit message, a comment, or terminal output. That includes the first eight
characters: a prefix is still the secret, and it still ends up in a transcript
that outlives the task.

Refer to a secret by name only:

    token: cloudflare-api-token   created: 2026-09-09   for: KV upload + Pages deploy

not by any part of its value. When a command needs one, take it from the
environment (`$CLOUDFLARE_API_TOKEN`) so the value never appears in the command
line either, and pipe output through a redaction filter when a tool might echo it.

If a secret does reach a report, a log or a chat, say so immediately and put that
token on the revocation list in the same message. Rotating it is the only fix -
scrubbing the file is not, because the value has already been read.

Non-secrets that look like secrets: a KV namespace id, an account id and a
project name are identifiers, not credentials. They are useless without a token
and belong in `wrangler.toml` where deployments can find them.

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
| `export-for-web.js` | canonical → the small payloads the web reads, size-capped |
| `upload-web-export.js` | pushes those payloads into Cloudflare KV |
| `functions/api/auction/*` | the API every screen goes through, at auction-view.pages.dev |
| `public/` | admin progress dashboard, plus a reference search page |

Tests: `npm run test:guard`, `test:gate`, `test:priority`, `test:export`,
`test:api`, and `npm run simulate` for a dry run over canonical.

## Conventions

- The laptop never pushes canonical; it publishes `data/worker-deltas/laptop/*.json`
  only. Cloud master is the sole writer of `data/auctions.json`.
- Docker image `data/` is a build-time snapshot and is never the source of truth;
  the master job clones GitHub fresh every run.
- GitHub Actions workflows are `workflow_dispatch` only. No cron — it cost money.
- PATs and API tokens live in Secret Manager, never in the image, source or repo.
- No screen fetches `data/auctions.json`; it is 21MB. Everything reads the API.
- Dates that matter are KST. A UTC date is a day behind for most of the Korean
  working day and moves the expiry boundary by one.
