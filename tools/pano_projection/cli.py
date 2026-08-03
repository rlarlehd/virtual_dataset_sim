"""
cli.py
======
어노테이션(바닥/천장 경계 코너) 기반 방 형상 복원 + 텍스처 bake + 임의 CCTV 프레임 렌더.

방 형상 입력 두 가지:
  (A) --annotation project.json  : 사용자가 모서리를 찍어 만든 경계로 다각형 방 복원
  (B) --rect W D H               : 직사각형 방 (어노테이션 없을 때 폴백)

예시
----
어노테이션으로 6면 텍스처 + 코너 CCTV:
    python -m tools.pano_projection.cli --input samples/room_001.jpg \
        --annotation annotations/room_001.json --bake-textures --render-view \
        --pos 2.5 2.5 2.5 --yaw 225 --pitch -40 --fov 100 --out outputs/room_001

직사각형 폴백 + 프리셋:
    python -m tools.pano_projection.cli --input samples/room_001.jpg \
        --rect 6 6 3 --camera-height 1.5 --preset wall_corner_cctv --out outputs/room_001
"""
from __future__ import annotations

import argparse
import json
import os

import cv2
import numpy as np

from .layout import RoomLayout, layout_from_annotation
from .room_render import VirtualCamera, render_virtual_view, cctv_presets
from .generate_textures import bake_all
from .filters import sharpen_image, apply_barrel_distortion
from .imgio import imread_u, imwrite_u


def _ensure_dir(p):
    os.makedirs(p, exist_ok=True)


def load_layout(args, pano_w, pano_h) -> RoomLayout:
    if args.annotation:
        with open(args.annotation, "r", encoding="utf-8") as f:
            data = json.load(f)
        ann = data.get("annotation", data)
        room = data.get("room", {})
        cam_h = room.get("cameraHeight", args.cam_h)
        floor_uv = ann.get("floorBoundary", [])
        ceil_uv = ann.get("ceilingBoundary", [])
        return layout_from_annotation(floor_uv, ceil_uv, pano_w, pano_h, cam_h)
    w, d, h = args.rect
    return RoomLayout.rectangle(w, d, h, args.cam_h)


def cmd_bake(pano, layout: RoomLayout, args):
    _ensure_dir(args.out)
    textures, masks = bake_all(pano, layout, floor_size=args.floor_size,
                               wall_h=args.wall_height, with_masks=True)
    for key, img in textures.items():
        if args.sharpen:
            img = sharpen_image(img, 1.0)
        imwrite_u(os.path.join(args.out, f"{key}.png"), img)
    for key, m in masks.items():
        imwrite_u(os.path.join(args.out, f"{key}_confidence.png"), m)

    metadata = {
        "source": os.path.basename(args.input),
        "room": {
            "footprint": np.asarray(layout.footprint).round(4).tolist(),
            "height": round(layout.height, 4),
            "cameraHeight": round(layout.camera_height, 4),
        },
        "walls": len(layout.footprint),
        "textures": sorted(f"{k}.png" for k in textures),
    }
    with open(os.path.join(args.out, "metadata.json"), "w", encoding="utf-8") as f:
        json.dump(metadata, f, indent=2, ensure_ascii=False)
    print(f"[bake] floor+ceiling+{len(layout.footprint)} walls + masks -> {args.out}")


def cmd_render(pano, layout: RoomLayout, args):
    _ensure_dir(args.out)
    if args.preset:
        presets = cctv_presets(layout)
        if args.preset not in presets:
            raise SystemExit(f"unknown preset {args.preset}; choices={list(presets)}")
        vcam = presets[args.preset]
        vcam.out_w, vcam.out_h = args.width, args.height
        tag = args.preset
    else:
        vcam = VirtualCamera(position=tuple(args.pos), yaw_deg=args.yaw,
                             pitch_deg=args.pitch, roll_deg=args.roll, fov_deg=args.fov,
                             out_w=args.width, out_h=args.height)
        tag = f"view_{int(args.yaw)}_{int(args.pitch)}"

    frame, mask = render_virtual_view(pano, layout, vcam)
    if args.sharpen:
        frame = sharpen_image(frame, 1.0)
    if args.barrel != 0.0:
        frame = apply_barrel_distortion(frame, k1=args.barrel)

    imwrite_u(os.path.join(args.out, f"cctv_{tag}.png"), frame)
    imwrite_u(os.path.join(args.out, f"cctv_{tag}_confidence.png"), mask)
    print(f"[render] cctv_{tag}.png  pos={tuple(round(v,2) for v in vcam.position)} "
          f"yaw={vcam.yaw_deg} pitch={vcam.pitch_deg} fov={vcam.fov_deg}")


def build_parser():
    p = argparse.ArgumentParser(description="360 pano -> polygon Box Room textures / CCTV frames")
    p.add_argument("--input", required=True)
    p.add_argument("--out", default="outputs/out")

    p.add_argument("--annotation", default=None, help="경계 코너 어노테이션 JSON")
    p.add_argument("--rect", nargs=3, type=float, default=[6.0, 6.0, 3.0],
                   metavar=("W", "D", "H"), help="직사각형 방 폴백")
    p.add_argument("--camera-height", dest="cam_h", type=float, default=1.5)

    p.add_argument("--bake-textures", action="store_true")
    p.add_argument("--floor-size", type=int, default=1024)
    p.add_argument("--wall-height", type=int, default=512)

    p.add_argument("--render-view", action="store_true")
    p.add_argument("--preset", default=None)
    p.add_argument("--pos", nargs=3, type=float, default=[0.0, 1.5, 0.0])
    p.add_argument("--yaw", type=float, default=0.0)
    p.add_argument("--pitch", type=float, default=0.0)
    p.add_argument("--roll", type=float, default=0.0)
    p.add_argument("--fov", type=float, default=70.0)
    p.add_argument("--width", type=int, default=1280)
    p.add_argument("--height", type=int, default=720)

    p.add_argument("--sharpen", action="store_true")
    p.add_argument("--barrel", type=float, default=0.0, help="배럴 왜곡 k1 (예: -0.25)")
    return p


def main(argv=None):
    args = build_parser().parse_args(argv)
    pano = imread_u(args.input, cv2.IMREAD_COLOR)
    if pano is None:
        raise SystemExit(f"cannot read image: {args.input}")
    h, w = pano.shape[:2]
    if abs(w / h - 2.0) > 0.05:
        print(f"[warn] 입력 비율이 2:1 이 아닙니다 ({w}x{h}, ratio={w/h:.3f}).")

    layout = load_layout(args, w, h)
    print(f"[layout] footprint={len(layout.footprint)}코너, "
          f"H={layout.height:.2f}, camH={layout.camera_height:.2f}")

    if args.bake_textures:
        cmd_bake(pano, layout, args)
    if args.render_view or args.preset:
        cmd_render(pano, layout, args)
    if not (args.bake_textures or args.render_view or args.preset):
        print("작업 미지정. --bake-textures 또는 --render-view/--preset 를 쓰세요.")


if __name__ == "__main__":
    main()
