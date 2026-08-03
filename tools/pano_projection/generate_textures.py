"""
generate_textures.py
====================
일반 다각형 방(RoomLayout)의 면 텍스처를 굽는다(bake) — Three.js 프리즘 메쉬용.

  - floor   : footprint bbox 를 top-down 으로 펼치고, 폴리곤 밖은 무효(검정/conf 0)
  - ceiling : 동일하게 y=H 평면
  - walls   : footprint 의 각 edge 를 fronto-parallel 직사각형으로 펼침 (한 변당 1장)

모든 면은 동일한 역투영을 공유한다 ("경계 fold line 으로 접기"):
    평면 위 3D 점 P -> dir = P - panoCamPos -> equirect(u,v) -> cv2.remap
"""
from __future__ import annotations

import cv2
import numpy as np

from .projection import direction_to_equirect, point_in_polygon
from .layout import RoomLayout
from .masks import make_distance_confidence_mask


def _sample_plane(pano, points, pano_cam):
    pano_h, pano_w = pano.shape[:2]
    dirs = points - pano_cam
    map_x, map_y = direction_to_equirect(dirs, pano_w, pano_h)
    return cv2.remap(pano, map_x, map_y,
                     interpolation=cv2.INTER_LINEAR, borderMode=cv2.BORDER_WRAP)


def make_horizontal_texture(pano, layout: RoomLayout, y: float, out_size: int = 1024):
    """y=상수(바닥/천장) 평면 텍스처 + 폴리곤 밖 무효 mask. return (tex, points, inside)."""
    xmin, xmax, zmin, zmax = layout.bbox
    xs = np.linspace(xmin, xmax, out_size)
    zs = np.linspace(zmax, zmin, out_size)         # 위(작은 v) = +z
    gx, gz = np.meshgrid(xs, zs)
    pts = np.stack([gx, np.full_like(gx, y), gz], axis=-1)
    tex = _sample_plane(pano, pts, layout.pano_cam_pos)
    inside = point_in_polygon(gx, gz, np.asarray(layout.footprint))
    tex[~inside] = 0
    return tex, pts, inside


def make_floor_texture(pano, layout: RoomLayout, out_size: int = 1024):
    return make_horizontal_texture(pano, layout, 0.0, out_size)


def make_ceiling_texture(pano, layout: RoomLayout, out_size: int = 1024):
    return make_horizontal_texture(pano, layout, layout.height, out_size)


def make_wall_texture(pano, layout: RoomLayout, edge_index: int, out_h: int = 512):
    """
    footprint edge i (A->B) 를 fronto-parallel 직사각형으로 펼친다.
    가로 길이는 벽 길이에 비례, 세로는 바닥(0)->천장(H).
    return (tex, points)
    """
    fp = np.asarray(layout.footprint, dtype=np.float64)
    n = len(fp)
    A = fp[edge_index]
    B = fp[(edge_index + 1) % n]
    length = float(np.hypot(B[0] - A[0], B[1] - A[1]))
    # 종횡비 보존: 가로px = (벽길이/벽높이) * 세로px
    out_w = max(8, int(round(length / max(layout.height, 1e-6) * out_h)))

    us = np.linspace(0.0, 1.0, out_w)
    ys = np.linspace(layout.height, 0.0, out_h)    # 위 = 천장
    gu, gy = np.meshgrid(us, ys)
    gx = A[0] + (B[0] - A[0]) * gu
    gz = A[1] + (B[1] - A[1]) * gu
    pts = np.stack([gx, gy, gz], axis=-1)
    tex = _sample_plane(pano, pts, layout.pano_cam_pos)
    return tex, pts


def bake_all(pano, layout: RoomLayout, floor_size=1024, wall_h=512, with_masks=True):
    """
    바닥/천장 + 모든 벽 텍스처(+ confidence mask) 생성.
    return: (textures: dict, masks: dict)
        textures["floor"], ["ceiling"], ["wall_0"], ["wall_1"], ...
    """
    textures, masks = {}, {}

    floor, fpts, _ = make_floor_texture(pano, layout, floor_size)
    textures["floor"] = floor
    ceil, cpts, _ = make_ceiling_texture(pano, layout, floor_size)
    textures["ceiling"] = ceil
    if with_masks:
        masks["floor"] = make_distance_confidence_mask(fpts, layout.pano_cam_pos)
        masks["ceiling"] = make_distance_confidence_mask(cpts, layout.pano_cam_pos)

    n = len(layout.footprint)
    for i in range(n):
        tex, pts = make_wall_texture(pano, layout, i, out_h=wall_h)
        textures[f"wall_{i}"] = tex
        if with_masks:
            masks[f"wall_{i}"] = make_distance_confidence_mask(pts, layout.pano_cam_pos)

    return textures, masks
