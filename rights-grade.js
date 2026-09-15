// 매각물건명세서 원문 → 3등급(안전·주의·위험) 자동 판정.
//
// ★이것은 **참고 정보**이고 법률자문이 아니다. 화면이 그렇게 적어야 하고, 이 파일은
//   등급과 함께 **근거 문장 원문**을 반드시 돌려준다 - 사람이 즉시 반증할 수 있어야 한다.
//
// 설계 원칙 셋 (2026-09-16):
//  ① **모르면 안전으로 내리지 않는다.** 판정은 비대칭이다 - 근거가 없으면 등급을 올리는
//     쪽(주의/위험)으로 기울인다. "위험한데 안전이라 적는 것"이 그 반대보다 훨씬 나쁘다.
//  ② **사전은 상상하지 않는다.** 아래 신호는 2026-09-16 canonical 356건 전수에서 실제로
//     나온 말만 넣었다(유치권 1 · 법정지상권 13 · 분묘기지권 8 · 대항력 5 · 인수 23 ·
//     전세권 4 · 지상권 19 · 별도등기 3 · 임차권등기 18 · 불분명 29).
//  ③ **자동화되지 않는 것은 자동화하지 않는다.** 유치권 진위·점유 현황·명도 난이도는
//     문서로 가릴 수 없다 - 「현장 확인 필요」로 내보내고 판단을 대신하지 않는다.

const GRADES = { SAFE: '안전', CAUTION: '주의', DANGER: '위험' };

/* 날짜 한 개. "2022.11.7." · "2022. 8. 25." · "2015-09-10" 전부 같은 것으로 읽는다.
   실측: seniorMortgage 가 있는 328건 전부 이 하나로 파싱된다. */
const DATE_RE = /(\d{4})\s*[.\-]\s*(\d{1,2})\s*[.\-]\s*(\d{1,2})/;

function parseDate(text) {
  const m = String(text || '').match(DATE_RE);
  if (!m) return null;
  const y = Number(m[1]), mo = Number(m[2]), d = Number(m[3]);
  if (!(y >= 1900 && y <= 2100 && mo >= 1 && mo <= 12 && d >= 1 && d <= 31)) return null;
  return `${y}-${String(mo).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
}

/**
 * 말소기준권리 - 날짜와 종류.
 *
 * 실측 종류 분포: 근저당권 184 · 근저당 31 · 가압류 23 · 강제경매개시결정 22 ·
 * 경매개시결정 19 · 압류 16 · 저당권 14 · 전세권 3.
 * ★전세권이 기준으로 적힌 경우가 실제로 있다 - 전세권은 배당요구 여부에 따라
 *   말소기준이 되기도, 인수되기도 한다. 그래서 전세권이 기준이면 **안전으로 내리지 않는다.**
 */
function baseRight(rights) {
  const raw = String((rights && rights.seniorMortgage) || '').trim();
  if (!raw) return null;
  const date = parseDate(raw);
  const kind = raw.replace(DATE_RE, '').replace(/[.\s]/g, '') || null;
  return { raw, date, kind };
}

/*
 * 위험 신호 사전. 각 줄은 [정규식, 등급, 사람에게 보여 줄 이름, 왜].
 * ★여기 없는 말이 나오면 잡히지 않는다 - 그래서 아래 `unknownRisk` 가 "불분명"·"인수"
 *   같은 **포괄어**를 따로 본다. 사전이 못 따라잡은 자리를 그물로 받는다.
 */
const SIGNALS = [
  [/유치권/, GRADES.DANGER, '유치권',
    '유치권이 성립하면 낙찰자가 그 채권을 물어 주기 전에는 인도받지 못할 수 있습니다.'],
  [/매수인이\s*인수|인수함|인수하여야|말소되지\s*않고/, GRADES.DANGER, '인수되는 권리',
    '낙찰가와 별도로 낙찰자가 떠안는 부담입니다.'],
  [/임차권등기/, GRADES.DANGER, '임차권등기',
    '배당에서 보증금이 전액 변제되지 않으면 잔액을 낙찰자가 인수할 수 있습니다.'],
  [/법정지상권/, GRADES.CAUTION, '법정지상권',
    '토지만 낙찰받는 경우 건물을 철거하지 못할 수 있습니다.'],
  [/분묘기지권/, GRADES.CAUTION, '분묘기지권',
    '분묘를 함부로 옮길 수 없어 토지 이용이 제한될 수 있습니다.'],
  [/대항력/, GRADES.CAUTION, '대항력 임차인 언급',
    '임차인이 대항력을 갖추면 보증금을 낙찰자가 떠안을 수 있습니다.'],
  [/별도등기/, GRADES.CAUTION, '별도등기',
    '대지권에 별도의 권리가 남아 있을 수 있습니다.'],
  [/(선순위|을구).{0,12}전세권|전세권.{0,12}(인수|존속)/, GRADES.CAUTION, '전세권',
    '배당요구 여부에 따라 인수될 수 있습니다.'],
  [/가등기|가처분|예고등기/, GRADES.CAUTION, '가등기·가처분',
    '소유권이 뒤집히거나 처분이 제한될 수 있습니다.'],
  [/농지취득자격증명|농취증/, GRADES.CAUTION, '농지취득자격증명 필요',
    '기한 내 제출하지 못하면 입찰보증금을 몰수당합니다.'],
  [/제시외/, GRADES.CAUTION, '제시외 물건',
    '매각에서 빠지는 건물·시설이 있어 이용에 제약이 생길 수 있습니다.'],
  /* [2026-09-16 2차] 첫 판이 「안전」으로 내보낸 164건의 원문을 다시 읽어 찾은 것들.
     사람이 표본을 직접 보고서야 드러났다 - 사전은 한 번에 완성되지 않는다. */
  [/위반건축물|무단\s*증축|불법\s*증축/, GRADES.CAUTION, '위반건축물',
    '시정명령·이행강제금 대상이 될 수 있고 대출이 제한될 수 있습니다.'],
  [/공유지분|지분\s*매각|지분\s*경매|지분\s*\d+분의/, GRADES.CAUTION, '지분 매각',
    '물건 전체가 아니라 지분만 사는 것이라 공유자와의 협의·분할이 필요할 수 있습니다.'],
  [/맹지/, GRADES.CAUTION, '맹지',
    '도로에 접하지 않아 진입로 확보가 별도로 필요할 수 있습니다.'],
  [/체납/, GRADES.CAUTION, '체납',
    '관리비·공과금 체납분을 낙찰자가 떠안게 되는 경우가 있습니다.'],
  [/철거/, GRADES.CAUTION, '철거 관련 기재',
    '철거 대상이거나 철거 의무가 따라올 수 있습니다.'],
  [/분묘|묘\s*\d+\s*기|묘가\s*(존재|소재)/, GRADES.CAUTION, '분묘',
    '분묘를 함부로 옮길 수 없어 토지 이용이 제한될 수 있습니다.'],
];

/* 사전이 못 집은 자리를 받는 그물. 뜻을 단정하지 않고 "확인이 필요하다"고만 말한다. */
const VAGUE = [
  [/불분명|성립\s*여부/, '성립 여부 불분명', '법원이 스스로 불분명하다고 적은 항목입니다.'],
  [/미상|알\s*수\s*없/, '확인되지 않은 항목', '법원 문서에 확인되지 않았다고 적혀 있습니다.'],
];

/** 사람이 볼 근거 문장. 너무 길면 자르되 신호 주변을 남긴다. */
function quote(text, re, span = 90) {
  const s = String(text || '').replace(/\s+/g, ' ').trim();
  const m = s.match(re);
  if (!m) return s.slice(0, span);
  const at = Math.max(0, s.indexOf(m[0]) - Math.floor(span / 3));
  return (at > 0 ? '…' : '') + s.slice(at, at + span) + (at + span < s.length ? '…' : '');
}

/*
 * 완화 사유. 채권자가 대항력을 포기하거나 임차권등기 말소에 동의한 경우가 실제로 있다
 * (실측 14건, 그중 11건이 위험 등급). ★그렇다고 **등급을 낮추지 않는다** - 포기의
 * 효력 범위는 문서 한 줄로 단정할 수 없고, 낮추는 방향의 오판은 되돌릴 수 없다.
 * 사실만 덧붙여 사람이 직접 읽고 판단하게 한다.
 */
const MITIGATIONS = [
  [/포기/, '포기 조건 기재'],
  [/말소\s*동의|말소하는\s*것을\s*조건|말소를\s*조건/, '말소 조건 기재'],
];

const worse = (a, b) => {
  const rank = { [GRADES.SAFE]: 0, [GRADES.CAUTION]: 1, [GRADES.DANGER]: 2 };
  return rank[b] > rank[a] ? b : a;
};

/**
 * 등급을 매긴다.
 *
 * @param {object} row canonical 한 건 (rights · lessees · occupancy · saleDate 를 본다)
 * @returns {object|null} 명세서가 아직 없으면 null - 등급을 만들지 않는다.
 */
function gradeRights(row) {
  const rights = row && row.rights;
  const hasAny = rights && (rights.assumedRights || rights.surfaceRight || rights.seniorMortgage
    || rights.statementNote || rights.goodsNote);
  if (!hasAny) return null;

  const fields = [
    ['인수되는 권리', rights.assumedRights],
    ['지상권', rights.surfaceRight],
    ['명세서 비고', rights.statementNote],
    ['물건 비고', rights.goodsNote],
  ].filter(([, v]) => v);

  const findings = [];
  let grade = GRADES.SAFE;

  for (const [where, textRaw] of fields) {
    const text = String(textRaw);
    /* "해당사항없음" 한 줄만 있는 칸은 신호가 아니다 - 법원이 없다고 적은 것이다. */
    if (/^\s*해당\s*사항\s*없음\s*$/.test(text.replace(/\s+/g, ' '))) continue;
    for (const [re, g, name, why] of SIGNALS) {
      if (!re.test(text)) continue;
      findings.push({ name, grade: g, where, why, quote: quote(text, re) });
      grade = worse(grade, g);
    }
    for (const [re, name, why] of VAGUE) {
      if (!re.test(text)) continue;
      findings.push({ name, grade: GRADES.CAUTION, where, why, quote: quote(text, re) });
      grade = worse(grade, GRADES.CAUTION);
    }
  }

  /* 같은 문장이 명세서 비고와 물건 비고에 함께 실려 오는 일이 잦다(실측 63건에서
     같은 근거가 두 번 이상 나왔다). 화면에 같은 말을 여러 번 적지 않는다.
     ★같은 위험이 명세서 비고와 물건 비고에 다른 문장으로 두 번 잡히는 일이 잦다 -
     화면에는 **위험 종류당 한 줄**만 낸다(근거는 처음 것을 남기고 몇 군데에서 나왔는지만 센다). */
  const byName = new Map();
  for (const f of findings) {
    const prev = byName.get(f.name);
    if (!prev) { byName.set(f.name, { ...f, seenIn: 1 }); continue; }
    prev.seenIn += 1;
    if (!prev.where.includes(f.where)) prev.where += ', ' + f.where;
  }
  const deduped = [...byName.values()];
  findings.length = 0;
  findings.push(...deduped);

  /* 완화 사유는 등급과 따로 모은다 - 등급을 건드리지 않는다. */
  const mitigations = [];
  for (const [where, textRaw] of fields) {
    for (const [re, name] of MITIGATIONS) {
      if (!re.test(String(textRaw))) continue;
      const q = quote(String(textRaw), re);
      if (mitigations.some((m) => m.name === name)) continue;
      mitigations.push({ name, where, quote: q });
    }
  }

  const base = baseRight(rights);

  /*
   * 대항력 판정 - 전입일이 말소기준일보다 빠른 임차인.
   * ★날짜가 둘 다 있을 때만 판정한다. 하나라도 없으면 **모른다고 적고 등급을 올린다**
   *   (안전으로 내리지 않는다 - 원칙 ①).
   */
  const lessees = Array.isArray(row.lessees) ? row.lessees : [];
  const senior = [];
  let lesseeUnknown = false;
  for (const x of lessees) {
    const inDate = parseDate(x && x.moveInDate);
    if (!inDate || !base || !base.date) { lesseeUnknown = true; continue; }
    if (inDate < base.date) senior.push({ name: x.name || '', moveInDate: inDate, deposit: x.deposit ?? null });
  }
  if (senior.length) {
    findings.push({
      name: '말소기준보다 앞선 임차인', grade: GRADES.DANGER, where: '현황조사서',
      why: '전입일이 말소기준권리보다 빨라 보증금을 낙찰자가 인수할 수 있습니다.',
      quote: senior.map((x) => `${x.name} 전입 ${x.moveInDate}`).join(' · '),
    });
    grade = GRADES.DANGER;
  } else if (lessees.length && lesseeUnknown) {
    findings.push({
      name: '임차인 전입일 확인 불가', grade: GRADES.CAUTION, where: '현황조사서',
      why: '전입일 또는 말소기준일이 없어 대항력을 가릴 수 없습니다.',
      quote: `임차인 ${lessees.length}명`,
    });
    grade = worse(grade, GRADES.CAUTION);
  }

  /* 말소기준이 전세권이면 안전으로 내리지 않는다 - 배당요구 여부로 갈린다. */
  if (base && base.kind && /전세권/.test(base.kind)) {
    findings.push({
      name: '말소기준이 전세권', grade: GRADES.CAUTION, where: '기준 등기',
      why: '전세권은 배당요구 여부에 따라 인수될 수도 있습니다.', quote: base.raw,
    });
    grade = worse(grade, GRADES.CAUTION);
  }

  /* 기준 등기 자체가 없으면 무엇이 지워지고 무엇이 남는지 가릴 수 없다. */
  if (!base || !base.date) {
    findings.push({
      name: '말소기준권리 확인 불가', grade: GRADES.CAUTION, where: '기준 등기',
      why: '기준 등기가 적혀 있지 않아 어떤 권리가 소멸하는지 가릴 수 없습니다.',
      quote: base ? base.raw : '(없음)',
    });
    grade = worse(grade, GRADES.CAUTION);
  }

  return {
    grade,
    baseRight: base ? { date: base.date, kind: base.kind, raw: base.raw } : null,
    findings,
    /* 등급을 낮추지 않은 채로 함께 보여 줄 완화 사유. 화면이 '다만 …' 으로 적는다. */
    mitigations,
    /* 문서로 가릴 수 없는 것 - 판단을 대신하지 않는다. */
    fieldCheck: ['유치권 진위', '실제 점유 현황', '명도 난이도'],
    notice: '법원 매각물건명세서를 기계로 읽어 만든 참고 정보이며 법률자문이 아닙니다. 입찰 전 원문과 등기부를 직접 확인하십시오.',
    statementWrittenAt: (rights && rights.writtenAt) || null,
  };
}

module.exports = { gradeRights, baseRight, parseDate, GRADES, SIGNALS };
