# 배포 가이드 — 사내 온프레미스 Linux 서버 (사내망 전용)

프론트엔드를 빌드해 **FastAPI 한 프로세스가 정적 SPA + `/api` 를 같은 포트(:8000)로 서빙**하는
단일 서버 구성임. 리버스 프록시·CORS 설정이 필요 없음(프론트가 전부 상대경로 `/api/...` 호출).

> ⚠ **인증 없음 / 사내망 전용 전제.** 파일 업로드(`/api/upload`, `/api/detect`)와 임의 crop 저장이
> 무인증으로 열려 있으므로 **인터넷에 직접 노출하지 말 것.** 사내망/VPN 안에서만 접근되게 방화벽으로 :8000 을 제한.

---

## 1. 서버 사전 준비 (최초 1회)

```bash
# Python 3.11, Node 18+, ffmpeg 설치 (예: Ubuntu)
sudo apt update
sudo apt install -y python3.11 python3.11-venv ffmpeg
# Node 18+ (예: nodesource)
curl -fsSL https://deb.nodesource.com/setup_18.x | sudo -E bash -
sudo apt install -y nodejs

# 전용 계정 + 배포 디렉토리
sudo useradd -r -m -d /opt/virtual_dataset virtualds || true
sudo mkdir -p /opt/virtual_dataset
```

## 2. 코드 배치

```bash
# git 으로 받거나 rsync 로 복사
sudo -u virtualds git clone <REPO_URL> /opt/virtual_dataset
# (또는) rsync -av --exclude node_modules --exclude .venv --exclude web/dist ./ 서버:/opt/virtual_dataset/
sudo chown -R virtualds:virtualds /opt/virtual_dataset
```

## 3. systemd 서비스 등록 (최초 1회)

```bash
sudo cp /opt/virtual_dataset/deploy/virtual-dataset.service /etc/systemd/system/
# 필요 시 User/Group/WorkingDirectory/ExecStart 경로를 환경에 맞게 편집
sudo systemctl daemon-reload
sudo systemctl enable virtual-dataset
```

## 4. 빌드 + 기동 (배포/갱신 시마다)

```bash
sudo -u virtualds APP_DIR=/opt/virtual_dataset bash /opt/virtual_dataset/deploy/deploy.sh
```

이 스크립트가 ① venv+pip 설치 ② `npm ci && npm run build` (→ `web/dist`) ③ 서비스 재시작을 수행함.
`web/dist` 가 존재하면 `server/app.py` 가 자동으로 이를 `/` 에 마운트함.

## 5. 확인

```bash
curl http://localhost:8000/api/health      # {"ok": true}
```

브라우저에서 **http://<서버IP>:8000** 접속 → 뷰어가 뜨고 `/api/*` 가 동일 오리진으로 동작.

---

## 운영 메모

- **로그**: `journalctl -u virtual-dataset -f`
- **워커 수**: torch 모델이 워커마다 메모리를 크게 잡으므로 사내 단일 사용 기준 **1워커**로 둠.
  동시 사용자가 많다면 `--workers 2` 정도까지. YOLO 추론(CPU)은 느리니 GPU 서버면 CUDA torch 로 교체 권장.
- **런타임 산출물**: `server/data/`(업로드/bake/crops/msmt_out), `maps/` 는 서버 로컬에 쌓임 — 백업 대상.
- **디스크**: crop/영상이 누적되므로 주기적으로 `server/data/crops`, `server/data/uploads` 정리.

---

## 🐳 Docker 한 방 배포 (권장)

torch/opencv/ffmpeg 의존성이 이미지에 다 들어가므로 서버엔 **Docker만** 있으면 됨.
프론트 빌드도 이미지 안에서 수행(멀티스테이지) → `docker compose up` 한 번이면 끝.

```bash
# 서버에서 (저장소 배치 후)
cd /opt/virtual_dataset          # docker-compose.yml, Dockerfile 이 있는 위치
docker compose up -d --build
```

- 접속: **http://<서버IP>:8086** (외부 8086 → 컨테이너 8000, API + 뷰어 동일 오리진)
- 상태: `docker compose ps` (STATUS 가 `healthy` 면 정상)
- 로그: `docker compose logs -f`
- 갱신: 코드 pull 후 `docker compose up -d --build`
- 중지: `docker compose down`

**영구 저장(`/data/datasets` 볼륨)** — `docker-compose.yml` 이 호스트 `/data/datasets` 를 컨테이너 `/data` 로
마운트함. 런타임 산출물(uploads/assets/projects/crops/msmt_out)과 맵(`/data/maps` = 호스트
`/data/datasets/maps`)이 여기에 쌓임.

```bash
# 기존 maps 를 볼륨에 시드(최초 1회)
sudo mkdir -p /data/datasets/maps && sudo cp maps/*.json /data/datasets/maps/
```

> 다른 호스트 경로를 쓰려면 `docker-compose.yml` 의 `- /data/datasets:/data` 좌변만 바꾸면 됨(예: `/mnt/big:/data`).

**GLB 인물 풀** — 서버 `/data/glb`(호스트 `/data/datasets/glb`)의 모든 GLB 를 풀로 로드함.
서버 폴더에 GLB 를 넣어두고 뷰어의 **"GLB 풀 로드"** 버튼을 누르면 전부 로드됨.

```bash
# GLB 인물 풀 배치(예)
sudo mkdir -p /data/datasets/glb && sudo cp /경로/*.glb /data/datasets/glb/
```

> 로컬 PC 의 GLB 를 임시로 쓰려면 뷰어의 **"직접 선택"** 버튼으로 파일을 고를 수도 있음(서버 폴더와 무관).

---

## (선택) nginx 앞단

gzip/캐싱/포트 80 서빙이 필요하면 nginx 를 앞에 둘 수 있음:

```nginx
server {
    listen 80;
    server_name _;
    client_max_body_size 200m;   # 파노라마/영상 업로드 대비
    location / {
        proxy_pass http://127.0.0.1:8000;
        proxy_set_header Host $host;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
    }
}
```
