const { chromium } = require('playwright');

const BASE = 'https://www.courtauction.go.kr';
const PATHS = {
  notices: '/pgj/pgj143/selectRletDspslPbanc.on',
  noticeDetail: '/pgj/pgj143/selectRletDspslPbancDtl.on',
  caseDetail: '/pgj/pgj15A/selectAuctnCsSrchRslt.on',
  propertySearch: '/pgj/pgjsearch/searchControllerMain.on',
  courts: '/pgj/pgjComm/selectCortOfcCdLst.on'
};
const WARM = {
  notices: '/pgj/index.on?w2xPath=/pgj/ui/pgj100/PGJ143M01.xml&pgjId=143M01',
  noticeDetail: '/pgj/index.on?w2xPath=/pgj/ui/pgj100/PGJ143M01.xml&pgjId=143M01',
  caseDetail: '/pgj/index.on?w2xPath=/pgj/ui/pgj100/PGJ159M00.xml&pgjId=159M00',
  propertySearch: '/pgj/index.on?w2xPath=/pgj/ui/pgj100/PGJ151F00.xml&pgjId=151F00',
  courts: '/pgj/index.on?w2xPath=/pgj/ui/pgj100/PGJ143M01.xml&pgjId=143M01'
};
const SUBMISSION = { propertySearch: 'mf_wfm_mainFrame_sbm_selectGdsDtlSrch' };
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/152.0.0.0 Safari/537.36';

class CourtBrowserFallbackClient {
  constructor(options={}) {
    this.timeoutMs = Number(options.timeoutMs || 25000);
    this.browser = null;
    this.context = null;
    this.page = null;
    this.warmed = null;
  }

  async ensureBrowser() {
    if (this.page) return;
    this.browser = await chromium.launch({ headless: true });
    this.context = await this.browser.newContext({
      userAgent: UA,
      locale: 'ko-KR',
      timezoneId: 'Asia/Seoul',
      viewport: { width: 1280, height: 900 }
    });
    this.page = await this.context.newPage();
  }

  async warmup(endpointKey) {
    const target = WARM[endpointKey] || WARM.notices;
    if (this.warmed === target) return;
    await this.ensureBrowser();

    // The court page can keep loading resources indefinitely on cloud runners.
    // We only need a committed same-origin document and its cookies, not full DOM readiness.
    try {
      await this.page.goto(BASE + '/', { waitUntil: 'commit', timeout: 12000 });
    } catch (_) {}

    try {
      await this.page.goto(BASE + target, { waitUntil: 'commit', timeout: this.timeoutMs });
    } catch (e) {
      const url = String(this.page.url() || '');
      if (!url.startsWith(BASE)) {
        const err = new Error(`browser warmup failed: ${e.message || e}`);
        err.code = 'NETWORK_ERROR';
        throw err;
      }
    }
    await this.page.waitForTimeout(700);
    this.warmed = target;
  }

  async postJson(endpointKey, body) {
    const path = PATHS[endpointKey];
    if (!path) throw new Error(`unknown court endpoint ${endpointKey}`);
    await this.warmup(endpointKey);
    const submissionid = SUBMISSION[endpointKey] || '';
    let response;
    try {
      response = await this.page.evaluate(async ({url,payload,submissionid}) => {
        const headers = {
          'Content-Type': 'application/json;charset=UTF-8',
          'Accept': 'application/json,text/plain,*/*',
          'sc-userid': 'SYSTEM'
        };
        if (submissionid) headers.submissionid = submissionid;
        const r = await fetch(url, {
          method: 'POST',
          credentials: 'same-origin',
          headers,
          body: payload
        });
        return { status: r.status, text: await r.text() };
      }, { url: BASE + path, payload: JSON.stringify(body || {}), submissionid });
    } catch (e) {
      const err = new Error(`browser fetch failed for ${path}: ${e.message || e}`);
      err.code = 'NETWORK_ERROR';
      throw err;
    }

    let json;
    try { json = JSON.parse(response.text); }
    catch (_) {
      const err = new Error(`browser non-json ${response.status} for ${path}`);
      err.code = 'UPSTREAM_ERROR';
      err.statusCode = response.status;
      throw err;
    }
    if (json?.data?.ipcheck === false) {
      const err = new Error('Court Auction site blocked this browser session');
      err.code = 'BLOCKED';
      throw err;
    }
    if (response.status >= 400 || json?.errors) {
      const msg = json?.errors?.errorMessage || `HTTP ${response.status}`;
      const err = new Error(`Court Auction browser request failed for ${path}: ${msg}`);
      err.code = 'UPSTREAM_ERROR';
      err.statusCode = response.status;
      throw err;
    }
    return json;
  }

  async close() {
    try { if (this.context) await this.context.close(); } catch (_) {}
    try { if (this.browser) await this.browser.close(); } catch (_) {}
    this.browser = null;
    this.context = null;
    this.page = null;
    this.warmed = null;
  }
}

module.exports = { CourtBrowserFallbackClient };
