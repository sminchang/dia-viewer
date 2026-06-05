# 품질 게이트 & 튜닝 가이드

레이아웃(`src/core/layout.ts`)·라우터(`src/core/routeEdges.ts`, `labelPlacement.ts`)를 만진 뒤의 검증 절차.

## 게이트 실행

```bash
npm run metrics                              # 번들 합성 픽스처 (Annotations ON)
npm run metrics -- path/to/any.arch.json     # 임의 매니페스트
npm run metrics -- path/to/any.arch.json off # OFF 뷰 (라벨 게이트 제외)
```

- **하드 게이트** (FAIL 시 exit 1): 경계 의미론(person/external이 boundary 밖), 노드 비겹침, 엣지의 노드 관통 0(자기 노드 포함), 라벨-노드/라벨-라벨 충돌 0
- **소프트 지표**: 시각 교차(번들 단위), 라벨-선 겹침, 총 길이, 캔버스 크기/비율

## 판정 규칙

| 결과 | 의미 | 행동 |
|---|---|---|
| 하드 게이트 FAIL | 상수 문제가 아니라 **버그** | 코드 수정 (상수 스윕으로 덮지 말 것) |
| PASS + 소프트 지표 나쁨 | 그래프 분포가 튜닝 범위 밖일 수 있음 | 아래 스윕으로 상수 재탐색 |

## 기준선 (2026-06 튜닝 시점)

| 입력 | ON 교차 | 비고 |
|---|---|---|
| 합성 픽스처 (12노드/18엣지) | 0 | 회귀 기준 — 0이 아니면 퇴행 |
| coral-ai 계열 실측 (20노드/32~35엣지) | 11~16 | 이 규모의 정상 범위 |

상수들은 위 입력들(합성 1 + 실매니페스트 3종)에서 스윕으로 정해졌다. 크게 다른 분포(50노드+, 고밀도)에선 재스윕 가치 있음.

## 상수 스윕

```bash
scripts/sweep.sh <파일> <상수명> "<후보들>" [매니페스트] [off]
# 예:
scripts/sweep.sh src/core/routeEdges.ts INFLATE "12 14 16" my.arch.json
scripts/sweep.sh src/core/layout.ts GAP_Y_ANNO "88 96 104"
```

각 후보를 적용해 metrics를 돌리고 원래 값으로 복원한다. 주요 튜닝 노브:

| 상수 | 위치 | 역할 |
|---|---|---|
| `GAP_X` / `GAP_Y` | layout.ts | OFF 뷰 열/행 간격 |
| `GAP_X_ANNO` / `GAP_Y_ANNO` | layout.ts | ON 뷰(라벨 공간) 간격 |
| `W_CROSS` 등 `W_*` | layout.ts | 배치 목적함수 가중치 (교차 ≫ 길이 > 면적/비율 > 하향흐름) |
| `INFLATE` | routeEdges.ts | 노드 클리어런스 = 첫 꺾임 거리 |
| `TURN_PENALTY` / `CROSS_PENALTY` | routeEdges.ts | 직선 선호 / 포트 조합의 교차 회피 |
| `LBL_MAX` | labelPlacement.ts | 라벨 줄바꿈 폭 (RoutedEdge CSS와 미러) |

동률이 나오면 수치로 정하지 말고 dev 서버에서 한 값씩 적용해 시각 판단으로 고를 것.
