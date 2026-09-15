// 법원 좌표(stXcrd/stYcrd) → 위경도(WGS84).
//
// ★좌표계를 추측하지 않고 **실측으로 확정했다** (2026-09-16).
//   집톡 `complexes`(위경도 51,821건 전부 보유)의 법정동 중심점과 대조해 후보 8종을
//   재 보니 결과가 압도적으로 갈렸다:
//
//     KATEC(TM128)        중앙값      676m   ← 채택
//     EPSG:5185 서부2010   중앙값   71,593m
//     EPSG:5186 중부2010   중앙값  111,334m
//     EPSG:5174 중부       중앙값  149,238m
//     EPSG:5187 동부2010   중앙값  290,249m
//     EPSG:5179 UTM-K     중앙값 1,541,649m
//
//   676m 는 **법정동 중심점과의 거리**다(동 반지름 수준) - 실제 오차가 아니라 기준점의
//   해상도다. 그래도 단지 한 채를 특정하는 용도로는 쓰지 않는다. 반경 1km 통계처럼
//   **동네 단위**로만 쓴다. 그것이 이 좌표로 할 수 있는 말의 한계다.
//
// KATEC(TM128): lat0=38 · lon0=128 · k0=0.9999 · x0=400000 · y0=600000 · GRS80
//   (Bessel 타원체로 재도 중앙값이 같았다 - 이 해상도에서는 구분되지 않는다.)

const A = 6378137.0;                 // GRS80 장반경
const F = 1 / 298.257222101;
const E2 = F * (2 - F);
const EP2 = E2 / (1 - E2);
const LAT0 = 38 * Math.PI / 180;
const LON0 = 128 * Math.PI / 180;
const K0 = 0.9999;
const X0 = 400000;
const Y0 = 600000;
const DEG = 180 / Math.PI;

/** 자오선호장 M(φ). */
function meridian(phi) {
  const A0 = 1 - E2 / 4 - (3 * E2 * E2) / 64 - (5 * E2 ** 3) / 256;
  const A2 = (3 / 8) * (E2 + (E2 * E2) / 4 + (15 * E2 ** 3) / 128);
  const A4 = (15 / 256) * (E2 * E2 + (3 * E2 ** 3) / 4);
  const A6 = (35 / 3072) * E2 ** 3;
  return A * (A0 * phi - A2 * Math.sin(2 * phi) + A4 * Math.sin(4 * phi) - A6 * Math.sin(6 * phi));
}

/**
 * KATEC → WGS84. 역투영(Snyder 표준식).
 *
 * @returns {{lat:number,lng:number}|null} 한반도 밖이면 null - 변환은 됐지만 말이 안 되는
 *   값을 그대로 내보내지 않는다(원천이 0 이나 더미를 주는 경우가 실제로 있다).
 */
function katecToWgs84(x, y) {
  const X = Number(x), Y = Number(y);
  if (!Number.isFinite(X) || !Number.isFinite(Y) || !X || !Y) return null;

  const M = meridian(LAT0) + (Y - Y0) / K0;
  const e1 = (1 - Math.sqrt(1 - E2)) / (1 + Math.sqrt(1 - E2));
  const mu = M / (A * (1 - E2 / 4 - (3 * E2 * E2) / 64 - (5 * E2 ** 3) / 256));
  const phi1 = mu
    + ((3 * e1) / 2 - (27 * e1 ** 3) / 32) * Math.sin(2 * mu)
    + ((21 * e1 * e1) / 16 - (55 * e1 ** 4) / 32) * Math.sin(4 * mu)
    + ((151 * e1 ** 3) / 96) * Math.sin(6 * mu)
    + ((1097 * e1 ** 4) / 512) * Math.sin(8 * mu);

  const C1 = EP2 * Math.cos(phi1) ** 2;
  const T1 = Math.tan(phi1) ** 2;
  const N1 = A / Math.sqrt(1 - E2 * Math.sin(phi1) ** 2);
  const R1 = (A * (1 - E2)) / (1 - E2 * Math.sin(phi1) ** 2) ** 1.5;
  const D = (X - X0) / (N1 * K0);

  const lat = phi1 - ((N1 * Math.tan(phi1)) / R1) * ((D * D) / 2
    - ((5 + 3 * T1 + 10 * C1 - 4 * C1 * C1 - 9 * EP2) * D ** 4) / 24
    + ((61 + 90 * T1 + 298 * C1 + 45 * T1 * T1 - 252 * EP2 - 3 * C1 * C1) * D ** 6) / 720);
  const lng = LON0 + (D - ((1 + 2 * T1 + C1) * D ** 3) / 6
    + ((5 - 2 * C1 + 28 * T1 - 3 * C1 * C1 + 8 * EP2 + 24 * T1 * T1) * D ** 5) / 120) / Math.cos(phi1);

  const latD = lat * DEG, lngD = lng * DEG;
  /* 한반도 범위 밖이면 버린다 - 쓸 수 없는 값을 내보내지 않는다. */
  if (!(latD > 32 && latD < 40 && lngD > 124 && lngD < 132)) return null;
  return { lat: Math.round(latD * 1e6) / 1e6, lng: Math.round(lngD * 1e6) / 1e6 };
}

/** canonical 한 행에서 위경도를 만든다. 좌표가 없거나 범위 밖이면 null. */
function coordsOf(row) {
  const c = row && row.rawCoords;
  if (!c) return null;
  const p = katecToWgs84(c.x, c.y);
  if (!p) return null;
  return { ...p, srs: 'KATEC(TM128)', precision: '동네 단위(±수백 m) - 단지 특정 용도로 쓰지 않는다' };
}

module.exports = { katecToWgs84, coordsOf };
