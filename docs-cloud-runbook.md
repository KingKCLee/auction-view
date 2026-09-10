# Cloud master runbook

## What runs where

- **Laptop** (`scripts/laptop-collector.ps1`): court-facing detail collection only.
  Publishes `data/worker-deltas/laptop/*.json`. Never pushes canonical.
- **Cloud Run Job** (`cloud-master-once.js`): the only writer of canonical. One shot
  per execution: clone GitHub latest -> apply deltas -> metrics -> merge guard ->
  recount stats coverage -> refresh `docs/data` -> commit -> pull --rebase -> push.
- **GitHub**: repository and data exchange. All Actions workflows are
  `workflow_dispatch` only; there is no cron.

## Merge guard

`merge-guard-lib.js` snapshots `itemCount`, `documentCount`, `photoCount`,
`eventCount`, `winningCount` and all 12 coverage counters before and after the
merge. Any decrease aborts with exit 3: canonical and the delta files are restored
and nothing is pushed. `MERGE_GUARD_TOLERANCE` (default 0) relaxes the threshold.

Verify with `npm run test:guard` - it runs the real one-shot against a throwaway
bare repo and requires both deliberate-failure cases to fail.

## Exit codes

| code | meaning |
|---|---|
| 0 | merged and pushed (or nothing to do) |
| 1 | unexpected error |
| 3 | merge guard failed - canonical would shrink, nothing pushed |
| 4 | rebase onto origin failed - conflict left alone, nothing pushed |
| 5 | work tree dirty after commit - nothing pushed |
| 6 | no usable GitHub credential - nothing pushed (see below) |
| 7 | push rejected as non-fast-forward after every retry - nothing pushed |

## "could not read Username for https://github.com"

This is not a git problem. The repository is public, so a run without a
credential clones, merges, commits and rebases perfectly and fails only on the
last line. Measured 2026-09-10: the message means `GITHUB_TOKEN` / `GH_PAT` /
`GITHUB_TOKEN_FILE` reached the container **empty or not at all** - the secret is
no longer bound to the job, its version was disabled, or the service account lost
`secretmanager.secretAccessor`.

An **expired or revoked** PAT looks different: `remote: Invalid username or
token` or `remote: Permission to KingKCLee/auction-view.git denied`. Read the
error text before rotating anything - rotating a healthy PAT does not fix an
unbound secret.

Since 2026-09-10 the job refuses to start a merge it cannot publish: with no
credential it prints the missing variable names and exits 6 immediately, instead
of doing 900 seconds of work and dying on the push.

Order to check, cheapest first:

1. `gcloud run jobs describe auction-cloud-master --region asia-northeast1` - is
   `GITHUB_TOKEN` still listed with a `secretKeyRef`?
2. `gcloud secrets versions list github-pat` - is the newest version `ENABLED`?
3. `gcloud secrets get-iam-policy github-pat` - does the job's service account
   still hold `roles/secretmanager.secretAccessor`?
4. Only then, rotate the PAT.

## Two writers, one branch

The laptop, the GitHub Actions workflows and this job all push to `main`. A
commit landing between this job's `pull --rebase` and its `push` makes the push
non-fast-forward. That is a race, not a fault, so the push is retried after
another rebase - `PUSH_ATTEMPTS` (default 3) - and only then gives up with exit
7. A credential failure is never retried; it cannot improve on a second try.

## Build and deploy

```bash
gcloud config set project auction-view
gcloud builds submit --tag asia-northeast1-docker.pkg.dev/auction-view/auction-view/auction-cloud:latest
```

Probe (does Cloud egress reach the court site at all):

```bash
gcloud run jobs create auction-cloud-probe \
  --image asia-northeast1-docker.pkg.dev/auction-view/auction-view/auction-cloud:latest \
  --region asia-northeast1 --tasks 1 --max-retries 0 --task-timeout 300s \
  --cpu 1 --memory 512Mi --set-env-vars CLOUD_JOB_MODE=probe
gcloud run jobs execute auction-cloud-probe --region asia-northeast1 --wait
```

Master merge job (needs the PAT secret below):

```bash
gcloud run jobs create auction-cloud-master \
  --image asia-northeast1-docker.pkg.dev/auction-view/auction-view/auction-cloud:latest \
  --region asia-northeast1 --tasks 1 --max-retries 0 --task-timeout 900s \
  --cpu 1 --memory 2Gi \
  --set-env-vars CLOUD_JOB_MODE=master-once,CLOUD_WORK_DIR=/tmp/auction-master \
  --set-secrets GITHUB_TOKEN=github-pat:latest
gcloud run jobs execute auction-cloud-master --region asia-northeast1 --wait
```

## PAT

Fine-grained PAT, `KingKCLee/auction-view` only, **Contents: Read and write** only.
Never commit it; it only ever reaches the job through Secret Manager.

```bash
printf '%s' '<PAT>' | gcloud secrets create github-pat --data-file=- --replication-policy=automatic
gcloud secrets add-iam-policy-binding github-pat \
  --member="serviceAccount:550968262931-compute@developer.gserviceaccount.com" \
  --role="roles/secretmanager.secretAccessor"
```

`cloud-master-once.js` reads `GITHUB_TOKEN`, `GH_PAT` or `GITHUB_TOKEN_FILE` and
redacts the value from every line it logs.

## Scheduler (only after the master job exists)

The laptop publishes a delta roughly every 4 minutes, so 30 minutes is ample and
stays inside the Cloud Scheduler free tier (3 jobs).

```bash
gcloud iam service-accounts create auction-scheduler \
  --display-name="Cloud Scheduler -> auction-cloud-master"

gcloud run jobs add-iam-policy-binding auction-cloud-master \
  --region asia-northeast1 \
  --member="serviceAccount:auction-scheduler@auction-view.iam.gserviceaccount.com" \
  --role="roles/run.invoker"

gcloud scheduler jobs create http auction-cloud-master-30m \
  --location asia-northeast1 \
  --schedule "*/30 * * * *" \
  --time-zone "Asia/Seoul" \
  --uri "https://asia-northeast1-run.googleapis.com/apis/run.googleapis.com/v1/namespaces/auction-view/jobs/auction-cloud-master:run" \
  --http-method POST \
  --oauth-service-account-email auction-scheduler@auction-view.iam.gserviceaccount.com
```

`gcloud run jobs add-iam-policy-binding` fails if `auction-cloud-master` does not
exist yet, so create and execute the job successfully before running any of this.

---

# Web API (the only contact point for any front end)

Nothing client-side may read `data/auctions.json`. It is 21MB and a phone will
stall or fail on it. Every screen — the ZibTok auction tab, the public search
page here, the admin dashboard — goes through this API.

## Shape of the data

`export-for-web.js` turns canonical into small objects and `upload-web-export.js`
puts them in a Cloudflare KV namespace bound as `AUCTION_KV`:

| key | what | size today |
|---|---|---|
| `index:v1` | gzipped positional array of every card row + facets | 260KB |
| `region:v1:<시도>` | same, one region only | 5–49KB |
| `facets:v1` | 시/도, 시군구, 용도 lists | small |
| `detail:v1:<id>` | one case, full record | ≤13KB |
| `stats:v1` | progress numbers | ~1KB |

`id` is the canonical row id, `"<courtCode>|<caseNumber>|<itemNumber>"`, so it
must be percent-encoded in a URL.

Nothing may exceed **512,000 bytes**. The exporter refuses to write an oversized
object (exit 7), the uploader refuses to publish one (exit 7), and each endpoint
refuses to return one (HTTP 500). The exporter also refuses to publish a canonical
that looks mid-cycle truncated (exit 8).

## Endpoints

Base URL: `https://<project>.pages.dev/api/auction`

### `GET /list`
Query: `sido`, `sigungu`, `usage`, `minPrice`, `maxPrice` (won, against 최저가),
`saleDateFrom`, `saleDateTo`, `hasWinning=1|0`, `q` (사건번호·소재지 substring),
`sort=saleDate|minimumPrice|appraisedPrice|failedCount`, `order=asc|desc`,
`page` (1-based), `size` (default 20, max 100).

```json
{
  "generatedAt": "2026-09-09T02:00:00.000Z",
  "page": 1, "size": 20, "total": 8279, "totalPages": 414,
  "facets": { "sido": ["서울특별시"], "sigungu": {"서울특별시": ["관악구"]}, "usage": ["아파트"] },
  "items": [{
    "id": "B000210|2026타경93|1", "caseNumber": "2026타경93",
    "courtName": "서울중앙지방법원", "address": "서울특별시 관악구 신림동 1655-15",
    "sido": "서울특별시", "sigungu": "관악구", "usage": "아파트",
    "appraisedPrice": 79000000, "minimumPrice": 55300000,
    "saleDate": "2026-09-09", "failedCount": 1,
    "hasWinning": 0, "photoCount": 0, "documentCount": 2
  }]
}
```

Card `address` is trimmed at the `[상세내역]` marker and capped at 120 characters;
the full text is on the detail record.

### `GET /:id`
Percent-encoded id. Returns the full case: prices, 기일 내역 (`events`), 낙찰가
(`winningPrice`, `winningDate`, `winningRatio`, `bidderCount`), documents, photos,
`coverage`, and `status` (`expired` once the source has dropped the case).
404 when the id is unknown.

### `GET /stats`
`itemCount`, per-asset `coverage` counts and percentages, `winningPriceCaptured`,
`atRiskToday`, `permanentlyLost`, `expiredMarked`, `lastCloudMergeAt`,
`lastLaptopRunAt`, `lastLaptopRun`.

### `GET /facets`
Just the filter options, for building dropdowns without fetching a list page.

All responses send `access-control-allow-origin: *`, so ZibTok can call them
directly from the browser.

## Deploying

```bash
npx wrangler kv namespace create AUCTION_KV     # paste the id into wrangler.toml
npx wrangler pages project create auction-view --production-branch main
npm run export:web
CLOUDFLARE_ACCOUNT_ID=... CLOUDFLARE_API_TOKEN=... CLOUDFLARE_KV_NAMESPACE_ID=... npm run upload:web
npx wrangler pages deploy public --project-name auction-view
```

The Cloud Run master job runs `export-for-web.js` after each successful push and
`upload-web-export.js` when `CLOUDFLARE_ACCOUNT_ID`, `CLOUDFLARE_API_TOKEN` and
`CLOUDFLARE_KV_NAMESPACE_ID` are present; without them it exports and says so.

The API token needs **Workers KV Storage: Edit** and **Cloudflare Pages: Edit** on
this account only. Put it in Secret Manager next to the GitHub PAT, never in the
repo.

## Pages bundled here

- `/` — public search: 지역·용도·가격대 filters, card list, case detail dialog.
- `/admin` — progress dashboard: coverage bars, today's winning-price capture,
  at-risk count, last merge and last laptop run.

Both call the API only. Neither fetches canonical.
