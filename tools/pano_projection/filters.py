"""
filters.py
==========
후처리 필터 (spec §10) + CCTV 외형 재현용 렌즈 왜곡(보강).
"""
from __future__ import annotations

import cv2
import numpy as np


def sharpen_image(image: np.ndarray, strength: float = 1.0) -> np.ndarray:
    """언샤프 형태의 선명도 보정. strength 0=원본, 1=기본 커널."""
    kernel = np.array([[0, -1, 0],
                       [-1, 5, -1],
                       [0, -1, 0]], dtype=np.float32)
    identity = np.array([[0, 0, 0],
                         [0, 1, 0],
                         [0, 0, 0]], dtype=np.float32)
    k = identity + (kernel - identity) * float(strength)
    return cv2.filter2D(image, -1, k)


def inpaint_texture(image: np.ndarray, mask: np.ndarray, radius: int = 3) -> np.ndarray:
    """수동 mask(0이 아닌 영역을 복원) 기반 간단 inpaint."""
    if mask.dtype != np.uint8:
        mask = mask.astype(np.uint8)
    return cv2.inpaint(image, mask, radius, cv2.INPAINT_TELEA)


def apply_barrel_distortion(image: np.ndarray, k1: float = -0.25,
                            k2: float = 0.0) -> np.ndarray:
    """
    배럴(또는 핀쿠션) 렌즈 왜곡을 흉내내 실제 CCTV/광각 카메라 외형을 재현한다.
    k1 < 0 : 배럴(가장자리가 바깥으로 휘는 광각 CCTV 느낌).
    """
    h, w = image.shape[:2]
    fx = fy = max(w, h)
    cx, cy = w / 2.0, h / 2.0
    K = np.array([[fx, 0, cx],
                  [0, fy, cy],
                  [0, 0, 1]], dtype=np.float64)
    dist = np.array([k1, k2, 0.0, 0.0], dtype=np.float64)
    map1, map2 = cv2.initUndistortRectifyMap(
        K, dist, None, K, (w, h), cv2.CV_32FC1)
    return cv2.remap(image, map1, map2, interpolation=cv2.INTER_LINEAR,
                     borderMode=cv2.BORDER_CONSTANT)
