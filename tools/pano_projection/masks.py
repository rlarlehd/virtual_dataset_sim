"""
masks.py
========
Confidence / validity mask 생성 (spec §9).

멀리 있는 바닥/벽은 원본 파노라마에서 적은 픽셀만 차지하므로 펼쳤을 때 흐리거나
늘어난다. 파노라마 촬영점에서 각 3D 점까지의 거리를 신뢰도로 환산해 사용자에게
"이 영역은 흐릴 수 있음"을 표시한다.
"""
from __future__ import annotations

import numpy as np


def distance_to_confidence(dist: np.ndarray, scale: float = 3.0) -> np.ndarray:
    """
    파노라마 촬영점으로부터의 거리(m) 배열 -> 0~255 신뢰도 (가까울수록 255).
    scale 근방에서 신뢰도가 절반으로 떨어진다.
    """
    d = np.clip(dist, 0.0, None)
    conf = 1.0 / (1.0 + (d / scale) ** 2)
    return (np.clip(conf, 0.0, 1.0) * 255).astype(np.uint8)


def make_distance_confidence_mask(points: np.ndarray, camera: np.ndarray,
                                  scale: float = 3.0) -> np.ndarray:
    """
    points : (H, W, 3) 평면 위 3D 점들
    camera : (3,) 파노라마 촬영 카메라 위치
    return : mask uint8 (H, W), 0~255 (가까울수록 255)
    """
    camera = np.asarray(camera, dtype=np.float64)
    dist = np.linalg.norm(points - camera, axis=-1)
    return distance_to_confidence(dist, scale)
