# ZibTok 경매 검색 화면 — 발주서

이 파일은 **집톡 리포(`hitbunyang-e0c09b28`)의 Claude Code에 그대로 붙여넣는 프롬프트**다.
auction-view 리포에서 작성했고, 여기 적힌 수치는 전부 2026-09-10 실측이다.

---

## 배경 (읽고 시작할 것)

대한민국 법원경매정보의 공개 데이터를 모아 만든 경매 DB가 이미 운영 중이다.
집톡은 그 데이터를 **읽기만** 한다. 수집·병합·저장은 전부 auction-view 쪽에서
끝나 있고, 집톡이 할 일은 화면 하나다.

데이터는 Cloudflare KV에 올라가 있고, Cloudflare Pages Functions로 만든 API를
통해서만 읽는다. **원본 `data/auctions.json`은 27MB다. 절대 직접 가져오지 마라.**
휴대폰에서 멈춘다. 이 규칙 하나 때문에 API가 존재한다.

Base URL: `https://auction-view.pages.dev`
2026-09-10 14:00 UTC 실측: 총 11,973건, 낙찰가 확보 1,794건(15.0%), 사진 59건(0.5%).

---

## API 스펙 3종

### 1. `GET /api/auction/list` — 목록 + 검색

한 번의 KV 조회로 끝난다. 필터를 몇 개 걸든 라운드트립은 1회다.

**쿼리 파라미터** (전부 선택)

| 이름 | 값 | 비고 |
|---|---|---|
| `sido` | 시/도 이름 | `facets`에서 받은 문자열 그대로 |
| `sigungu` | 시군구 이름 | `sido`와 함께 써야 의미 있음 |
| `usage` | 용도 | 예: 아파트, 다세대주택, 토지 |
| `minPrice` / `maxPrice` | 정수(원) | **최저매각가 기준**, 감정가 아님 |
| `saleDateFrom` / `saleDateTo` | `YYYY-MM-DD` | 문자열 비교라 형식 어긋나면 조용히 안 걸림 |
| `hasWinning` | `1` \| `0` | 낙찰가 보유 여부 |
| `q` | 자유문자 | 사건번호 + 소재지 **부분일치**. 형태소 분석 없음 |
| `sort` | `saleDate`(기본) \| `minimumPrice` \| `appraisedPrice` \| `failedCount` | 다른 값은 400 |
| `order` | `asc`(기본) \| `desc` | |
| `page` | 1부터 | |
| `size` | 기본 20, **최대 100** | 초과분은 100으로 잘림 |

**응답**

```json
{
  "generatedAt": "2026-09-10T14:00:43.343Z",
  "page": 1, "size": 20, "total": 11973, "totalPages": 599,
  "facets": { "sido": ["..."], "sigungu": {"충청북도": ["..."]}, "usage": ["..."] },
  "items": [
    {
      "id": "B000210|2024타경3887|1",
      "caseNumber": "2024타경3887",
      "courtName": "...",
      "address": "...",
      "sido": "충청북도", "sigungu": "청주시",
      "usage": "아파트",
      "appraisedPrice": 0, "minimumPrice": 0,
      "saleDate": "2026-09-15",
      "failedCount": 0,
      "hasWinning": 0,
      "photoCount": 0, "documentCount": 0
    }
  ]
}
```

카드에는 위 14개 필드만 있다. 상세 필드는 없다 — 있어야 하면 2번을 호출한다.
`items[].address`는 **최대 120자로 잘려 있고 `[상세내역]` 이후가 제거돼 있다.**
전체 주소는 상세에만 있다. (잘라내지 않았을 때 평균 165자 → 29자, 이것 때문에
전체 블롭이 KV 객체 상한을 넘겼다.)

캐시: `public, max-age=60`.

### 2. `GET /api/auction/facets` — 필터 선택지

목록을 먼저 부르지 않고 드롭다운을 만들 수 있게 분리해 둔 것.

```json
{ "sido": ["강원특별자치도", "경상남도", ...],
  "sigungu": { "충청북도": ["괴산군", ...], ... },
  "usage": ["아파트", ...] }
```

캐시: `public, max-age=600`. 첫 화면에서 한 번만 부르고 들고 있어라.

### 3. `GET /api/auction/:id` — 사건 상세

`id`는 `"<법원코드>|<사건번호>|<물건번호>"` 형식이고 **`|`가 들어가므로 반드시
`encodeURIComponent`로 감싸서 보낸다.** 안 하면 404가 아니라 라우팅이 깨진다.

```
/api/auction/B000210%7C2024%ED%83%80%EA%B2%BD3887%7C1
```

**응답 주요 필드**

```
id caseNumber itemNumber courtCode courtName
address regionSido regionSigungu usage caseType buildingName propertyDescription
appraisedPrice minimumPrice claimAmount
saleDate failedCount status
winningPrice winningDate winningRatio bidderCount saleResult
caseClosedDate expiredAt
appraisalSummary appraisalDate appraisalAgency landArea buildingArea
events[]        기일내역
components[]    최대 40개
documents[]  documentCount
photos[]     photoCount     photos는 최대 20개, 상대경로 문자열
coverage{}   detailCheckedAt  source
```

없는 값은 `null` 또는 `0`이다. 키 자체가 빠지지는 않는다.
없는 사건은 `404` + `{"error": "..."}`.
캐시: `public, max-age=300`.

---

## 화면 요구사항

**하나의 검색 화면 + 하나의 상세 다이얼로그.** 그 이상은 지금 만들지 마라.

1. **필터 바** — 시/도 → 시군구(시/도 선택 시 채움) → 용도, 가격대(최저가 기준
   최소/최대), 기일 범위, "낙찰가 있는 것만" 토글. 선택지는 `facets`에서 온 값만
   쓴다. 하드코딩 금지 — 법원 데이터가 바뀌면 목록도 바뀐다.
2. **검색창** — `q`로 넘긴다. 부분일치라는 걸 사용자가 알 수 있게 placeholder에
   "사건번호 또는 소재지" 정도로 적어라.
3. **결과 리스트** — 카드. 소재지, 용도, 감정가/최저가, 기일, 유찰횟수, 사진 유무.
   정렬 컨트롤은 위 4종만. 페이지네이션 또는 무한스크롤 중 하나(`page`/`size`).
4. **상세** — 카드를 누르면 3번 API를 호출해 다이얼로그로. 기일내역(`events`),
   문서 목록, 사진, 감정 요약.
5. **빈 상태 / 로딩 / 에러** 세 가지를 반드시 만든다. 특히 `503`은 "데이터 준비
   중"으로 보여줘라 — 장애가 아니라 KV 업로드 대기 상태일 수 있다.
6. 모바일 우선. 집톡은 휴대폰에서 본다.

---

## 주의사항 (이걸 어기면 다시 만들어야 한다)

- **`data/auctions.json`을 부르지 마라.** 27MB다. 어떤 화면도 canonical을 직접
  읽지 않는다. 예외 없다.
- **낙찰가는 15%만 있다.** 낙찰가 컬럼을 필수처럼 그리면 화면 대부분이 빈칸이
  된다. 있는 건에만 표시하고, 없으면 그 자리를 비워라 — "0원"으로 그리지 마라.
- **사진은 0.5%다.** 사진 캐러셀을 기본 레이아웃의 전제로 삼지 마라. 사진 없는
  카드가 정상이고 대다수다. `photoCount`로 분기해라.
- **`감정가`도 2%는 비어 있다.** `appraisedPrice: 0`을 "0원"이 아니라 "정보 없음"
  으로 다뤄라. `minimumPrice`도 같다.
- **날짜는 전부 KST 기준으로 만들어진 문자열이다.** `new Date()`로 파싱해서
  로컬 타임존으로 다시 포매팅하면 하루가 밀린다. 문자열을 그대로 보여주거나,
  포매팅한다면 타임존을 고정해라.
- **`id`는 percent-encoding 필수.** `|`와 한글이 모두 들어간다.
- **`size`는 100이 상한이다.** 그 이상 요청해도 100으로 잘리니, 무한스크롤을
  만든다면 그 전제로 짜라.
- **응답에 상한이 걸려 있다.** 서버가 너무 큰 응답은 500으로 거절한다. 한 번에
  전부 받으려는 설계를 하지 마라.
- **`generatedAt`을 화면 어딘가에 노출해라.** 데이터가 언제 것인지 사용자와
  운영자 모두가 알아야 한다. 업로드가 밀리면 이 값이 멈춘다.
- 데이터 출처 표기: **대한민국 법원경매정보**. 공개 데이터이고, 표기는 유지한다.

---

## 완료 판정

- 필터 3종(지역/용도/가격) 각각 단독으로, 그리고 조합해서 결과 수가 바뀐다
- 카드를 눌러 상세가 뜨고, 기일내역이 보인다
- 사진 없는 사건·낙찰가 없는 사건에서 레이아웃이 깨지지 않는다
- 휴대폰 폭에서 가로 스크롤이 생기지 않는다
- 네트워크 실패와 503을 각각 다르게 보여준다
