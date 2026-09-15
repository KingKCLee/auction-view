// 권리관계 등급기 게이트.
//
// R1(측정기 부정 테스트): 등급기가 내는 "안전"을 근거로 쓰기 전에, **위험 신호가
// 원문에 있는데 안전이 나오는** 상황을 고의로 만들어 fail 이 찍히는지 먼저 본다.
//
// 재는 축 넷:
//   ⓐ 역주입 — 알려진 위험 문장을 넣으면 반드시 안전보다 높은 등급이 나오는가
//   ⓑ 전수 — canonical 의 모든 rights 에 대해, 원문에 위험어가 있는데 등급이
//      「안전」인 건이 **0건**인가 (이것이 이 게이트의 존재 이유다)
//   ⓒ 근거 — 안전이 아닌 모든 판정에 근거 문장(quote)이 붙어 있는가
//   ⓓ 고지 — 모든 결과에 「법률자문 아님」 문구와 「현장 확인 필요」 목록이 있는가
//
//   node check-rights-grade.js            (canonical 전수)
//   node check-rights-grade.js --selftest (역주입만)

const fs = require('fs');
const path = require('path');
const { gradeRights, GRADES } = require('./rights-grade');

const DATA = process.env.AUCTIONS_FILE || path.join(__dirname, 'data', 'auctions.json');

/* 원문에 이 말이 있으면 「안전」일 수 없다. 사전과 따로 적어 둔다 - 사전을 고치다
   실수로 느슨해지면 이 목록이 잡는다(측정기와 피측정기를 분리한다). */
const NEVER_SAFE = /유치권|법정지상권|분묘기지권|대항력|인수함|매수인이\s*인수|말소되지\s*않고|임차권등기|가등기|가처분|예고등기|별도등기|불분명|농지취득자격증명|농취증|제시외|위반건축물|무단\s*증축|공유지분|맹지|체납|철거|분묘/;

function selftest() {
  const cases = [
    ['유치권 신고가 있음', GRADES.DANGER],
    ['을구 1번 주택임차권 등기는 배당에서 보증금이 전액 변제되지 아니하면 잔액을 매수인이 인수함.', GRADES.DANGER],
    ['매각에서 제외되는 제시외 건물이 소재하며, 이로 인한 법정지상권 성립 여부는 불분명', GRADES.CAUTION],
    ['위 지상에 공부상 표시 없는 묘가 존재하며, 분묘기지권 성립여부는 불분명', GRADES.CAUTION],
    ['농지취득자격증명서 제출 요(미 제출시 보증금 몰수)', GRADES.CAUTION],
    ['별도등기 있음: 1토지(을구 9번 지상권설정)', GRADES.CAUTION],
  ];
  let bad = 0;
  for (const [text, want] of cases) {
    const r = gradeRights({ rights: { statementNote: text, seniorMortgage: '2022.11.7. 근저당권' } });
    if (!r || r.grade !== want) {
      console.error(`[selftest] "${text.slice(0, 34)}…" → ${r ? r.grade : 'null'} (기대 ${want})`);
      bad++;
    } else if (!r.findings.length || !r.findings[0].quote) {
      console.error(`[selftest] 근거 문장이 비었다: ${text.slice(0, 34)}`);
      bad++;
    }
  }

  /* 안전이 나와야 하는 표본 - 등급기가 무조건 올리기만 하면 그것도 결함이다. */
  const clean = gradeRights({
    rights: { assumedRights: '해당사항없음', surfaceRight: '해당사항없음', seniorMortgage: '2022.11.7. 근저당권' },
  });
  if (!clean || clean.grade !== GRADES.SAFE) {
    console.error(`[selftest] 깨끗한 표본이 ${clean ? clean.grade : 'null'} 로 나왔다 (기대 안전)`);
    bad++;
  }

  /* 명세서가 없으면 등급을 만들지 않는다. */
  if (gradeRights({ rights: null }) !== null) { console.error('[selftest] 명세서 없는데 등급을 만들었다'); bad++; }

  /* 대항력 - 전입일이 말소기준보다 빠르면 위험. */
  const senior = gradeRights({
    rights: { assumedRights: '해당사항없음', seniorMortgage: '2022.11.7. 근저당권' },
    lessees: [{ name: '김*수', moveInDate: '2019-03-02', deposit: 50000000 }],
  });
  if (!senior || senior.grade !== GRADES.DANGER) {
    console.error(`[selftest] 선순위 임차인이 ${senior ? senior.grade : 'null'} (기대 위험)`);
    bad++;
  }
  /* 전입일이 늦으면 그것만으로 위험이 되지 않는다. */
  const later = gradeRights({
    rights: { assumedRights: '해당사항없음', seniorMortgage: '2022.11.7. 근저당권' },
    lessees: [{ name: '이*영', moveInDate: '2024-05-01', deposit: 30000000 }],
  });
  if (!later || later.grade !== GRADES.SAFE) {
    console.error(`[selftest] 후순위 임차인이 ${later ? later.grade : 'null'} (기대 안전)`);
    bad++;
  }
  /* 전입일을 모르면 안전으로 내리지 않는다(원칙 ①). */
  const unknown = gradeRights({
    rights: { assumedRights: '해당사항없음', seniorMortgage: '2022.11.7. 근저당권' },
    lessees: [{ name: '박*민', moveInDate: '', deposit: 0 }],
  });
  if (!unknown || unknown.grade === GRADES.SAFE) {
    console.error('[selftest] 전입일 모르는데 안전이 나왔다');
    bad++;
  }

  console.log(bad ? `✘ 자가시험 실패 ${bad}건` : '✓ 자가시험 통과 — 역주입 11건 전부 잡힘');
  return bad ? 1 : 0;
}

function sweep() {
  let rows;
  try { rows = JSON.parse(fs.readFileSync(DATA, 'utf8')); } catch (e) {
    console.error('canonical 을 읽지 못했다:', e.message); return 1;
  }
  const withRights = rows.filter((r) => r.rights);
  const dist = {};
  const leaks = [];
  const noQuote = [];
  const noNotice = [];

  for (const r of withRights) {
    const g = gradeRights(r);
    if (!g) continue;
    dist[g.grade] = (dist[g.grade] || 0) + 1;

    const text = Object.values(r.rights).filter((v) => typeof v === 'string').join(' ');
    /* "해당사항없음" 안의 말은 신호로 치지 않는다 - 법원이 없다고 적은 칸이다. */
    const meaningful = Object.values(r.rights)
      .filter((v) => typeof v === 'string' && !/^\s*해당\s*사항\s*없음\s*$/.test(v.replace(/\s+/g, ' ')))
      .join(' ');
    if (g.grade === GRADES.SAFE && NEVER_SAFE.test(meaningful)) {
      leaks.push({ id: r.id, hit: (meaningful.match(NEVER_SAFE) || [])[0], text: meaningful.slice(0, 100) });
    }
    if (g.grade !== GRADES.SAFE && g.findings.some((f) => !f.quote)) noQuote.push(r.id);
    if (!g.notice || !Array.isArray(g.fieldCheck) || !g.fieldCheck.length) noNotice.push(r.id);
    void text;
  }

  console.log(`[rights-grade] rights 보유 ${withRights.length}건`);
  console.log('  등급 분포:', JSON.stringify(dist));
  let bad = 0;
  if (leaks.length) {
    console.error(`✘ 위험어가 있는데 「안전」으로 나온 건 ${leaks.length}건`);
    for (const x of leaks.slice(0, 5)) console.error(`    ${x.id} · "${x.hit}" · ${x.text}`);
    bad = 1;
  }
  if (noQuote.length) { console.error(`✘ 근거 문장 없는 판정 ${noQuote.length}건 — ${noQuote.slice(0, 3).join(', ')}`); bad = 1; }
  if (noNotice.length) { console.error(`✘ 고지 문구 누락 ${noNotice.length}건`); bad = 1; }
  if (!bad) console.log('✓ PASS — 위험어 누락 0 · 근거 누락 0 · 고지 누락 0');
  return bad;
}

const code = process.argv.includes('--selftest') ? selftest() : (selftest() || sweep());
process.exitCode = code;
