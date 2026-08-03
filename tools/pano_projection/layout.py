"""
layout.py
=========
사용자가 파노라마 이미지에서 '각 모서리를 클릭'해 만든 바닥/천장 경계선으로부터
실제 방 형상(수직벽 프리즘)을 복원한다.

원리 ("경계를 fold line 으로 접기"):
    - 카메라는 panoCamPos = (0, h, 0).
    - 바닥 경계 코너 픽셀 -> 방향 d (아래로, dy<0) -> 바닥 y=0 과 교차:
          t = -h / dy,  P = (t*dx, 0, t*dz)
      => 그 방위각에서 벽 base 의 실제 (x, z). 모든 코너를 모으면 바닥 외곽 폴리곤.
    - 천장 높이 H: 같은 코너 위 수직벽이라고 보면, 그 코너까지 수평거리 R 과
      천장 경계 ray 의 올려본각으로  H = h + R * tan(elev)  (코너별 평균).

깊이(거리)는 카메라 높이 h 가 있어야 정해진다. 접는 각도만으론 깊이가 모호하기 때문.
"""
from __future__ import annotations

from dataclasses import dataclass

import numpy as np

from .projection import equirect_to_direction


@dataclass
class RoomLayout:
    """일반 다각형 방. footprint=(N,2) (x,z), height=H, camera_height=h."""
    footprint: np.ndarray
    height: float
    camera_height: float

    @property
    def pano_cam_pos(self) -> np.ndarray:
        return np.array([0.0, self.camera_height, 0.0], dtype=np.float64)

    @property
    def bbox(self):
        f = np.asarray(self.footprint)
        return f[:, 0].min(), f[:, 0].max(), f[:, 1].min(), f[:, 1].max()

    @staticmethod
    def rectangle(width: float, depth: float, height: float, camera_height: float):
        """직사각형 방을 4코너 폴리곤으로 (box 호환)."""
        w, d = width / 2.0, depth / 2.0
        fp = np.array([[-w, -d], [w, -d], [w, d], [-w, d]], dtype=np.float64)
        return RoomLayout(footprint=fp, height=height, camera_height=camera_height)


def floor_boundary_to_footprint(uv_points, pano_w: int, pano_h: int,
                                camera_height: float) -> np.ndarray:
    """
    바닥 경계 코너 픽셀 (N,2) -> 바닥 외곽 폴리곤 (M,2) (x,z).
    아래를 향하지 않는(수평선 위) 점은 제외한다.
    """
    uv = np.asarray(uv_points, dtype=np.float64).reshape(-1, 2)
    dirs = equirect_to_direction(uv[:, 0], uv[:, 1], pano_w, pano_h)  # (N,3) 단위
    dy = dirs[:, 1]
    valid = dy < -1e-4                       # 바닥 경계는 시선이 아래
    t = np.where(valid, -camera_height / dy, np.nan)
    x = t * dirs[:, 0]
    z = t * dirs[:, 2]
    fp = np.stack([x, z], axis=-1)[valid]
    return fp


def ceiling_height_from_boundary(uv_ceiling, footprint, pano_w: int, pano_h: int,
                                 camera_height: float) -> float:
    """
    천장 경계 코너 (N,2) 와 (대응하는) 바닥 footprint 로부터 방 높이 H 를 추정.
    천장 코너는 바닥 코너 바로 위(수직벽)라고 가정.
    H = camera_height + R * tan(elev),  R = 해당 코너 수평거리.
    """
    uv = np.asarray(uv_ceiling, dtype=np.float64).reshape(-1, 2)
    dirs = equirect_to_direction(uv[:, 0], uv[:, 1], pano_w, pano_h)
    dy = dirs[:, 1]
    rho = np.sqrt(dirs[:, 0] ** 2 + dirs[:, 2] ** 2) + 1e-12
    elev = dy / rho                          # tan(elevation), 위를 보면 +

    fp = np.asarray(footprint, dtype=np.float64)
    m = min(len(uv), len(fp))
    if m == 0:
        return camera_height * 2.0
    R = np.sqrt(fp[:m, 0] ** 2 + fp[:m, 1] ** 2)
    up = dy[:m] > 1e-4
    H = camera_height + R[up] * elev[:m][up]
    if H.size == 0:
        return camera_height * 2.0
    return float(np.median(H))


def layout_from_annotation(floor_uv, ceiling_uv, pano_w: int, pano_h: int,
                           camera_height: float) -> RoomLayout:
    """어노테이션(바닥/천장 경계 코너) -> RoomLayout."""
    footprint = floor_boundary_to_footprint(floor_uv, pano_w, pano_h, camera_height)
    if len(footprint) < 3:
        raise ValueError("바닥 경계 코너가 최소 3개(아래를 향하는) 필요합니다.")
    if ceiling_uv is not None and len(ceiling_uv) > 0:
        height = ceiling_height_from_boundary(ceiling_uv, footprint, pano_w, pano_h, camera_height)
    else:
        height = camera_height * 2.0
    return RoomLayout(footprint=footprint, height=height, camera_height=camera_height)
