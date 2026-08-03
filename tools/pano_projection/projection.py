"""
projection.py
=============
Equirectangular panorama <-> 3D direction-vector 변환과 ray-box 교차 등
모든 텍스처/뷰 생성이 공유하는 저수준 기하 함수.

좌표계 (Three.js 규약, spec §5):
    x: 좌우(+오른쪽), y: 높이(+위), z: 전후(+앞)
    바닥 y=0, 천장 y=roomHeight
    파노라마 촬영 카메라 위치 panoCamPos = (0, cameraHeight, 0)

equirectangular 규약 (part2/main.py 와 동일):
    lon = atan2(x, z)               in [-pi, pi]
    lat = atan2(y, sqrt(x^2+z^2))   in [-pi/2, pi/2]
    u   = (lon / 2pi + 0.5) * W
    v   = (0.5 - lat / pi) * H
"""
from __future__ import annotations

import numpy as np


# ---------------------------------------------------------------------------
# direction vector  <->  equirectangular pixel
# ---------------------------------------------------------------------------
def direction_to_equirect(dirs: np.ndarray, pano_w: int, pano_h: int):
    """
    방향 벡터 배열을 equirectangular panorama의 (map_x, map_y)로 변환한다.

    dirs : (..., 3) float, 정규화 여부 무관 (lon/lat 가 atan2/sqrt로 흡수).
    return:
        map_x : float32, dirs.shape[:-1]
        map_y : float32, dirs.shape[:-1]
    """
    x = dirs[..., 0]
    y = dirs[..., 1]
    z = dirs[..., 2]

    lon = np.arctan2(x, z)
    lat = np.arctan2(y, np.sqrt(x * x + z * z))

    map_x = (lon / (2.0 * np.pi) + 0.5) * pano_w
    map_y = (0.5 - lat / np.pi) * pano_h
    return map_x.astype(np.float32), map_y.astype(np.float32)


def equirect_to_direction(u: np.ndarray, v: np.ndarray, pano_w: int, pano_h: int):
    """
    equirectangular 픽셀 (u, v)을 단위 방향 벡터로 변환한다.
    return: (..., 3) float64, 단위벡터.
    """
    u = np.asarray(u, dtype=np.float64)
    v = np.asarray(v, dtype=np.float64)
    lon = (u / pano_w - 0.5) * 2.0 * np.pi
    lat = (0.5 - v / pano_h) * np.pi
    dirs = np.stack([
        np.cos(lat) * np.sin(lon),
        np.sin(lat),
        np.cos(lat) * np.cos(lon),
    ], axis=-1)
    return dirs


# ---------------------------------------------------------------------------
# rotation matrix  (yaw -> pitch -> roll), part2/main.py 와 호환 + roll 추가
# ---------------------------------------------------------------------------
def rotation_matrix(yaw_deg: float, pitch_deg: float, roll_deg: float = 0.0) -> np.ndarray:
    """
    카메라 좌표 -> 월드 좌표 회전행렬 R.  world = R @ cam.

    part2/main.py 의 R = Ry(yaw) @ Rx(pitch) 규약을 그대로 따르고,
    roll(시선축 Z 회전)을 가장 안쪽에 추가한다: R = Ry @ Rx @ Rz.
        yaw   : +오른쪽
        pitch : +위 / -아래 (바닥을 보려면 음수)
        roll  : 시선축 회전
    """
    yaw = np.deg2rad(yaw_deg)
    pitch = np.deg2rad(pitch_deg)
    roll = np.deg2rad(roll_deg)

    cp, sp = np.cos(pitch), np.sin(pitch)
    Rx = np.array([[1, 0, 0],
                   [0, cp, sp],
                   [0, -sp, cp]], dtype=np.float64)

    cy, sy = np.cos(yaw), np.sin(yaw)
    Ry = np.array([[cy, 0, sy],
                   [0, 1, 0],
                   [-sy, 0, cy]], dtype=np.float64)

    cr, sr = np.cos(roll), np.sin(roll)
    Rz = np.array([[cr, -sr, 0],
                   [sr, cr, 0],
                   [0, 0, 1]], dtype=np.float64)

    return Ry @ Rx @ Rz


# ---------------------------------------------------------------------------
# pinhole ray 생성
# ---------------------------------------------------------------------------
def make_camera_rays(out_w: int, out_h: int, fov_deg: float) -> np.ndarray:
    """
    perspective(pinhole) 카메라의 각 픽셀에 대한 카메라좌표 방향 ray 생성.
        focal = (out_w/2) / tan(fov/2)   (수평 FOV 기준)
        x: 오른쪽(+), y: 위(+), z: 정면(+)
    return: (out_h, out_w, 3) float64 (정규화 안 됨)
    """
    fov = np.deg2rad(fov_deg)
    focal = (out_w / 2.0) / np.tan(fov / 2.0)
    cx, cy = out_w / 2.0, out_h / 2.0

    j, i = np.meshgrid(np.arange(out_w), np.arange(out_h))
    x = (j - cx)
    y = -(i - cy)              # 영상 위쪽이 +y
    z = np.full_like(x, focal, dtype=np.float64)
    return np.stack([x.astype(np.float64), y.astype(np.float64), z], axis=-1)


# ---------------------------------------------------------------------------
# ray-box (AABB) 교차
# ---------------------------------------------------------------------------
def ray_box_exit(origin: np.ndarray, dirs: np.ndarray,
                 box_min: np.ndarray, box_max: np.ndarray):
    """
    axis-aligned box 내부의 점 origin 에서 방향 dirs 로 쏜 ray 가
    box 표면을 빠져나가는 지점(exit point)을 slab method 로 구한다.

    카메라가 방 '안'에 있을 때 ray 는 정확히 한 면에서 나가므로,
    exit point(t_far) 가 곧 그 ray 가 바라보는 벽/바닥/천장 위의 3D 점이다.

    origin : (3,) float
    dirs   : (..., 3) float
    box_min, box_max : (3,) float
    return:
        points : (..., 3) 교차점
        valid  : (...,) bool  (유효한 양의 교차)
    """
    origin = np.asarray(origin, dtype=np.float64)
    dirs = np.asarray(dirs, dtype=np.float64)

    # 0 division 방지
    safe = np.where(np.abs(dirs) < 1e-12, 1e-12, dirs)
    t1 = (box_min - origin) / safe          # (...,3)
    t2 = (box_max - origin) / safe
    t_near_axis = np.minimum(t1, t2)
    t_far_axis = np.maximum(t1, t2)

    t_far = np.min(t_far_axis, axis=-1)      # 가장 먼저 빠져나가는 면
    valid = t_far > 1e-9

    t_far_c = np.where(valid, t_far, 0.0)[..., None]
    points = origin + t_far_c * dirs
    return points, valid


# ---------------------------------------------------------------------------
# 일반 다각형(폴리곤) 관련: 사용자가 모서리를 찍어 만든 바닥/천장 경계 지원
# ---------------------------------------------------------------------------
def point_in_polygon(px: np.ndarray, pz: np.ndarray, poly: np.ndarray) -> np.ndarray:
    """
    xz 평면 다각형 내부 판정 (crossing number, 벡터화).
    px, pz : 같은 shape 의 좌표 배열
    poly   : (N, 2) 다각형 꼭짓점 (x, z) 순서대로 (닫힘 가정)
    return : bool, px.shape
    """
    px = np.asarray(px, dtype=np.float64)
    pz = np.asarray(pz, dtype=np.float64)
    inside = np.zeros(px.shape, dtype=bool)
    n = len(poly)
    j = n - 1
    for i in range(n):
        xi, zi = poly[i]
        xj, zj = poly[j]
        cond = ((zi > pz) != (zj > pz)) & \
               (px < (xj - xi) * (pz - zi) / ((zj - zi) + 1e-12) + xi)
        inside ^= cond
        j = i
    return inside


def ray_prism_hit(origin: np.ndarray, dirs: np.ndarray,
                  footprint: np.ndarray, height: float):
    """
    수직벽 프리즘(바닥 다각형 footprint 를 y=0..height 로 압출)과 ray 교차.

    카메라가 방 안에 있을 때, 각 ray 가 처음 만나는 면(바닥/천장/벽 중 가장 가까운 면)을
    선택한다 — 비볼록(L자, 갈림길) 형상도 가장 가까운 면을 고르므로 가림(occlusion) 처리됨.

    origin    : (3,) 카메라 위치
    dirs      : (..., 3) 월드 ray 방향
    footprint : (N, 2) 바닥 다각형 (x, z)
    height    : 천장 높이 H
    return:
        points : (..., 3) 교차점
        valid  : (...,) bool
        face   : (...,) int8  0=floor, 1=ceiling, 2+i=wall edge i, -1=miss
    """
    O = np.asarray(origin, dtype=np.float64)
    d = np.asarray(dirs, dtype=np.float64)
    Dx, Dy, Dz = d[..., 0], d[..., 1], d[..., 2]
    poly = np.asarray(footprint, dtype=np.float64)
    n = len(poly)

    cand_t = []
    cand_face = []

    with np.errstate(divide="ignore", invalid="ignore"):
        # floor (y=0)
        tf = (0.0 - O[1]) / Dy
        Pf = O + tf[..., None] * d
        okf = np.isfinite(tf) & (tf > 1e-9) & point_in_polygon(Pf[..., 0], Pf[..., 2], poly)
        cand_t.append(np.where(okf, tf, np.inf)); cand_face.append(0)

        # ceiling (y=H)
        tc = (height - O[1]) / Dy
        Pc = O + tc[..., None] * d
        okc = np.isfinite(tc) & (tc > 1e-9) & point_in_polygon(Pc[..., 0], Pc[..., 2], poly)
        cand_t.append(np.where(okc, tc, np.inf)); cand_face.append(1)

        # vertical walls (각 edge)
        for i in range(n):
            ax, az = poly[i]
            bx, bz = poly[(i + 1) % n]
            ex, ez = bx - ax, bz - az
            nx, nz = ez, -ex                      # xz 평면 법선(수평)
            denom = nx * Dx + nz * Dz
            num = nx * (ax - O[0]) + nz * (az - O[2])
            tw = num / denom
            Pw = O + tw[..., None] * d
            elen2 = ex * ex + ez * ez + 1e-12
            u = ((Pw[..., 0] - ax) * ex + (Pw[..., 2] - az) * ez) / elen2
            yok = (Pw[..., 1] >= -1e-6) & (Pw[..., 1] <= height + 1e-6)
            okw = np.isfinite(tw) & (tw > 1e-9) & (u >= -1e-6) & (u <= 1 + 1e-6) & yok
            cand_t.append(np.where(okw, tw, np.inf)); cand_face.append(2 + i)

    T = np.stack(cand_t, axis=0)                  # (F, ...)
    idx = np.argmin(T, axis=0)
    tmin = np.min(T, axis=0)
    valid = np.isfinite(tmin)

    face_lut = np.array(cand_face, dtype=np.int16)
    face = np.where(valid, face_lut[idx], -1).astype(np.int16)

    tsafe = np.where(valid, tmin, 0.0)
    points = O + tsafe[..., None] * d
    return points, valid, face
