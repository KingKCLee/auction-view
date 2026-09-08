const MEANINGFUL_KEYS = new Set([
  'caseType','usage','buildingName','events','eventCount','minimumPrice','saleDate','failedCount',
  'winningPrice','winningDate','winningRatio','status','coverage','appraisalSummary','appraisalDate',
  'appraisalAgency','claimAmount','components','address','landArea','buildingArea','saleStatementAvailable',
  'statusReportAvailable','documents','documentCount'
]);

const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);

function buildPatch(before, after) {
  const set = {};
  for (const key of MEANINGFUL_KEYS) {
    if (!same(before?.[key], after?.[key])) set[key] = after?.[key] ?? null;
  }
  return Object.keys(set).length ? { id: after.id, set } : null;
}

function applyPatch(row, patch) {
  for (const [key, value] of Object.entries(patch?.set || {})) {
    if (key === 'coverage' && row.coverage && value && typeof value === 'object') {
      row.coverage = { ...row.coverage, ...value };
    } else {
      row[key] = value;
    }
  }
  return row;
}

module.exports = { MEANINGFUL_KEYS, buildPatch, applyPatch };
