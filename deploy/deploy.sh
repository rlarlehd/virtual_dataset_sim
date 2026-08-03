#!/usr/bin/env bash
# =============================================================================
# deploy.sh — 사내 온프레미스 Linux 서버 배포 스크립트 (단일 프로세스: FastAPI + SPA)
#
# 최초 1회 세팅 이후, 코드 갱신 시마다 이 스크립트만 다시 실행하면 됨:
#   프론트 빌드 → 파이썬 의존성 설치 → systemd 서비스 재시작
#
# 전제:
#   - 이 저장소가 $APP_DIR 에 clone/복사 되어 있음
#   - python3.11, node(18+), npm, ffmpeg 가 설치되어 있음
#   - deploy/virtual-dataset.service 를 /etc/systemd/system/ 에 설치했음(최초 1회)
# =============================================================================
set -euo pipefail

APP_DIR="${APP_DIR:-/opt/virtual_dataset}"
SERVICE="${SERVICE:-virtual-dataset}"

cd "$APP_DIR"

echo "==> [1/4] Python 가상환경 준비 및 의존성 설치"
if [ ! -d .venv ]; then
  python3.11 -m venv .venv
fi
# shellcheck disable=SC1091
source .venv/bin/activate
pip install --upgrade pip
pip install -r requirements.txt

echo "==> [2/4] 프론트엔드 빌드 (web/dist 생성)"
cd web
npm ci
npm run build
cd ..

echo "==> [3/4] ffmpeg 확인"
command -v ffmpeg >/dev/null 2>&1 && echo "    ffmpeg OK" || echo "    ⚠ ffmpeg 없음 — /api/detect 트랜스코드가 실패함"

echo "==> [4/4] systemd 서비스 재시작"
sudo systemctl restart "$SERVICE"
sudo systemctl --no-pager status "$SERVICE" | head -n 10

echo
echo "완료. http://<서버IP>:8000 로 접속하세요. (API + 뷰어 동일 오리진)"
