# =============================================================================
# Virtual Dataset — 단일 이미지 배포 (FastAPI + 빌드된 SPA 를 한 포트로 서빙)
#   Stage 1: web(React/Vite) 빌드 → /web/dist
#   Stage 2: python 런타임 (torch/ultralytics/opencv/ffmpeg) + 앱 + dist
# =============================================================================

# ---- Stage 1: 프론트엔드 빌드 ----
FROM node:22-bookworm-slim AS webbuild
WORKDIR /web
COPY web/package.json web/package-lock.json ./
# npm ci 대신 install: 로컬 lock 이 Windows 에서 생성되어 Linux 전용 네이티브
# 옵션 의존성(@emnapi/* 등)이 빠져 있으므로 컨테이너에서 새로 해석한다.
RUN npm install --no-audit --no-fund
COPY web/ ./
RUN npm run build          # → /web/dist

# ---- Stage 2: 파이썬 런타임 ----
FROM python:3.11-slim AS runtime

# opencv-python 런타임 라이브러리(libGL/glib) + ffmpeg(/api/detect webm→mp4)
RUN apt-get update && apt-get install -y --no-install-recommends \
        ffmpeg libgl1 libglib2.0-0 \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# 파이썬 의존성 (torch 가 커서 이 레이어가 가장 오래 걸림 — 캐시 활용 위해 먼저 복사)
COPY requirements.txt ./
RUN pip install --no-cache-dir -r requirements.txt

# 앱 코드 + 코어 + YOLO 가중치(server/yolov8n.pt) + 빌드된 프론트
COPY server/ ./server/
COPY tools/ ./tools/
COPY --from=webbuild /web/dist ./web/dist

# 런타임 산출물/맵은 /data 볼륨으로 (compose 에서 마운트)
ENV APP_DATA_DIR=/data \
    APP_MAPS_DIR=/data/maps
VOLUME ["/data/datasets/virtual_dataset"]

EXPOSE 8086
# 단일 워커: torch 모델이 워커마다 메모리를 크게 잡음(사내 도구 기준).
CMD ["python", "-m", "uvicorn", "server.app:app", "--host", "0.0.0.0", "--port", "8086"]
