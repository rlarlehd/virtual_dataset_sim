"""
imgio.py
========
Windows 에서 cv2.imread/imwrite 는 비ASCII(한글 등) 경로를 처리하지 못해 조용히 실패한다
(예: D:\\project\\대학원\\... 절대경로). imdecode/imencode + 파이썬 파일 IO 로 우회한다.
"""
from __future__ import annotations

import os

import cv2
import numpy as np


def imread_u(path: str, flags: int = cv2.IMREAD_COLOR) -> np.ndarray | None:
    """유니코드 경로 안전 imread."""
    try:
        with open(path, "rb") as f:
            buf = f.read()
    except OSError:
        return None
    return cv2.imdecode(np.frombuffer(buf, np.uint8), flags)


def imwrite_u(path: str, img: np.ndarray) -> bool:
    """유니코드 경로 안전 imwrite."""
    ext = os.path.splitext(path)[1] or ".png"
    ok, enc = cv2.imencode(ext, img)
    if not ok:
        raise IOError(f"imencode 실패: {path}")
    with open(path, "wb") as f:
        f.write(enc.tobytes())
    return True
