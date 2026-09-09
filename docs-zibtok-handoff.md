# 집톡 경매 탭 — auction-view API 연동 지시서

받는 곳: `hitbunyang-e0c09b28` (ZibTok, Cloudflare Pages) 리포의 담당 CC
보내는 곳: `KingKCLee/auction-view`
작성: 2026-09-09

auction-view는 **API 제공까지만** 합니다. 화면 구현은 이 문서를 받는 쪽에서 합니다.

---

## 1. 접점은 이 API 하나뿐입니다

```
https://auction-view.pages.dev/api/auction/...
```

**GitHub의 `data/auctions.json`을 직접 불러오지 마십시오.** 21MB이고, 휴대폰에서
멈추거나 실패합니다. 목록·상세·통계 전부 아래 엔드포인트로 받으십시오.

모든 응답에 `access-control-allow-origin: *`가 붙어 있어 브라우저에서 바로
호출됩니다. 인증 없음, 익명 접근 가능.

응답은 전부 512,000 바이트 이하로 강제됩니다(초과 시 서버가 500을 냅니다).

---

## 2. 엔드포인트

### `GET /api/auction/list` — 목록

쿼리 파라미터 (전부 선택):

| 이름 | 설명 | 예 |
|---|---|---|
| `sido` | 시/도 | `서울특별시` |
| `sigungu` | 시군구 | `관악구` |
| `usage` | 용도 | `아파트` |
| `minPrice` / `maxPrice` | **최저매각가** 범위 (원) | `100000000` |
| `saleDateFrom` / `saleDateTo` | 매각기일 범위 | `2026-09-10` |
| `hasWinning` | `1`=낙찰가 있는 것만, `0`=없는 것만 | `1` |
| `q` | 사건번호·소재지 부분일치 | `2026타경93` |
| `sort` | `saleDate`(기본) `minimumPrice` `appraisedPrice` `failedCount` | |
| `order` | `asc`(기본) `desc` | |
| `page` | 1부터 | `1` |
| `size` | 기본 20, 최대 100 | `20` |

응답:

```json
{
  "generatedAt": "2026-09-09T07:55:19.333Z",
  "page": 1, "size": 20, "total": 1855, "totalPages": 93,
  "facets": { "sido": ["서울특별시", ...],
              "sigungu": { "서울특별시": ["강남구", ...] },
              "usage": ["아파트", ...] },
  "items": [{
    "id": "B000210|2026타경93|1",
    "caseNumber": "2026타경93",
    "courtName": "서울중앙지방법원",
    "address": "서울특별시 관악구 신림동 1655-15",
    "sido": "서울특별시", "sigungu": "관악구",
    "usage": "아파트",
    "appraisedPrice": 79000000,
    "minimumPrice": 55300000,
    "saleDate": "2026-09-09",
    "failedCount": 1,
    "hasWinning": 0,
    "photoCount": 0,
    "documentCount": 2
  }]
}
```

주의할 점:

- `id`에 `|`와 한글이 들어갑니다. 상세 조회 시 **반드시 percent-encoding** 하십시오.
- 카드용 `address`는 원본에서 `[상세내역]` 이후를 잘라내고 120자로 제한한 것입니다.
  전체 주소는 상세 응답에 있습니다.
- 사건번호가 `2025타경50484 2025타경51006 (병합)`처럼 복합인 경우가 있습니다
  (중복·병합 사건). 파싱하지 말고 문자열 그대로 표시하십시오.
- 금액은 **원** 단위 정수이거나 `null`입니다. `null`을 0으로 표시하지 마십시오.
- `facets`는 매 응답에 붙습니다. 드롭다운만 필요하면 `/facets`를 쓰십시오.

### `GET /api/auction/:id` — 상세

`id`는 percent-encoded. 예:
`/api/auction/B000210%7C2026%ED%83%80%EA%B2%BD93%7C1`

응답 (없는 값은 `null`):

```json
{
  "id": "...", "caseNumber": "...", "itemNumber": "1",
  "courtCode": "B000210", "courtName": "서울중앙지방법원",
  "address": "전체 주소 (상세내역 포함)",
  "regionSido": "...", "regionSigungu": "...",
  "usage": "...", "caseType": "...", "buildingName": "...",
  "propertyDescription": "...",
  "appraisedPrice": 79000000, "minimumPrice": 55300000, "claimAmount": null,
  "saleDate": "2026-09-09", "failedCount": 1, "status": null,

  "winningPrice": null, "winningDate": null, "winningRatio": null,
  "bidderCount": null, "saleResult": null,

  "caseClosedDate": null, "expiredAt": null,
  "appraisalSummary": "...", "appraisalDate": null, "appraisalAgency": null,
  "landArea": null, "buildingArea": null,

  "events": [{ "event_date": "2026-09-09", "event_time": "1000",
               "event_kind_code": "01", "place": "제101호 법정",
               "amount": 55300000, "winning_amount": null,
               "result_code": "" }],
  "components": [...], "documents": [{ "type": "매각물건명세서" }],
  "documentCount": 2, "photoCount": 0, "photos": [],
  "coverage": { "base_info": 1, "sale_statement": 0, ... },
  "detailCheckedAt": "...", "source": "..."
}
```

없는 `id`는 **404**. `{"error":"no case ..."}`.

코드 값 해석 (관측된 것만, 공식 표 아님):

| 필드 | 값 | 뜻 |
|---|---|---|
| `events[].result_code` | `001` | 매각 |
| | `002` | 유찰 |
| | `003` | 매각결정 불허가 |
| | `""` | 아직 결과 없음 |
| `events[].event_kind_code` | `01` | 매각기일 |
| | `02` | 매각결정기일 |
| `status` | `expired` | 원천에서 내려간 사건. 레코드는 보존 |

### `GET /api/auction/stats` — 통계 / 진도율

```json
{
  "generatedAt": "...", "today": "2026-09-09",
  "itemCount": 10667, "expiredMarked": 76,
  "coverage": { "base_info": {"count": 10324, "percent": 96.8},
                "sale_statement": {...}, "status_report": {...},
                "appraisal_summary": {...}, "photos": {...},
                "winning_price": {...} },
  "documentCount": 2504,
  "winningPriceCaptured": 0, "atRiskToday": 883, "permanentlyLost": 2450,
  "lastCloudMergeAt": "...", "lastLaptopRunAt": "...", "lastLaptopRun": {...}
}
```

### `GET /api/auction/facets` — 필터 선택지만

```json
{ "sido": [...], "sigungu": { "<시도>": [...] }, "usage": [...] }
```

---

## 3. 화면 쪽에서 지켜야 할 것

- **원본 json 직접 fetch 금지.** 클라이언트가 `data/auctions.json`을 부르는 코드는
  들어가면 안 됩니다.
- 필터·검색·페이징은 전부 `/list`의 쿼리 파라미터로 넘기십시오. 전체를 받아
  클라이언트에서 거르지 마십시오.
- 상세는 카드를 열 때만 `/:id`로 부르십시오. 목록 응답에는 상세가 없습니다.
- 캐시: `/list`와 `/stats`는 60초, `/:id`는 300초, `/facets`는 600초의
  `cache-control`이 붙어 있습니다. 그대로 두면 됩니다.
- 출처 표기: **"대한민국 법원경매정보"**. 개인정보가 포함될 수 있는 원문은 그대로
  노출하지 마십시오.

## 4. 데이터에 대해 알아두실 것

- [측정] 원천은 매각기일이 지난 사건을 다음 날 내립니다. 그래서 `saleDate`가
  과거인 행은 원천에 더는 없고 우리 기록만 남은 것입니다(`status: "expired"`).
- [측정] `winningPrice`는 현재 전 건 `null`입니다. 낙찰가는 별도 창구
  (매각결과검색)에서 오는데, 수집기는 만들었으나 아직 돌리지 못했습니다.
  화면은 `winningPrice`가 `null`인 상태를 정상으로 다뤄야 하고, 값이 들어오기
  시작하면 그대로 표시하면 됩니다.
- [측정] 데이터 갱신은 클라우드 병합 시점에 일어납니다. `generatedAt`으로
  신선도를 판단하십시오. 현재는 자동 갱신 연결 전이라 07:55Z에 멈춰 있습니다.
- [측정] 사진(`photos`)은 거의 비어 있습니다(coverage 0.6%).

## 5. 참고 구현

`auction-view/public/index.html`에 목록·필터·상세 다이얼로그를 API만으로 구현한
페이지가 있습니다. 그대로 쓰실 필요는 없고, 호출 방식 참고용입니다.
`https://auction-view.pages.dev/` 에서 동작합니다.

## 6. 막히면

- API가 503 `"AUCTION_KV binding is missing"` 또는 `"no ... in KV"`를 내면
  auction-view 쪽 데이터 업로드 문제입니다. 이쪽으로 알려주십시오.
- 필드 추가나 새 필터가 필요하면 요청하십시오. 화면에서 전체를 받아 거르는
  방식으로 우회하지 마십시오.
