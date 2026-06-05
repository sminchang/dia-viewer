#!/usr/bin/env bash
# 상수 스윕 러너 — 각 후보를 적용해 metrics를 돌리고 원래 값으로 복원.
# 사용법: scripts/sweep.sh <파일> <상수명> "<후보들>" [매니페스트] [off]
set -euo pipefail
FILE="$1"; NAME="$2"; CANDS="$3"; MANIFEST="${4:-}"; MODE="${5:-}"
ORIG=$(grep -oE "const ${NAME} = [0-9.]+" "$FILE" | grep -oE "[0-9.]+$")
[ -n "$ORIG" ] || { echo "상수 ${NAME}을 ${FILE}에서 찾지 못함"; exit 1; }
restore() { sed -i "s/const ${NAME} = [0-9.]*;/const ${NAME} = ${ORIG};/" "$FILE"; }
trap restore EXIT
for v in $CANDS; do
  sed -i "s/const ${NAME} = [0-9.]*;/const ${NAME} = ${v};/" "$FILE"
  printf "%s=%-6s " "$NAME" "$v"
  npm run metrics --silent -- ${MANIFEST:+"$MANIFEST"} ${MODE:+"$MODE"} 2>&1 | grep -E "hard|soft" | tr '\n' ' '
  echo
done
echo "(${NAME}을 원래 값 ${ORIG}으로 복원)"
