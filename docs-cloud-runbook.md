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
