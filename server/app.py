"""
server/app.py
=============
프론트엔드(React+Three.js)와 Python 코어(tools.pano_projection)를 잇는 FastAPI 브리지.

엔드포인트
----------
POST /api/upload            : 파노라마 업로드 (2:1 검사) -> {id, width, height, ratioOk}
GET  /api/image/{id}        : 원본 파노라마 서빙
POST /api/layout            : 경계 어노테이션 -> 복원된 다각형 방 {footprint, height}
POST /api/bake-textures     : 6면+벽 텍스처 bake -> {textures:[{name,url}], masks:[...]}
GET  /api/asset/{id}/{name} : bake 결과 텍스처/마스크 서빙
POST /api/render-view       : 임의 CCTV 프레임 고품질 렌더 -> image/png
POST /api/save-project      : 프로젝트 JSON 저장
GET  /api/load-project/{id} : 프로젝트 JSON 로드
POST /api/save-crops        : 현재 화각 객체 crop 저장(MSMT17 스타일 pid/cam/frame)

실행:  (part3 디렉토리에서)
    ../.venv/Scripts/python -m uvicorn server.app:app --reload --port 8000
"""
from __future__ import annotations

import base64
import io
import json
import os
import random
import re
import shutil
import subprocess
import sys
import uuid

import cv2
import numpy as np
from fastapi import FastAPI, File, UploadFile, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse, StreamingResponse
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel

# part3 를 import 루트로
HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)
if ROOT not in sys.path:
    sys.path.insert(0, ROOT)

from tools.pano_projection.layout import (
    RoomLayout, layout_from_annotation,
)
from tools.pano_projection.room_render import (
    VirtualCamera, render_virtual_view, cctv_presets,
)
from tools.pano_projection.generate_textures import bake_all
from tools.pano_projection.filters import sharpen_image, apply_barrel_distortion
from tools.pano_projection.imgio import imread_u, imwrite_u

# 런타임 산출물 경로. 도커/서버 배포 시 APP_DATA_DIR 로 오버라이드(예: /data).
DATA = os.environ.get("APP_DATA_DIR") or os.path.join(HERE, "data")
UPLOADS = os.path.join(DATA, "uploads")
ASSETS = os.path.join(DATA, "assets")
PROJECTS = os.path.join(DATA, "projects")
CROPS = os.path.join(DATA, "crops")
# GLB 인물 풀 폴더 — 기본 {DATA}/glb (컨테이너에선 /data/glb). APP_GLB_DIR 로 오버라이드.
GLB = os.environ.get("APP_GLB_DIR") or os.path.join(DATA, "glb")
for d in (UPLOADS, ASSETS, PROJECTS, CROPS, GLB):
    os.makedirs(d, exist_ok=True)

# 저장된 맵(JSON) 폴더 — 기본 프로젝트 루트/maps (camid = 정렬 인덱스).
# 도커/서버 배포 시 APP_MAPS_DIR 로 오버라이드(예: /data/maps).
MAPS = os.environ.get("APP_MAPS_DIR") or os.path.join(ROOT, "maps")
os.makedirs(MAPS, exist_ok=True)

app = FastAPI(title="360 Pano CCTV View Synthesizer")
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_methods=["*"],
    allow_headers=["*"],
)

# 간단한 이미지 캐시 (id -> ndarray)
_cache: dict[str, np.ndarray] = {}


def _img_path(image_id: str) -> str:
    for ext in (".jpg", ".png", ".webp", ".jpeg"):
        p = os.path.join(UPLOADS, image_id + ext)
        if os.path.exists(p):
            return p
    raise HTTPException(404, f"image not found: {image_id}")


def _load_pano(image_id: str) -> np.ndarray:
    if image_id in _cache:
        return _cache[image_id]
    pano = imread_u(_img_path(image_id), cv2.IMREAD_COLOR)
    if pano is None:
        raise HTTPException(404, "cannot read image")
    _cache[image_id] = pano
    return pano


# --------------------------------------------------------------------------- models
class AnnotationModel(BaseModel):
    floorBoundary: list[list[float]] = []
    ceilingBoundary: list[list[float]] = []
    forwardYawDeg: float = 0.0


class LayoutRequest(BaseModel):
    image_id: str
    annotation: AnnotationModel
    cameraHeight: float = 1.5
    # 폴백: 직사각형
    rect: list[float] | None = None


class CameraModel(BaseModel):
    position: list[float] = [0.0, 1.5, 0.0]
    yawDeg: float = 0.0
    pitchDeg: float = 0.0
    rollDeg: float = 0.0
    fovDeg: float = 70.0
    width: int = 1280
    height: int = 720


class RenderRequest(LayoutRequest):
    camera: CameraModel = CameraModel()
    sharpen: bool = False
    barrel: float = 0.0


class BakeRequest(LayoutRequest):
    floorSize: int = 1024
    wallHeight: int = 512
    sharpen: bool = False


# --------------------------------------------------------------------------- helpers
def _build_layout(req: LayoutRequest, pano_w: int, pano_h: int) -> RoomLayout:
    ann = req.annotation
    if ann.floorBoundary and len(ann.floorBoundary) >= 3:
        return layout_from_annotation(ann.floorBoundary, ann.ceilingBoundary,
                                      pano_w, pano_h, req.cameraHeight)
    if req.rect:
        w, d, h = req.rect
        return RoomLayout.rectangle(w, d, h, req.cameraHeight)
    raise HTTPException(400, "floorBoundary(>=3) 또는 rect 가 필요합니다.")


# --------------------------------------------------------------------------- routes
@app.post("/api/upload")
async def upload(file: UploadFile = File(...)):
    ext = os.path.splitext(file.filename or "")[1].lower() or ".jpg"
    if ext not in (".jpg", ".jpeg", ".png", ".webp"):
        raise HTTPException(400, "지원하지 않는 형식 (jpg/png/webp)")
    image_id = uuid.uuid4().hex[:12]
    raw = await file.read()
    arr = cv2.imdecode(np.frombuffer(raw, np.uint8), cv2.IMREAD_COLOR)
    if arr is None:
        raise HTTPException(400, "이미지 디코딩 실패")
    path = os.path.join(UPLOADS, image_id + ext)
    with open(path, "wb") as f:
        f.write(raw)
    _cache[image_id] = arr
    h, w = arr.shape[:2]
    return {"id": image_id, "filename": file.filename, "width": w, "height": h,
            "ratioOk": abs(w / h - 2.0) <= 0.05}


@app.get("/api/image/{image_id}")
def get_image(image_id: str):
    return FileResponse(_img_path(image_id))


@app.post("/api/layout")
def post_layout(req: LayoutRequest):
    pano = _load_pano(req.image_id)
    h, w = pano.shape[:2]
    layout = _build_layout(req, w, h)
    return {
        "footprint": np.asarray(layout.footprint).round(4).tolist(),
        "height": round(layout.height, 4),
        "cameraHeight": round(layout.camera_height, 4),
        "walls": len(layout.footprint),
    }


@app.post("/api/bake-textures")
def post_bake(req: BakeRequest):
    pano = _load_pano(req.image_id)
    h, w = pano.shape[:2]
    layout = _build_layout(req, w, h)
    textures, masks = bake_all(pano, layout, floor_size=req.floorSize,
                               wall_h=req.wallHeight, with_masks=True)
    out_dir = os.path.join(ASSETS, req.image_id)
    os.makedirs(out_dir, exist_ok=True)

    tex_list, mask_list = [], []
    for name, img in textures.items():
        if req.sharpen:
            img = sharpen_image(img, 1.0)
        imwrite_u(os.path.join(out_dir, f"{name}.png"), img)
        tex_list.append({"name": name, "url": f"/api/asset/{req.image_id}/{name}.png"})
    for name, m in masks.items():
        imwrite_u(os.path.join(out_dir, f"{name}_confidence.png"), m)
        mask_list.append({"name": name, "url": f"/api/asset/{req.image_id}/{name}_confidence.png"})

    return {
        "footprint": np.asarray(layout.footprint).round(4).tolist(),
        "height": round(layout.height, 4),
        "cameraHeight": round(layout.camera_height, 4),
        "textures": tex_list,
        "masks": mask_list,
    }


@app.get("/api/asset/{image_id}/{name}")
def get_asset(image_id: str, name: str):
    p = os.path.join(ASSETS, image_id, name)
    if not os.path.exists(p):
        raise HTTPException(404, "asset not found")
    return FileResponse(p)


@app.post("/api/render-view")
def post_render(req: RenderRequest):
    pano = _load_pano(req.image_id)
    h, w = pano.shape[:2]
    layout = _build_layout(req, w, h)
    c = req.camera
    vcam = VirtualCamera(position=tuple(c.position), yaw_deg=c.yawDeg,
                         pitch_deg=c.pitchDeg, roll_deg=c.rollDeg, fov_deg=c.fovDeg,
                         out_w=c.width, out_h=c.height)
    frame, _mask = render_virtual_view(pano, layout, vcam)
    if req.sharpen:
        frame = sharpen_image(frame, 1.0)
    if req.barrel != 0.0:
        frame = apply_barrel_distortion(frame, k1=req.barrel)
    ok, buf = cv2.imencode(".png", frame)
    if not ok:
        raise HTTPException(500, "encode 실패")
    return StreamingResponse(io.BytesIO(buf.tobytes()), media_type="image/png")


@app.get("/api/presets")
def get_presets(image_id: str, cameraHeight: float = 1.5,
                w: float = 6.0, d: float = 6.0, ht: float = 3.0):
    layout = RoomLayout.rectangle(w, d, ht, cameraHeight)
    presets = cctv_presets(layout)
    return {name: {
        "position": list(vc.position), "yawDeg": vc.yaw_deg,
        "pitchDeg": vc.pitch_deg, "rollDeg": vc.roll_deg, "fovDeg": vc.fov_deg,
    } for name, vc in presets.items()}


@app.post("/api/save-project")
def save_project(project: dict):
    pid = project.get("id") or uuid.uuid4().hex[:12]
    project["id"] = pid
    with open(os.path.join(PROJECTS, pid + ".json"), "w", encoding="utf-8") as f:
        json.dump(project, f, indent=2, ensure_ascii=False)
    return {"id": pid}


@app.get("/api/maps")
def list_maps():
    """maps/ 폴더의 맵 JSON 목록. camid = 파일명 정렬 인덱스(맵=카메라)."""
    if not os.path.isdir(MAPS):
        return {"maps": []}
    names = sorted(f for f in os.listdir(MAPS) if f.lower().endswith(".json"))
    return {"maps": [{"name": n, "camid": i} for i, n in enumerate(names)]}


@app.get("/api/maps/{name}")
def get_map(name: str):
    safe = os.path.basename(name)   # path traversal 방지
    p = os.path.join(MAPS, safe)
    if not os.path.exists(p):
        raise HTTPException(404, "map not found")
    with open(p, "r", encoding="utf-8") as f:
        return json.load(f)


class SaveMapRequest(BaseModel):
    name: str          # 맵 이름(.json 없이도 됨)
    map: dict          # vd-room-map JSON


@app.post("/api/save-map")
def save_map(req: SaveMapRequest):
    """맵을 서버 MAPS(=/data/maps) 폴더에 `이름.json` 으로 저장(브라우저 다운로드 대신)."""
    base = os.path.basename(req.name.strip())            # path traversal 방지
    base = re.sub(r"\.json$", "", base, flags=re.I)
    base = re.sub(r'[<>:"/\\|?*]', "_", base).strip()    # 파일명 금지문자 제거
    if not base:
        raise HTTPException(400, "맵 이름이 비었습니다")
    fn = base + ".json"
    with open(os.path.join(MAPS, fn), "w", encoding="utf-8") as f:
        json.dump(req.map, f, indent=2, ensure_ascii=False)
    # camid = 저장 후 정렬 인덱스
    names = sorted(x for x in os.listdir(MAPS) if x.lower().endswith(".json"))
    return {"name": fn, "camid": names.index(fn), "saved": True}


@app.delete("/api/maps/{name}")
def delete_map(name: str):
    """맵 JSON 삭제 + 이 맵이 쓰던 텍스처(assets/{image_id}) 및 원본 업로드 삭제.
    같은 image_id 를 다른 맵이 계속 쓰면 텍스처는 남긴다."""
    safe = os.path.basename(name)                  # path traversal 방지
    p = os.path.join(MAPS, safe)
    if not os.path.exists(p):
        raise HTTPException(404, "map not found")

    image_id = None
    try:
        with open(p, "r", encoding="utf-8") as f:
            image_id = json.load(f).get("image_id")
    except Exception:
        pass

    os.remove(p)

    removed_textures = False
    if image_id:
        # 다른 맵이 같은 image_id 를 쓰는지 확인
        still_used = False
        for x in os.listdir(MAPS):
            if not x.lower().endswith(".json"):
                continue
            try:
                with open(os.path.join(MAPS, x), "r", encoding="utf-8") as f:
                    if json.load(f).get("image_id") == image_id:
                        still_used = True
                        break
            except Exception:
                pass
        if not still_used:
            adir = os.path.join(ASSETS, str(image_id))
            if os.path.isdir(adir):
                shutil.rmtree(adir, ignore_errors=True)
                removed_textures = True
            # 원본 업로드(파노라마)도 함께 정리
            for ext in (".jpg", ".jpeg", ".png", ".webp"):
                up = os.path.join(UPLOADS, str(image_id) + ext)
                if os.path.exists(up):
                    try:
                        os.remove(up)
                    except OSError:
                        pass
            _cache.pop(str(image_id), None)

    return {"deleted": safe, "removedTextures": removed_textures,
            "imageId": image_id, "textureShared": bool(image_id) and not removed_textures}


@app.get("/api/glb")
def list_glb():
    """GLB 인물 풀 폴더(/data/glb)의 파일 목록. 프론트가 전부 로드해 풀로 사용."""
    if not os.path.isdir(GLB):
        return {"files": []}
    files = sorted(f for f in os.listdir(GLB) if f.lower().endswith((".glb", ".gltf")))
    return {"files": files}


@app.get("/api/glb/{name}")
def get_glb(name: str):
    safe = os.path.basename(name)   # path traversal 방지
    p = os.path.join(GLB, safe)
    if not os.path.exists(p):
        raise HTTPException(404, "glb not found")
    return FileResponse(p, media_type="model/gltf-binary")


@app.get("/api/load-project/{pid}")
def load_project(pid: str):
    p = os.path.join(PROJECTS, pid + ".json")
    if not os.path.exists(p):
        raise HTTPException(404, "project not found")
    with open(p, "r", encoding="utf-8") as f:
        return json.load(f)


# --------------------------------------------------------------------------- crop 추출/저장
class CropItem(BaseModel):
    pid: int = 0          # 인스턴스 신원 ID
    cam: int = 0          # 카메라(맵) 번호
    frame: int = 0        # 프레임 번호
    x: int = 0
    y: int = 0
    w: int = 0
    h: int = 0
    dataUrl: str          # "data:image/png;base64,...."


class SaveCropsRequest(BaseModel):
    mapId: str = "map"
    crops: list[CropItem] = []


_DATAURL_RE = re.compile(r"^data:image/(\w+);base64,(.*)$", re.S)


@app.post("/api/save-crops")
def save_crops(req: SaveCropsRequest):
    """
    현재 화각에 보이는 객체 crop 을 MSMT17 스타일 파일명(`{pid}_c{cam}_f{frame}.png`)으로 저장.
    맵(=카메라)별 폴더 `data/crops/{mapId}/` 에 쌓고, `data/crops/list_{mapId}.txt` 에
    `상대경로 pid cam` 을 append 한다.
    """
    safe = re.sub(r"[^A-Za-z0-9_-]", "_", req.mapId) or "map"
    out_dir = os.path.join(CROPS, safe)
    os.makedirs(out_dir, exist_ok=True)

    lines: list[str] = []
    saved = 0
    for it in req.crops:
        m = _DATAURL_RE.match(it.dataUrl)
        mime = m.group(1).lower() if m else "png"
        b64 = m.group(2) if m else it.dataUrl
        ext = "jpg" if mime in ("jpeg", "jpg") else mime
        try:
            raw = base64.b64decode(b64)
        except Exception:
            continue
        fn = f"{it.pid:04d}_c{it.cam:02d}_f{it.frame:06d}.{ext}"
        with open(os.path.join(out_dir, fn), "wb") as f:
            f.write(raw)
        lines.append(f"{safe}/{fn} {it.pid} {it.cam}")
        saved += 1

    if lines:
        with open(os.path.join(CROPS, f"list_{safe}.txt"), "a", encoding="utf-8") as f:
            f.write("\n".join(lines) + "\n")

    return {"saved": saved, "dir": os.path.relpath(out_dir, DATA).replace("\\", "/")}


# --------------------------------------------------------------------------- MSMT17 조립
class BuildMsmtRequest(BaseModel):
    trainRatio: float = 0.9      # 신원 train 비율(나머지 test)
    out: str = "msmt_out"
    seed: int = 12345
    clearCrops: bool = False     # 조립 후 원본 crop 폴더 비우기


_CROP_RE = re.compile(r"^(\d+)_c(\d+)_f(\d+)\.(jpg|jpeg|png)$", re.I)


@app.post("/api/build-msmt")
def build_msmt(req: BuildMsmtRequest):
    """
    data/crops/ 아래 모든 crop 을 스캔 → 신원 train/test 분할(trainRatio) →
    test 는 (pid,cam)당 1장 query·나머지 gallery → MSMT17 형태로 조립.
    파일명 {pid:06d}_c{cam:03d}_{idx:07d}.jpg, list_train/query/gallery.txt = "경로 pid camid".
    """
    samples: list[tuple[int, int, str]] = []   # (pid, cam, src)
    for root, _dirs, files in os.walk(CROPS):
        for fn in files:
            m = _CROP_RE.match(fn)
            if m:
                samples.append((int(m.group(1)), int(m.group(2)), os.path.join(root, fn)))
    if not samples:
        raise HTTPException(400, "crops 없음 — 먼저 캡처하세요")

    pids = sorted({s[0] for s in samples})
    shuffled = pids[:]
    random.Random(req.seed).shuffle(shuffled)
    n_train = max(1, min(len(shuffled), int(round(len(shuffled) * req.trainRatio))))
    train_pids = set(shuffled[:n_train])

    out_dir = os.path.join(DATA, re.sub(r"[^A-Za-z0-9_-]", "_", req.out) or "msmt_out")
    if os.path.exists(out_dir):
        shutil.rmtree(out_dir)
    train_dir = os.path.join(out_dir, "train")
    test_dir = os.path.join(out_dir, "test")
    os.makedirs(train_dir); os.makedirs(test_dir)

    idx = 0
    train_lines: list[str] = []
    test_by_pidcam: dict[tuple[int, int], list[str]] = {}
    for pid, cam, src in samples:
        ext = os.path.splitext(src)[1].lower().lstrip(".")
        ext = "jpg" if ext == "jpeg" else ext
        newname = f"{pid:06d}_c{cam:03d}_{idx:07d}.{ext}"
        idx += 1
        if pid in train_pids:
            shutil.copy2(src, os.path.join(train_dir, newname))
            train_lines.append(f"train/{newname} {pid} {cam}")
        else:
            shutil.copy2(src, os.path.join(test_dir, newname))
            test_by_pidcam.setdefault((pid, cam), []).append(f"test/{newname}")

    query_lines: list[str] = []
    gallery_lines: list[str] = []
    for (pid, cam), rels in test_by_pidcam.items():
        query_lines.append(f"{rels[0]} {pid} {cam}")               # (pid,cam)당 1장 query
        gallery_lines.extend(f"{r} {pid} {cam}" for r in rels[1:])  # 나머지 gallery

    def _write(name: str, lines: list[str]) -> None:
        with open(os.path.join(out_dir, name), "w", encoding="utf-8") as f:
            f.write("\n".join(lines) + ("\n" if lines else ""))
    _write("list_train.txt", train_lines)
    _write("list_query.txt", query_lines)
    _write("list_gallery.txt", gallery_lines)

    if req.clearCrops:
        for root, _dirs, files in os.walk(CROPS):
            for fn in files:
                if _CROP_RE.match(fn) or fn.startswith("list_"):
                    try:
                        os.remove(os.path.join(root, fn))
                    except OSError:
                        pass

    return {
        "out": os.path.relpath(out_dir, DATA).replace("\\", "/"),
        "pids": len(pids), "train_pids": len(train_pids), "test_pids": len(pids) - len(train_pids),
        "train_imgs": len(train_lines), "query": len(query_lines), "gallery": len(gallery_lines),
    }


# --------------------------------------------------------------------------- YOLOv8 검출
_yolo = None


def _get_yolo():
    """YOLOv8 모델 lazy 로드 (yolov8n.pt, 없으면 자동 다운로드)."""
    global _yolo
    if _yolo is None:
        from ultralytics import YOLO
        local = os.path.join(HERE, "yolov8n.pt")
        _yolo = YOLO(local if os.path.exists(local) else "yolov8n.pt")
    return _yolo


@app.post("/api/detect")
async def detect(file: UploadFile = File(...), conf: float = 0.3, maxFrames: int = 900):
    """
    녹화 영상(webm 등) → 프레임별 사람(class 0) bbox.
    반환: {fps, width, height, nframes, frames: [[[x1,y1,x2,y2,conf],...], ...]}
    """
    try:
        model = _get_yolo()
    except Exception as e:  # ultralytics 미설치 등
        raise HTTPException(503, f"YOLOv8 준비 안됨: {e}")

    uid = uuid.uuid4().hex[:8]
    src = os.path.join(UPLOADS, f"rec_{uid}.webm")
    with open(src, "wb") as f:
        f.write(await file.read())

    # webm -> mp4 (cv2 안정 디코드용). 실패하면 원본으로 시도.
    mp4 = os.path.join(UPLOADS, f"rec_{uid}.mp4")
    path = src
    try:
        # -r 30 로 고정 프레임레이트(CFR) 강제 → 프레임과 재생 시간이 일치(오버레이 싱크)
        subprocess.run(["ffmpeg", "-y", "-i", src, "-an", "-r", "30",
                        "-fps_mode", "cfr", "-c:v", "libx264",
                        "-pix_fmt", "yuv420p", mp4],
                       capture_output=True, check=True)
        path = mp4
    except Exception:
        pass

    cap = cv2.VideoCapture(path)
    if not cap.isOpened():
        raise HTTPException(400, "영상 디코드 실패")
    fps = cap.get(cv2.CAP_PROP_FPS) or 30.0
    w = int(cap.get(cv2.CAP_PROP_FRAME_WIDTH))
    h = int(cap.get(cv2.CAP_PROP_FRAME_HEIGHT))

    frames: list[list[list[float]]] = []
    while len(frames) < maxFrames:
        ok, fr = cap.read()
        if not ok:
            break
        res = model.predict(fr, classes=[0], conf=conf, verbose=False)[0]
        boxes: list[list[float]] = []
        for b in res.boxes:
            x1, y1, x2, y2 = (int(round(v)) for v in b.xyxy[0].tolist())
            boxes.append([x1, y1, x2, y2, round(float(b.conf[0]), 3)])
        frames.append(boxes)
    cap.release()
    return {"fps": round(float(fps), 3), "width": w, "height": h,
            "nframes": len(frames), "frames": frames}


@app.get("/api/health")
def health():
    return {"ok": True}


# --------------------------------------------------------------------------- 정적 프론트엔드(SPA)
# 프로덕션 배포: `web/` 를 빌드(`npm run build`)하면 web/dist 가 생성됨.
# 존재하면 빌드된 SPA 를 "/" 에 마운트해서 API 와 같은 오리진(단일 포트)으로 서빙한다.
# (개발 중에는 dist 가 없으므로 마운트하지 않음 → Vite dev 서버의 /api 프록시를 그대로 사용)
# 이 마운트는 catch-all 이라 반드시 모든 /api 라우트 등록 뒤에 와야 한다.
_DIST = os.path.join(ROOT, "web", "dist")
if os.path.isdir(_DIST):
    app.mount("/", StaticFiles(directory=_DIST, html=True), name="spa")
