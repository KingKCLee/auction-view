// 목록내역 — 전유부분의 건물의 표시 · 대지권의 목적인 토지의 표시.
//
// ★왜 따로 만들었나 (2026-09-16): `detail-enrich.js` 의 `components()` 가 면적을
//   `['area','bldArea','landArea','excluUseArea','calcArea']` 라는 **없는 키 이름**으로
//   찾고 있었다. 실제 응답의 키는 `objctArDts`·`landArDts` 이고 값은 숫자가 아니라
//   "철근콘크리트구조 59.79㎡" 같은 **문자열**이다. 그래서 24,521개 항목이 전부
//   `area: null` 인 빈 껍데기로 저장됐고, 나는 그것을 보고 「법원이 면적을 안 준다」고
//   보고했다. 틀렸다 - 주지 않은 게 아니라 **우리가 엉뚱한 이름으로 찾고 있었다.**
//
// 원본 화면의 「목록내역」이 이 두 배열이다:
//   전유부분의 건물의 표시  → gdsDspslObjctLst[].objctArDts  (구조 + 면적)
//   대지권의 목적인 토지의 표시 → rgltLandLstAll[][].landArDts (토지 전체 면적)
//                              + rgltRateNmrtVal / rgltRateDnmnVal (대지권 비율)
// 실측(2025타경21144 계열): 대지권 19.4978/73759.8 이고, 분모 73759.8 은 4필지
// landArDts 합(13211.6+14336+25944.1+20268.1)과 **정확히 같다.** 즉 분자 19.4978 이
// 이 물건 몫의 대지권 면적(㎡)이다.

const txt = (v) => String(v == null ? '' : v).replace(/\s+/g, ' ').trim();

/** "철근콘크리트구조 59.79㎡" · "13211.6㎡" → 59.79 / 13211.6. 없으면 null. */
function areaOf(s) {
  const m = txt(s).match(/([\d,]+(?:\.\d+)?)\s*(?:㎡|m2|m²)/i);
  if (!m) return null;
  const n = Number(m[1].replace(/,/g, ''));
  return Number.isFinite(n) && n > 0 ? n : null;
}

/** 면적을 뗀 나머지 = 구조 설명. "철근콘크리트구조 59.79㎡" → "철근콘크리트구조". */
function structureOf(s) {
  return txt(String(s || '').replace(/[\d,]+(?:\.\d+)?\s*(?:㎡|m2|m²)/gi, '')) || '';
}

/**
 * 목록내역을 구조화한다.
 *
 * @returns {object|null} 아무것도 못 읽으면 null - 빈 껍데기를 만들지 않는다.
 */
function listingDetail(r) {
  const objs = Array.isArray(r && r.gdsDspslObjctLst) ? r.gdsDspslObjctLst : [];
  /* rgltLandLstAll 은 **배열의 배열**이다(목적물마다 한 묶음). 평평하게 편다. */
  const landGroups = Array.isArray(r && r.rgltLandLstAll) ? r.rgltLandLstAll : [];
  const lands = landGroups.flatMap((g) => (Array.isArray(g) ? g : [g])).filter(Boolean);
  const bldGroups = Array.isArray(r && r.bldSdtrDtlLstAll) ? r.bldSdtrDtlLstAll : [];
  const blds = bldGroups.flatMap((g) => (Array.isArray(g) ? g : [g])).filter(Boolean);

  /* ① 전유부분의 건물의 표시 */
  const exclusive = objs.map((x) => ({
    no: txt(x.bldDtlDts) || null,                 // "212동 22층2211호"
    structure: structureOf(x.objctArDts),
    area: areaOf(x.objctArDts),
    buildingName: txt(x.bldNm) || null,
    address: txt(x.rprsLtnoAddr) || null,
    usageCode: txt(x.mclDspslGdsLstUsgCd) || null,
  })).filter((x) => x.area || x.structure || x.no);

  /* ② 대지권의 목적인 토지의 표시 */
  const landRows = lands.map((x) => ({
    address: txt(x.rgltLandLtnoAddr) || null,
    category: txt(x.landLdcgDts) || null,         // 지목 "대"
    area: areaOf(x.landArDts),
    ratioNumerator: Number(x.rgltRateNmrtVal) || null,
    ratioDenominator: Number(x.rgltRateDnmnVal) || null,
  })).filter((x) => x.area || x.address);

  /* ③ 건물 층별 명세(있으면). 여러 줄짜리 서술이라 원문 그대로 둔다. */
  const buildingDetail = blds.map((x) => txt(x.bldSdtrDtlDts)).filter(Boolean);

  /*
   * 대지권 면적 - 분자가 곧 이 물건 몫의 ㎡ 다(분모 = 토지 전체 합).
   * ★분모가 토지면적 합과 다르면 그 전제가 깨진 것이므로 **계산하지 않는다.**
   *   억지로 환산해 틀린 면적을 적느니 비워 두는 편이 낫다.
   */
  let landShareArea = null;
  const nums = landRows.map((x) => x.ratioNumerator).filter((n) => n);
  const dens = landRows.map((x) => x.ratioDenominator).filter((n) => n);
  if (nums.length && dens.length) {
    const totalLand = landRows.reduce((a, b) => a + (b.area || 0), 0);
    const den = dens[0];
    if (totalLand > 0 && Math.abs(totalLand - den) / den < 0.01) landShareArea = nums[0];
  }

  const exclusiveArea = exclusive.reduce((a, b) => a + (b.area || 0), 0) || null;
  const totalLandArea = landRows.reduce((a, b) => a + (b.area || 0), 0) || null;

  if (!exclusive.length && !landRows.length && !buildingDetail.length) return null;
  return {
    exclusive,
    land: landRows,
    buildingDetail,
    exclusiveArea,        // 전유면적 합 (㎡)
    landShareArea,        // 대지권 면적 (㎡) - 전제가 맞을 때만
    totalLandArea,        // 대지 전체 면적 (㎡)
  };
}

/**
 * 좌표. 법원은 TM 계열 정수로 준다(실측: stXcrd=371938 stYcrd=259445).
 * ★어느 좌표계인지 확인하지 않았다. 확인 전에는 **위경도로 바꾸지 않는다** -
 *   잘못 변환한 좌표는 엉뚱한 곳을 가리키고, 그것이 반경 통계로 흘러가면
 *   틀린 시세가 붙는다. 원값과 "미확인" 표시를 함께 저장해 둔다.
 */
function rawCoords(r) {
  const o = (Array.isArray(r && r.gdsDspslObjctLst) ? r.gdsDspslObjctLst : [])[0];
  if (!o) return null;
  const x = Number(o.stXcrd), y = Number(o.stYcrd);
  if (!Number.isFinite(x) || !Number.isFinite(y) || !x || !y) return null;
  return { x, y, srs: 'unverified' };
}

module.exports = { listingDetail, rawCoords, areaOf, structureOf };
