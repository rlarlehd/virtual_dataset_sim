"""
room_render.py
==============
★ 핵심: 360 파노라마 1장으로부터 방 안 '임의 위치/방향'의 가상 CCTV 프레임을 합성한다.

방 형상은 사용자가 모서리를 찍어 만든 일반 다각형(수직벽 프리즘) RoomLayout 으로 표현된다
(layout.py 참조). 직사각형 방은 RoomLayout.rectangle(...) 의 특수 경우.

파이프라인:
    화면 픽셀(i,j) -> 카메라좌표 ray -> R(yaw,pitch,roll) 월드 ray
      -> 프리즘(바닥/천장/벽)과 교차해 가장 가까운 면의 3D 점 P   (ray_prism_hit)
      -> dir = normalize(P - panoCamPos) -> equirect(u,v) -> cv2.remap
      -> CCTV 프레임 + confidence(거리) mask

기존 part2/main.py 의 equirectangular_to_perspective() 는 카메라가 원점 고정(회전만)이라
단순 360 crop 이었다. 여기서는 카메라 '위치 평행이동'을 더해 novel-view 를 만든다.
"""
from __future__ import annotations

from dataclasses import dataclass

import cv2
import numpy as np

from .projection import (
    direction_to_equirect,
    make_camera_rays,
    rotation_matrix,
    ray_prism_hit,
)
from .layout import RoomLayout
from .masks import distance_to_confidence


@dataclass
class VirtualCamera:
    position: tuple = (0.0, 1.5, 0.0)
    yaw_deg: float = 0.0
    pitch_deg: float = 0.0
    roll_deg: float = 0.0
    fov_deg: float = 70.0
    out_w: int = 1280
    out_h: int = 720


def render_virtual_view(pano: np.ndarray, layout: RoomLayout, vcam: VirtualCamera):
    """
    임의 위치/방향의 가상 카메라가 보는 프레임을 합성한다.

    return:
        frame      : (out_h, out_w, 3) uint8
        valid_mask : (out_h, out_w)    uint8  0~255 (거리 기반 신뢰도)
    """
    pano_h, pano_w = pano.shape[:2]
    origin = np.asarray(vcam.position, dtype=np.float64)

    cam_rays = make_camera_rays(vcam.out_w, vcam.out_h, vcam.fov_deg)
    R = rotation_matrix(vcam.yaw_deg, vcam.pitch_deg, vcam.roll_deg)
    world_rays = cam_rays @ R.T

    points, valid, _face = ray_prism_hit(origin, world_rays,
                                         layout.footprint, layout.height)

    dirs = points - layout.pano_cam_pos
    map_x, map_y = direction_to_equirect(dirs, pano_w, pano_h)
    frame = cv2.remap(pano, map_x, map_y,
                      interpolation=cv2.INTER_LINEAR,
                      borderMode=cv2.BORDER_WRAP)
    frame[~valid] = 0

    dist = np.linalg.norm(dirs, axis=-1)
    valid_mask = distance_to_confidence(dist)
    valid_mask[~valid] = 0
    return frame, valid_mask


# ---------------------------------------------------------------------------
# CCTV 프리셋 (spec §12.6 보강): 방 bbox 기준으로 자동 계산
# ---------------------------------------------------------------------------
def cctv_presets(layout: RoomLayout):
    xmin, xmax, zmin, zmax = layout.bbox
    h = layout.height
    cx, cz = (xmin + xmax) / 2.0, (zmin + zmax) / 2.0
    m = 0.3
    return {
        "center_eye": VirtualCamera(
            position=(cx, layout.camera_height, cz),
            yaw_deg=0.0, pitch_deg=0.0, fov_deg=75.0),
        "ceiling_top": VirtualCamera(
            position=(cx, h - m, cz),
            yaw_deg=0.0, pitch_deg=-90.0, fov_deg=100.0),
        "front_cctv": VirtualCamera(
            position=(cx, h - m, zmax - m),
            yaw_deg=180.0, pitch_deg=-35.0, fov_deg=95.0),
        "wall_corner_cctv": VirtualCamera(
            position=(xmin + m, h - m, zmin + m),
            yaw_deg=45.0, pitch_deg=-40.0, fov_deg=100.0),
    }
