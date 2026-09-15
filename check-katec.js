// 좌표 변환 게이트.
//
// R1(측정기 부정 테스트): 변환기가 내는 좌표를 반경 통계에 쓰기 전에, **틀린 좌표가
// 통과하지 못하는지** 먼저 본다. 잘못 변환한 좌표는 조용히 엉뚱한 동네의 시세를
// 붙이고, 화면에는 그럴듯한 숫자로 나온다 - 그것이 이 게이트가 있는 이유다.
//
// 재는 축 넷:
//   ⓐ 역주입 — 다른 좌표계로 만든 값·범위 밖 값·0 을 넣으면 반드시 null 이거나 멀리 어긋나는가
//   ⓑ 왕복 — 위경도 → KATEC → 위경도 가 1m 안으로 돌아오는가
//   ⓒ 실측 대조 — canonical 의 좌표를 변환한 결과가 그 사건의 시/도와 맞는가
//   ⓓ 범위 — 변환 결과가 전부 한반도 안인가
//
//   node check-katec.js [--selftest]

const fs = require('fs');
const path = require('path');
const { katecToWgs84 } = require('./katec');

const DATA = process.env.AUCTIONS_FILE || path.join(__dirname, 'data', 'auctions.json');

/* 정투영(검증용). katec.js 의 역투영과 **따로** 적는다 - 같은 식을 두 번 쓰면
   부호 하나 틀린 것을 서로 상쇄해 버린다(측정기와 피측정기를 분리한다). */
const A = 6378137.0, F = 1 / 298.257222101;
const E2 = F * (2 - F), EP2 = E2 / (1 - E2);
const R = Math.PI / 180;
function wgs84ToKatec(latD, lngD) {
  const lat = latD * R, lon = lngD * R, lat0 = 38 * R, lon0 = 128 * R, k0 = 0.9999;
  const M = (p) => {
    const a0 = 1 - E2 / 4 - 3 * E2 * E2 / 64 - 5 * E2 ** 3 / 256;
    const a2 = 3 / 8 * (E2 + E2 * E2 / 4 + 15 * E2 ** 3 / 128);
    const a4 = 15 / 256 * (E2 * E2 + 3 * E2 ** 3 / 4);
    const a6 = 35 / 3072 * E2 ** 3;
    return A * (a0 * p - a2 * Math.sin(2 * p) + a4 * Math.sin(4 * p) - a6 * Math.sin(6 * p));
  };
  const N = A / Math.sqrt(1 - E2 * Math.sin(lat) ** 2);
  const T = Math.tan(lat) ** 2, C = EP2 * Math.cos(lat) ** 2, D = (lon - lon0) * Math.cos(lat);
  const x = k0 * N * (D + (1 - T + C) * D ** 3 / 6
    + (5 - 18 * T + T * T + 72 * C - 58 * EP2) * D ** 5 / 120) + 400000;
  const y = k0 * (M(lat) - M(lat0) + N * Math.tan(lat) * (D * D / 2
    + (5 - T + 9 * C + 4 * C * C) * D ** 4 / 24
    + (61 - 58 * T + T * T + 600 * C - 330 * EP2) * D ** 6 / 720)) + 600000;
  return { x, y };
}

const distM = (a, b) => Math.hypot((a.lat - b.lat) * 111320, (a.lng - b.lng) * 111320 * Math.cos(a.lat * R));

/** 시/도별 대략 범위. 정밀 경계가 아니라 **말이 되는지**만 본다. */
const SIDO_BOX = {
  서울특별시: [37.42, 37.70, 126.76, 127.18], 부산광역시: [34.88, 35.39, 128.74, 129.31],
  대구광역시: [35.61, 36.01, 128.35, 128.76], 인천광역시: [37.20, 37.81, 126.36, 126.80],
  광주광역시: [35.03, 35.26, 126.64, 127.02], 대전광역시: [36.18, 36.50, 127.25, 127.55],
  울산광역시: [35.32, 35.72, 129.07, 129.47], 세종특별자치시: [36.42, 36.72, 127.11, 127.40],
};

function selftest() {
  let bad = 0;
  /* ⓑ 왕복 - 전국 여러 지점. */
  const pts = [[37.5665, 126.9780], [35.1595, 126.8526], [35.8714, 128.6014], [33.4996, 126.5312], [37.4563, 126.7052]];
  for (const [lat, lng] of pts) {
    const tm = wgs84ToKatec(lat, lng);
    const back = katecToWgs84(tm.x, tm.y);
    if (!back) { console.error(`[selftest] 왕복 실패(null): ${lat},${lng}`); bad++; continue; }
    const d = distM({ lat, lng }, back);
    if (d > 1) { console.error(`[selftest] 왕복 오차 ${d.toFixed(2)}m > 1m: ${lat},${lng}`); bad++; }
  }
  /*
   * ⓐ 역주입 - 쓰레기 값은 반드시 null.
   * ★"다른 좌표계 값이면 거부되어야 한다"는 표본은 넣지 않는다. (200000,600000) 은
   *   중부원점에서는 원점이지만 **KATEC 에서는 황해도의 정당한 좌표**라(37.98,125.72)
   *   거부 대상이 아니다. 좌표만 보고 좌표계를 되짚을 수는 없다 - 그 판별은 이 함수가
   *   아니라 ⓒ(시/도 대조)가 한다. 처음에 이 표본을 넣었다가 게이트가 제품을 틀렸다고
   *   찍었다(2026-09-16). 측정기의 표본이 틀린 것이었다.
   */
  for (const [x, y, why] of [[0, 0, '0,0'], [null, null, 'null'], [1, 1, '원점 근처'],
    [1000000, 2000000, 'UTM-K 값(한반도 밖으로 떨어진다)']]) {
    const r = katecToWgs84(x, y);
    if (r) { console.error(`[selftest] ${why} 가 통과했다 → ${r.lat},${r.lng}`); bad++; }
  }
  /* 실제 값 하나는 반드시 통과해야 한다 - 전부 막으면 그것도 결함이다. */
  const ok = katecToWgs84(298423, 549127);   // 서울 강서구 화곡동
  if (!ok || !(ok.lat > 37.4 && ok.lat < 37.7 && ok.lng > 126.7 && ok.lng < 127.0)) {
    console.error(`[selftest] 화곡동 좌표가 서울 밖으로 나왔다: ${JSON.stringify(ok)}`); bad++;
  }
  console.log(bad ? `✘ 자가시험 실패 ${bad}건` : '✓ 자가시험 통과 — 왕복 5건(1m 이내) · 역주입 4건 차단 · 실측 1건 통과');
  return bad ? 1 : 0;
}

function sweep() {
  let rows;
  try { rows = JSON.parse(fs.readFileSync(DATA, 'utf8')); } catch (e) {
    console.error('canonical 을 읽지 못했다:', e.message); return 1;
  }
  const withXY = rows.filter((r) => r.rawCoords);
  let converted = 0, outside = 0, mismatch = 0, unchecked = 0;
  const bad = [];
  for (const r of withXY) {
    const p = katecToWgs84(r.rawCoords.x, r.rawCoords.y);
    if (!p) { outside++; continue; }
    converted++;
    const box = SIDO_BOX[r.regionSido];
    if (!box) { unchecked++; continue; }
    const [a, b, c, d] = box;
    if (!(p.lat >= a && p.lat <= b && p.lng >= c && p.lng <= d)) {
      mismatch++;
      if (bad.length < 5) bad.push(`${r.regionSido} ${r.regionSigungu} → ${p.lat},${p.lng}`);
    }
  }
  console.log(`[katec] 좌표 보유 ${withXY.length}건 · 변환 ${converted} · 범위 밖 ${outside} · 시도 대조 생략 ${unchecked}`);
  if (mismatch) {
    console.error(`✘ 변환 결과가 그 사건의 시/도 밖이다 ${mismatch}건`);
    for (const x of bad) console.error('    ' + x);
    return 1;
  }
  console.log('✓ PASS — 시/도 대조 불일치 0건');
  return 0;
}

const code = process.argv.includes('--selftest') ? selftest() : (selftest() || sweep());
process.exitCode = code;
