// 당사자내역(채권자·채무자·소유자 등) · 관련사건 · 입찰기간.
//
// ★어디서 오나 (2026-09-16 실측): 사건 상세(pgj15B)가 아니라 **사건 기본조회(pgj15A)**의
//   `dlt_rletCsIntrpsLst` 다. 상세 화면 정의(PGJ151F00.xml, 13,925바이트)의 엔드포인트
//   3개를 전부 확인했는데 당사자 계열 단어가 한 번도 안 나왔고, 그래서 「당사자내역
//   미수집」이라고 보고했었다. 틀렸다 - **화면이 다를 뿐 API 는 있었다.**
//
// ★개인정보: 법원이 **이미 마스킹해서 준다**("주OOOOOOO", "임OO"). 우리가 다시
//   가릴 필요가 없고, 가리려다 오히려 원문을 훼손할 이유도 없다. 다만 **마스킹되지
//   않은 값이 오면 저장하지 않는다** - 원천이 바뀌었을 때 개인정보가 새는 자리가
//   여기이기 때문이다(임차인 enrrno 사고와 같은 계열).
//
// ★구분명은 코드표를 추측하지 않는다. 응답이 `auctnIntrpsDvsNm` 로 한글을 함께 준다
//   (실측: 채권자 · 채무자겸소유자 · 교부권자 · 배당요구권자 · 주택임차권자 · 임차권자).

const txt = (v) => String(v == null ? '' : v).replace(/\s+/g, ' ').trim();

/**
 * 법원이 가려서 준 이름인가.
 *
 * 실측 형태: "주OOOOOOO" · "임OO" · "주OOO OOOO" · "주OOOOOOO(OOOOOOOOOO OOOO)".
 * 가림 문자는 전각 O(U+004F 반복)다. 하나도 없으면 **가리지 않은 실명일 수 있으므로
 * 저장하지 않는다** - 판단이 서지 않으면 안 싣는 쪽을 고른다.
 */
function looksMasked(name) {
  const s = txt(name);
  if (!s) return false;
  if (/O{2,}/.test(s)) return true;
  /* 한 글자짜리 법인·개인은 가릴 것이 없다 - 그건 통과시킨다. */
  return s.replace(/[()\s]/g, '').length <= 1;
}

/** 당사자내역. 가려지지 않은 이름은 통째로 뺀다. */
function parties(res) {
  const list = Array.isArray(res && res.dlt_rletCsIntrpsLst) ? res.dlt_rletCsIntrpsLst : [];
  const out = [];
  let dropped = 0;
  for (const x of list) {
    const role = txt(x && x.auctnIntrpsDvsNm);
    const name = txt(x && x.intrpsNm);
    if (!role && !name) continue;
    if (name && !looksMasked(name)) { dropped += 1; continue; }
    out.push({ role: role || null, name: name || null, seq: Number(x.intrpsSeq) || null });
  }
  return { list: out, dropped };
}

/**
 * 관련사건. 사건번호 문자열에서 「(중복)」을 긁던 것보다 정확하다 -
 * 다른 법원의 지급명령까지 온다(실측: 대전지방법원 2025차전29170 지급명령).
 */
function relatedCasesFromApi(res) {
  const list = Array.isArray(res && res.dlt_rletReltCsLst) ? res.dlt_rletReltCsLst : [];
  return list.map((x) => ({
    caseNumber: txt(x && x.userReltCsNo) || null,
    relation: txt(x && x.reltCsDvsNm) || null,
    court: txt(x && (x.cortOfcNm || x.cortSptNm)) || null,
  })).filter((x) => x.caseNumber);
}

const ymd = (v) => {
  const s = txt(v).replace(/[^0-9]/g, '');
  return /^\d{8}$/.test(s) ? `${s.slice(0, 4)}-${s.slice(4, 6)}-${s.slice(6, 8)}` : null;
};

/**
 * 입찰방법.
 *
 * ★`bidDvsCd` 의 뜻은 아직 모른다(실측 "000331"). 코드는 그대로 남기고, **입찰기간이
 *   실제로 있으면** 기간입찰로 적는다. 기간이 없다고 기일입찰이라 단정하지 않는다 -
 *   그 대응이 확인되기 전까지는 미확인이다.
 * 기간은 두 자리에서 온다: 물건 레벨(bidBgngYmd/bidEndYmd)과 기일 레벨(ipgiganFday/Tday).
 */
function bidInfo(res) {
  const g = (Array.isArray(res && res.dlt_dspslGdsDspslObjctLst) ? res.dlt_dspslGdsDspslObjctLst : [])[0] || {};
  const dx = Array.isArray(res && res.dlt_rletCsGdsDtsDxdyInf) ? res.dlt_rletCsGdsDtsDxdyInf : [];
  const from = ymd(g.bidBgngYmd) || dx.map((x) => ymd(x.ipgiganFday)).find(Boolean) || null;
  const to = ymd(g.bidEndYmd) || dx.map((x) => ymd(x.ipgiganTday)).find(Boolean) || null;
  return {
    code: txt(g.bidDvsCd) || null,
    method: (from || to) ? '기간입찰' : null,
    periodFrom: from,
    periodTo: to,
    noticeFrom: ymd(g.pstgBgngYmd),
    noticeTo: ymd(g.pstgEndYmd),
  };
}

/** 한 응답에서 셋을 다 꺼낸다. 아무것도 없으면 null. */
function extractCaseExtras(json) {
  const res = (json && json.data) || json;
  if (!res) return null;
  const p = parties(res);
  const rel = relatedCasesFromApi(res);
  const bid = bidInfo(res);
  if (!p.list.length && !rel.length && !bid.code && !bid.periodFrom) return null;
  return { parties: p.list, partiesDropped: p.dropped, relatedCasesApi: rel, bid };
}

module.exports = { extractCaseExtras, parties, relatedCasesFromApi, bidInfo, looksMasked };
