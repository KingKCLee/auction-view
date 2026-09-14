# 법원경매정보 데이터 명세 — 무엇이 오고, 무엇을 저장하고, 무엇을 보여 주는가

이 문서는 **실측으로만 채운다.** 확인하지 않은 칸은 「없음」이 아니라 **「미확인」**으로
적는다(CLAUDE.md 「확인하지 않은 것을 '없다'로 단정하지 않는다」).

왜 만들었나 — 2026-09-14, 등기부현황·배당요구·임차인현황을 「별도 원천이 필요하다」고
보고했는데 확인해 보니 **이미 받고 있는 응답 안에 들어 있었다.** `detail-enrich.js` 가
현황조사서를 매 사건 호출해 응답을 받아 놓고 `if (sr?.data)` 로 있다/없다만 보고 내용을
버리고 있었다. 무엇이 오는지 적어 두지 않아 생긴 일이라, 오는 것을 적어 둔다.

저장 여부 표기: **①수집 안 함 · ②존재 여부만 · ③원문/구조화 보유**

---

## 우리가 호출하는 엔드포인트 (2026-09-14 실측)

| 엔드포인트 | 쓰는 곳 | 무엇을 주나 |
|---|---|---|
| `/pgj/pgj15B/selectAuctnCsSrchRslt.on` | `detail-enrich.js` | 사건 상세 — `dma_result` 12키 |
| `/pgj/pgj15B/selectCurstExmndc.on` | `detail-enrich.js` | 현황조사서 원문 |
| `/pgj/pgjsearch/selectDspslSchdRsltSrch.on` | `sale-result-collect.js` | 매각결과(낙찰가) |
| `/pgj/pgj143/selectRletDspslPbanc(.Dtl).on` | `current-court-sweep.js` | 매각공고 목록·상세 |
| `/pgj/pgjComm/selectCortOfcCdLst.on` | 공통 | 법원 목록 |
| `/pgj/pgj15A/selectAuctnCsSrchRslt.on` | `basic-info-enrich.js` | 사건 기본조회 |

사건 상세 `dma_result` 의 12키: `csBaseInfo` · `dstrtDemnInfo` · `dspslGdsDxdyInfo` ·
`picDvsIndvdCnt` · `csPicLst` · `gdsDspslDxdyLst` · `gdsDspslObjctLst` · `rgltLandLstAll` ·
`bldSdtrDtlLstAll` · `gdsNotSugtBldLsstAll` · `gdsRletStLtnoLstAll` · `aeeWevlMnpntLst`

---

## 섹션 1 — 사진 갤러리

| 필드 | 의미 | 출처 | 저장 | 화면 |
|---|---|---|---|---|
| `csPicLst[].picFile` | 사진 base64 | 상세 응답 | ③ `photos/` 파일 + `photoUrls[]` | 표시 |

실측: 확보율 3.0%(361/12,111). 파일 자체는 저장소에 있고 화면은 `/data/api/auction?kind=photo`
프록시로 받는다 — 원본 사이트의 `/photos/...` 는 이미지가 아니라 SPA HTML 을 돌려준다.

## 섹션 2 — 사건 기본정보

| 필드 | 의미 | 출처 | 저장 | 화면 |
|---|---|---|---|---|
| `csRcptYmd` | 접수일 | `csBaseInfo` | ③ `caseReceivedDate` | 표시 |
| `csCmdcYmd` | 개시결정일 | `csBaseInfo` | ③ `caseStartDate` | 표시 |
| `csNm` | 사건명(강제/임의) | `csBaseInfo` | ③ `caseType` | 표시 |
| `clmAmt` | 청구금액 | `csBaseInfo` | ③ `claimAmount` | 표시 |
| `csProgStatCd` | 진행상태 코드 | `csBaseInfo` | ③ `caseProgressCode` | 코드라 미표시 |
| `auctnSuspStatCd` · `csProgSuspRsn` | 정지 상태·사유 | `csBaseInfo` | ③ `caseSuspendCode` · `caseSuspendReason` | 사유만 표시 |
| `cortAuctnJdbnNm` · `jdbnTelno` | 담당계 · 전화 | `csBaseInfo` | ③ `courtDept` · `courtDeptTel` | 표시 |
| `dstrtDemnLstprdYmd` | **배당요구종기** | `dstrtDemnInfo[]` | ③ `distributionDeadline` | 표시 |
| `csUltmtYmd` · `ultmtDvsCd` | 종국일·구분 | `csBaseInfo` | ③ `caseClosedDate` 등 | 미표시 |

## 섹션 3 — 감정평가현황

| 필드 | 의미 | 출처 | 저장 | 화면 |
|---|---|---|---|---|
| `aeeWevlMnpntLst[]` | 감정 요항 **항목별**(표본 10건) | 상세 응답 | ③ `appraisalPoints[]` (순번·항목코드·본문) | 표로 표시 |
| `aeeEvlAmt` | 감정가 | `dspslGdsDxdyInfo` | ③ `appraisedPrice` | 표시 |
| — | 토지/건물 면적 | `components[]` 합산 | ③ `landArea` · `buildingArea` | 표시 |

★`aeeWevlMnpntItmCd`(00083001 등) 항목코드의 뜻은 **미확인** — 글자로 바꾸지 않고 코드로 둔다.
종전에는 본문을 줄바꿈으로 이어 붙인 요약 한 덩어리(`appraisalSummary`)만 남겼다.

## 섹션 4 — 진행일정

| 필드 | 의미 | 출처 | 저장 | 화면 |
|---|---|---|---|---|
| `gdsDspslDxdyLst[]` | 기일내역 | 상세 응답 | ③ `events[]` | 표(회차·기일·장소·최저가·결과) |
| `fst~fothPbancLwsDspslPrc` | 회차별 최저가 | `dspslGdsDxdyInfo` | ③ `minimumPriceRounds[]` | 표시 |
| `prchDposRate` | 보증금 비율(%) | `dspslGdsDxdyInfo` | ③ `depositRate` | 표시 |
| `bidBgngYmd` · `bidEndYmd` | 입찰기간(기간입찰) | `dspslGdsDxdyInfo` | ③ `bidPeriodFrom/To` | 표시 |
| `dspslDcsnDxdyYmd` | 매각결정기일 | `dspslGdsDxdyInfo` | ③ `decisionDate` | 표시 |
| `dspslPlcNm` · `dspslDcsnPlcNm` | 매각·결정 장소 | `dspslGdsDxdyInfo` | ③ `salePlace` · `decisionPlace` | 표시 |

★`auctnDxdyRsltCd`(기일 결과)는 **코드**다. 뜻을 모르는 채 「유찰/매각」으로 옮기지 않는다 —
`dspslAmt` 가 있으면 낙찰로 본다.

## 섹션 5 — 권리관계 (매각물건명세서)

| 필드 | 의미 | 출처 | 저장 | 화면 |
|---|---|---|---|---|
| `ndstrcRghCtt` | 등기된 권리 중 **인수되는 것** | `dspslGdsDxdyInfo` | ③ `rights.assumedRights` | 표시 |
| `sprfcExstcDts` | 지상권 존부 | `dspslGdsDxdyInfo` | ③ `rights.surfaceRight` | 표시 |
| `tprtyRnkHypthcStngDts` | 기준 등기(말소기준) | `dspslGdsDxdyInfo` | ③ `rights.seniorMortgage` | 표시 |
| `gdsSpcfcRmk` | **명세서 비고 — 인수/소멸 판단 문장** | `dspslGdsDxdyInfo` | ③ `rights.statementNote` | 표시 |
| `dspslGdsRmk` | 물건 비고 | `dspslGdsDxdyInfo` | ③ `rights.goodsNote` | 표시 |
| `gdsSpcfcWrtYmd` | 명세서 작성일 | `dspslGdsDxdyInfo` | ③ `rights.writtenAt` | 표시 |
| `dspslGdsSpcfcEcdocId` · `orvParam` | 전자문서 열쇠 | `dspslGdsDxdyInfo` | ② 존재 여부만 | 미표시 |

실측 예(2025타경52510): `gdsSpcfcRmk` = "…우선변제권만 주장하고 대항력은 포기하며 …
**잔액을 매수인이 인수하지 않음**" — 인수/소멸 판단이 문장으로 그대로 온다.

**★예외**: 매각물건명세서는 법원 규정상 **매각기일 1주일 전**부터 공개된다. 비어 오는 것은
결함이 아니라 아직 공개 전이다 — 화면도 그렇게 적는다.

## 섹션 6 — 점유·임차인현황 (현황조사서)

| 필드 | 의미 | 출처 | 저장 | 화면 |
|---|---|---|---|---|
| `dma_curstExmnMngInf.exmnDtDts` | 조사일시 | 현황조사서 | ③ `occupancy.investigatedAt` | 표시 |
| `…lstPossRltnDts` 계열 | 점유관계 문장 | 현황조사서 | ③ `occupancy.note` | 표시 |
| `dlt_ordTsRlet[].gdsPossCtt` | 부동산별 점유 서술 | 현황조사서 | ③ `occupancy.items[]` | 표시 |
| `dlt_ordTsRlet[].lesCnt` | 임차인 수 | 현황조사서 | ③ `occupancy.items[].lesseeCount` | 표시 |
| `dlt_ordTsLserLtn[]` | **임차인 목록** | 현황조사서 | ③ `lessees[]`(원문 `raw` 동봉) | 표 |

★임차인 항목의 **정확한 키 이름은 미확인**이다 — 표본 5건이 모두 임차인 0건이었다. 지금
코드는 후보 키를 여러 개 시도하고 원문을 `raw` 로 함께 저장한다. 임차인 있는 사건을 만나면
그 원문으로 키를 확정하고 이 표를 고친다.

## 섹션 7 — 문건/송달내역

**미확인.** 사건 상세 화면 정의(`PGJ151F00.xml`, 13,925바이트)에서 발견된 엔드포인트는
`/pgj/pgj151/selectGdsDtlBmrkSrchCond.on` 와 `/pgj//pgjsearch/searchControllerMain.on` 둘뿐이고,
본문에 「송달」·「당사자」·`dlvr`·`trsm`·`prtcpnt` 어느 것도 등장하지 않았다. 다른 화면에
있을 가능성이 남아 있어 **「법원 API 미제공」으로 단정하지 않는다.** 추가 확인 필요.

## 섹션 8 — 당사자내역 (채권자·채무자·소유자)

**미확인.** 섹션 7과 같은 근거·같은 상태.

## 섹션 9 — 시세 참고

**착수 전.** 집톡 실거래DB 연동은 우선순위 판단이 필요하다(대표님 보고 후 결정).

---

## 부록 A — 매각통계 (PGJ161M01)

**미확인.** 2026-09-14 확인 시도: `/pgj/ui/pgj161/PGJ161M01.xml` → **404**,
`/pgj/index.on?w2xPath=…PGJ161M01.xml&pgjId=161` → 200이지만 2,478바이트(껍데기로 보임).
접수·처리·진행중 건수 및 평균 감정가·매각가율 제공 여부는 아직 못 봤다.

우리 canonical 로 직접 계산 가능한 것: 평균 감정가·평균 최저가·**매각가율**(낙찰가/감정가,
2,112건 보유)·평균 유찰횟수·기일별 분포. 접수/종국 건수는 우리에게 없는 축이다.

## 부록 B — 소급 반영

**원문을 어디에도 저장하지 않는다**(2026-09-14 확인: `data/` 에 원문 성격 파일 없음,
`includeRaw` 결과도 canonical 에 남기지 않음). 따라서 이번에 새로 꺼내기로 한 필드는
**기존 사건에 소급 재추출이 불가능하고 재수집이 필요하다.**

재수집 비용: 사건당 요청 1~2건(상세 1 + 현황조사서 1, 이미 있는 건은 1). 관문 공유 속도
약 360 req/h 기준.

## 부록 C — 이번 범위 밖(기록만)

- 지도검색 — 별도 트랙
- 테마검색(유치권·법정지상권·대항력임차인) — 명세서 원문 텍스트에서 추출해야 하므로
  섹션 5 저장이 쌓인 뒤에 가능. 현재는 데이터 부족으로 보류.
- 경매 캘린더 · 명도 리스크 평가 — 고급 기능, 이번 범위 제외
- 등기부등본 원본 — 법원경매정보 밖(인터넷등기소)
