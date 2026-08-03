"""
MPFB 2.x + Blender 5.1
랜덤 캐릭터 생성 → MPFB mixamo rig → Mixamo walk snap → bake → GLB/JSON export

실행:
1) Blender에서 base_template.blend를 연다.
2) Scripting에서 이 파일을 실행한다.
또는:
blender.exe -b base_template.blend --python mpfb_random_generator.py -- --config generator_config.json
"""

from __future__ import annotations

import argparse
import bpy
import csv
import importlib
import json
import os
import random
import sys
import traceback
from pathlib import Path
from typing import Any


# ---------------------------------------------------------------------------
# MPFB Extension 동적 import
# ---------------------------------------------------------------------------

def dynamic_import(package_suffix: str, symbol: str):
    """Blender Extension의 실제 모듈 prefix를 몰라도 MPFB 심볼을 찾는다."""
    for module_name in list(sys.modules):
        if module_name.endswith(package_suffix):
            module = importlib.import_module(module_name)
            if not hasattr(module, symbol):
                raise AttributeError(
                    f"{module_name} 모듈에 {symbol}이 없습니다."
                )
            return getattr(module, symbol)

    raise RuntimeError(
        f"MPFB 모듈을 찾지 못했습니다: *{package_suffix}. "
        "MPFB가 활성화된 .blend를 열고 실행하세요."
    )


HumanService = dynamic_import("mpfb.services.humanservice", "HumanService")
TargetService = dynamic_import("mpfb.services.targetservice", "TargetService")
ExportService = dynamic_import("mpfb.services.exportservice", "ExportService")
ObjectService = dynamic_import("mpfb.services.objectservice", "ObjectService")
HumanObjectProperties = dynamic_import(
    "mpfb.entities.objectproperties",
    "HumanObjectProperties",
)


# ---------------------------------------------------------------------------
# 기본 유틸리티
# ---------------------------------------------------------------------------

TRUE_VALUES = {"1", "1.0", "true", "yes", "y", "on", "사용", "사용함"}

BODY_PART_TYPE = {
    "eyes": "Eyes",
    "eyebrows": "Eyebrows",
    "eyelashes": "Eyelashes",
    "teeth": "Teeth",
    "tongue": "Tongue",
    "hair": "Hair",
    "top": "Clothes",
    "bottom": "Clothes",
    "dress": "Clothes",
    "shoes": "Clothes",
    "accessory": "Clothes",
}


def log(message: str) -> None:
    print(f"[MPFB-GEN] {message}")


def normalize(value: Any) -> str:
    return str(value or "").strip().lower()


def ensure_object_mode() -> None:
    obj = bpy.context.object
    if obj is not None and obj.mode != "OBJECT":
        bpy.ops.object.mode_set(mode="OBJECT")


def deselect_all() -> None:
    ensure_object_mode()
    bpy.ops.object.select_all(action="DESELECT")


def select_objects(objects, active=None) -> None:
    deselect_all()
    valid = [obj for obj in objects if obj and obj.name in bpy.data.objects]

    for obj in valid:
        obj.hide_set(False)
        obj.hide_viewport = False
        obj.select_set(True)

    if active is not None:
        bpy.context.view_layer.objects.active = active
    elif valid:
        bpy.context.view_layer.objects.active = valid[-1]


def read_cli_config_path() -> Path:
    parser = argparse.ArgumentParser(add_help=False)
    parser.add_argument("--config", type=str)

    argv = sys.argv
    custom_args = argv[argv.index("--") + 1:] if "--" in argv else []
    parsed, _ = parser.parse_known_args(custom_args)

    if parsed.config:
        return Path(parsed.config)

    # 스크립트와 같은 폴더의 기본 설정 파일
    return Path(__file__).with_name("generator_config.json")


def load_config(path: Path) -> dict:
    if not path.exists():
        raise FileNotFoundError(f"설정 파일 없음: {path}")

    with path.open("r", encoding="utf-8") as fp:
        config = json.load(fp)

    config["_config_path"] = str(path.resolve())
    return config


def resolve_path(value: str, config_path: Path) -> Path:
    path = Path(os.path.expandvars(value)).expanduser()
    if not path.is_absolute():
        path = config_path.parent / path
    return path.resolve()


# ---------------------------------------------------------------------------
# 에셋 카탈로그
# ---------------------------------------------------------------------------

def classify_asset(row: dict) -> str | None:
    top = normalize(row.get("top_category"))
    category = normalize(row.get("category"))
    ext = normalize(row.get("extension"))

    if top == "skins" and ext == ".mhmat":
        return "skin"

    if top in {"eyes", "eyebrows", "eyelashes", "teeth", "tongue", "hair"}:
        # 메시 자산만 캐릭터에 직접 추가한다.
        # 대응 .mhmat은 .mhclo 내부 material 경로를 통해 자동 적용된다.
        if ext == ".mhclo":
            return top
        return None

    if top == "clothes" and ext == ".mhclo":
        if category in {"top", "bottom", "dress", "shoes", "accessory"}:
            return category

    return None


def gender_matches(asset_gender: str, character_gender: str) -> bool:
    value = normalize(asset_gender)
    return value in {"", "unisex", "all", "both", character_gender}


def load_asset_catalog(config: dict) -> dict[str, list[dict]]:
    config_path = Path(config["_config_path"])
    csv_path = resolve_path(config["asset_catalog_csv"], config_path)
    data_root = resolve_path(config["mpfb_data_root"], config_path)

    if not csv_path.exists():
        raise FileNotFoundError(f"CSV 없음: {csv_path}")
    if not data_root.exists():
        raise FileNotFoundError(f"MPFB data root 없음: {data_root}")

    grouped: dict[str, list[dict]] = {}

    with csv_path.open("r", encoding="utf-8-sig", newline="") as fp:
        for row in csv.DictReader(fp):
            if normalize(row.get("enabled")) not in TRUE_VALUES:
                continue

            asset_class = classify_asset(row)
            if asset_class is None:
                continue

            relative = str(row.get("relative_path", "")).strip()
            if not relative:
                continue

            relative = relative.replace("\\", "/")
            absolute = data_root / relative

            if not absolute.exists():
                log(f"파일 없음, 제외: {absolute}")
                continue

            item = dict(row)
            item["_class"] = asset_class
            item["_path"] = absolute
            grouped.setdefault(asset_class, []).append(item)

    for key in grouped:
        grouped[key].sort(key=lambda x: str(x["_path"]).lower())

    log("활성 에셋: " + ", ".join(
        f"{key}={len(value)}" for key, value in sorted(grouped.items())
    ))
    return grouped


def candidates_for(
    grouped: dict[str, list[dict]],
    category: str,
    gender: str,
) -> list[dict]:
    return [
        row
        for row in grouped.get(category, [])
        if gender_matches(row.get("gender", "unisex"), gender)
    ]


def choose_asset(
    grouped: dict[str, list[dict]],
    category: str,
    gender: str,
    required: bool = True,
) -> dict | None:
    candidates = candidates_for(grouped, category, gender)

    if not candidates:
        if required:
            raise RuntimeError(
                f"enabled=1인 '{category}' 에셋이 없습니다. gender={gender}"
            )
        return None

    return random.choice(candidates)


def choose_character_assets(
    grouped: dict[str, list[dict]],
    gender: str,
    config: dict,
) -> list[dict]:
    chosen = [
        choose_asset(grouped, "skin", gender),
        choose_asset(grouped, "eyes", gender),
        choose_asset(grouped, "eyebrows", gender),
        choose_asset(grouped, "eyelashes", gender),
        choose_asset(grouped, "teeth", gender),
        choose_asset(grouped, "tongue", gender),
        choose_asset(grouped, "hair", gender),
    ]

    use_dress = (
        gender == "female"
        and bool(candidates_for(grouped, "dress", gender))
        and random.random() < float(config.get("dress_probability", 0.25))
    )

    if use_dress:
        chosen.append(choose_asset(grouped, "dress", gender))
    else:
        chosen.append(choose_asset(grouped, "top", gender))
        chosen.append(choose_asset(grouped, "bottom", gender))

    chosen.append(choose_asset(grouped, "shoes", gender))

    if random.random() < float(config.get("accessory_probability", 0.2)):
        accessory = choose_asset(
            grouped, "accessory", gender, required=False
        )
        if accessory:
            chosen.append(accessory)

    return [row for row in chosen if row is not None]


# ---------------------------------------------------------------------------
# Human 생성·외형 적용
# ---------------------------------------------------------------------------

def weighted_gender(config: dict) -> str:
    ratio = config.get("gender_ratio", {"male": 0.5, "female": 0.5})
    male = float(ratio.get("male", 0.5))
    female = float(ratio.get("female", 0.5))
    total = male + female

    if total <= 0:
        raise ValueError("gender_ratio 합이 0입니다.")

    return "male" if random.random() < male / total else "female"


def random_in_range(config: dict, key: str, default: tuple[float, float]) -> float:
    ranges = config.get("body_ranges", {})
    values = ranges.get(key, list(default))
    return random.uniform(float(values[0]), float(values[1]))


def apply_random_body(human, gender: str, config: dict) -> dict[str, float]:
    # 사용자 환경 로그에서 male=1.0으로 확인됨.
    values = {
        "gender": 1.0 if gender == "male" else 0.0,
        "age": random_in_range(config, "age", (0.30, 0.60)),
        "weight": random_in_range(config, "weight", (0.30, 0.70)),
        "muscle": random_in_range(config, "muscle", (0.30, 0.70)),
        "height": random_in_range(config, "height", (0.35, 0.65)),
        "proportions": random_in_range(config, "proportions", (0.40, 0.60)),
    }

    # 아시아 인종으로 기본 고정하되 config에서 수정 가능
    ethnicity = config.get(
        "ethnicity",
        {"asian": 1.0, "african": 0.0, "caucasian": 0.0},
    )
    values.update({
        "asian": float(ethnicity.get("asian", 1.0)),
        "african": float(ethnicity.get("african", 0.0)),
        "caucasian": float(ethnicity.get("caucasian", 0.0)),
    })

    for key, value in values.items():
        HumanObjectProperties.set_value(
            key,
            value,
            entity_reference=human,
        )

    TargetService.reapply_macro_details(human)
    return values


def add_mixamo_rig(human):
    rig = HumanService.add_builtin_rig(
        human,
        "mixamo",
        import_weights=True,
    )

    if rig is None:
        rig = ObjectService.find_object_of_type_amongst_nearest_relatives(
            human,
            "Skeleton",
        )

    if rig is None or rig.type != "ARMATURE":
        raise RuntimeError("MPFB mixamo rig 생성 실패")

    return rig


def apply_assets(human, assets: list[dict]) -> list[bpy.types.Object]:
    created = []

    # skin은 별도 적용
    skin = next(row for row in assets if row["_class"] == "skin")
    HumanService.set_character_skin(
        str(skin["_path"]),
        human,
        skin_type="GAMEENGINE",
    )
    log(f"skin: {skin['asset_name']}")

    ordered_classes = [
        "eyes",
        "eyebrows",
        "eyelashes",
        "teeth",
        "tongue",
        "hair",
        "top",
        "bottom",
        "dress",
        "shoes",
        "accessory",
    ]

    for asset_class in ordered_classes:
        for row in assets:
            if row["_class"] != asset_class:
                continue

            obj = HumanService.add_mhclo_asset(
                str(row["_path"]),
                human,
                asset_type=BODY_PART_TYPE[asset_class],
                subdiv_levels=0,
                material_type="GAMEENGINE",
                set_up_rigging=True,
                interpolate_weights=True,
                import_subrig=True,
                import_weights=True,
            )
            if obj is None:
                raise RuntimeError(f"에셋 로드 실패: {row['_path']}")

            created.append(obj)
            log(f"{asset_class}: {row['asset_name']} → {obj.name}")

    return created


# ---------------------------------------------------------------------------
# Mixamo source rig → destination rig Snap 및 Bake
# ---------------------------------------------------------------------------

def find_walk_sources(config: dict) -> list[bpy.types.Object]:
    names = config.get(
        "walk_source_rigs",
        [
            "Human.rig_reduced.001",
            "Human.rig_reduced.002",
            "Human.rig_reduced.003",
        ],
    )

    found = []
    for name in names:
        obj = bpy.data.objects.get(name)

        if obj is None:
            raise RuntimeError(f"Walk Source Rig 없음: {name}")
        if obj.type != "ARMATURE":
            raise RuntimeError(f"Walk Source가 Armature가 아님: {name}")
        if obj.animation_data is None or obj.animation_data.action is None:
            raise RuntimeError(f"Walk Source에 Action 없음: {name}")

        found.append(obj)

    return found


def snap_and_bake_mixamo(
    source_rig: bpy.types.Object,
    destination_rig: bpy.types.Object,
    action_name: str,
):
    ensure_object_mode()

    source_hidden = source_rig.hide_get()
    source_viewport = source_rig.hide_viewport

    source_rig.hide_set(False)
    source_rig.hide_viewport = False
    destination_rig.hide_set(False)
    destination_rig.hide_viewport = False

    # 사용자가 수동으로 성공한 선택 방식:
    # source + destination 둘 다 선택, destination을 active로 설정
    select_objects(
        [source_rig, destination_rig],
        active=destination_rig,
    )

    result = bpy.ops.mpfb.map_mixamo()
    if "FINISHED" not in result:
        raise RuntimeError(
            f"map_mixamo 실패: {source_rig.name} -> {destination_rig.name}"
        )

    source_action = source_rig.animation_data.action
    start = int(source_action.frame_range[0])
    end = int(source_action.frame_range[1])

    bpy.context.scene.frame_start = start
    bpy.context.scene.frame_end = end
    bpy.context.scene.frame_set(start)

    # Snap은 constraint 기반이므로 GLB export 전에 destination rig에 시각 변환을 bake한다.
    select_objects([destination_rig], active=destination_rig)
    bpy.ops.object.mode_set(mode="POSE")
    bpy.ops.pose.select_all(action="SELECT")

    result = bpy.ops.nla.bake(
        frame_start=start,
        frame_end=end,
        step=1,
        only_selected=True,
        visual_keying=True,
        clear_constraints=True,
        clear_parents=False,
        use_current_action=False,
        clean_curves=False,
        bake_types={"POSE"},
        channel_types={
            "LOCATION",
            "ROTATION",
            "SCALE",
            "BBONE",
            "PROPS",
        },
    )

    bpy.ops.object.mode_set(mode="OBJECT")

    if "FINISHED" not in result:
        raise RuntimeError("Destination rig animation bake 실패")

    if (
        destination_rig.animation_data is None
        or destination_rig.animation_data.action is None
    ):
        raise RuntimeError("Bake 후 Destination rig Action이 없습니다.")

    baked_action = destination_rig.animation_data.action
    baked_action.name = action_name
    baked_action.use_fake_user = True

    source_rig.hide_set(source_hidden)
    source_rig.hide_viewport = source_viewport

    log(
        f"animation: {source_rig.name} "
        f"({start}-{end}) → {destination_rig.name} / {baked_action.name}"
    )
    return baked_action, start, end


# ---------------------------------------------------------------------------
# Export Copy / 검증 / GLB
# ---------------------------------------------------------------------------

def hierarchy_objects(root) -> list[bpy.types.Object]:
    return [root] + list(ObjectService.get_list_of_children(root))


def find_export_basemesh(export_root):
    obj = ObjectService.find_object_of_type_amongst_nearest_relatives(
        export_root,
        "Basemesh",
    )
    if obj is None:
        raise RuntimeError("Export Copy의 Basemesh를 찾지 못했습니다.")
    return obj


def find_export_rig(export_root):
    obj = ObjectService.find_object_of_type_amongst_nearest_relatives(
        export_root,
        "Skeleton",
    )
    if obj is None:
        raise RuntimeError("Export Copy의 Skeleton을 찾지 못했습니다.")
    return obj


def create_export_copy(human, baked_action):
    export_root = ExportService.create_character_copy(
        human,
        name_suffix="_export",
    )

    export_basemesh = find_export_basemesh(export_root)

    ExportService.bake_modifiers_remove_helpers(
        export_basemesh,
        bake_masks=True,
        bake_subdiv=False,
        remove_helpers=True,
        also_proxy=True,
    )

    export_rig = find_export_rig(export_root)

    # Export Copy에서 action이 누락되거나 원본 Action을 참조하지 않으면 명시적으로 복사
    if export_rig.animation_data is None:
        export_rig.animation_data_create()

    export_action = baked_action.copy()
    export_action.name = baked_action.name
    export_action.use_fake_user = True
    export_rig.animation_data.action = export_action

    return export_root, export_basemesh, export_rig, export_action


def validate_export(export_root, export_rig, export_action) -> None:
    objects = hierarchy_objects(export_root)
    meshes = [obj for obj in objects if obj.type == "MESH"]

    if not meshes:
        raise RuntimeError("Export hierarchy에 Mesh가 없습니다.")

    if export_action is None or not export_action.fcurves:
        raise RuntimeError("Export action에 FCurve가 없습니다.")

    warnings = []
    for obj in meshes:
        armatures = [
            modifier.object
            for modifier in obj.modifiers
            if modifier.type == "ARMATURE" and modifier.object
        ]

        # 눈썹/헤어 등은 parent + weight 방식 또는 bake 이후 modifier 상태가 다를 수 있어
        # 누락을 즉시 실패로 보지 않고 경고한다.
        if not armatures:
            warnings.append(f"Armature modifier 없음: {obj.name}")
        elif export_rig not in armatures:
            warnings.append(
                f"다른 rig 참조: {obj.name} -> "
                + ",".join(rig.name for rig in armatures)
            )

    for warning in warnings:
        log("검증 경고: " + warning)


def export_glb(
    output_path: Path,
    export_root,
    frame_start: int,
    frame_end: int,
) -> None:
    objects = hierarchy_objects(export_root)
    select_objects(objects, active=export_root)

    bpy.context.scene.frame_start = frame_start
    bpy.context.scene.frame_end = frame_end

    kwargs = {
        "filepath": str(output_path),
        "export_format": "GLB",
        "use_selection": True,
        "export_apply": True,
        "export_skins": True,
        "export_all_influences": False,
        "export_animations": True,
        "export_materials": "EXPORT",
        "export_texcoords": True,
        "export_normals": True,
        "export_tangents": True,
        "export_image_format": "AUTO",
        "export_cameras": False,
        "export_lights": False,
    }

    # Blender 버전별 glTF operator property 차이에 대응
    rna = bpy.ops.export_scene.gltf.get_rna_type()
    supported = {
        prop.identifier
        for prop in rna.properties
        if prop.identifier != "rna_type"
    }
    kwargs = {key: value for key, value in kwargs.items() if key in supported}

    result = bpy.ops.export_scene.gltf(**kwargs)

    if "FINISHED" not in result or not output_path.exists():
        raise RuntimeError(f"GLB export 실패: {output_path}")

    if output_path.stat().st_size < 10_000:
        raise RuntimeError(
            f"GLB 크기가 비정상적으로 작습니다: {output_path.stat().st_size} bytes"
        )


# ---------------------------------------------------------------------------
# Cleanup
# ---------------------------------------------------------------------------

def remove_hierarchy(root) -> None:
    if root is None or root.name not in bpy.data.objects:
        return

    objects = hierarchy_objects(root)
    for obj in reversed(objects):
        if obj and obj.name in bpy.data.objects:
            bpy.data.objects.remove(obj, do_unlink=True)


def cleanup_orphans() -> None:
    # 반복 생성 시 메모리 누적 완화. source rig/action은 사용 중이므로 삭제되지 않는다.
    for collection in (
        bpy.data.meshes,
        bpy.data.materials,
        bpy.data.images,
        bpy.data.armatures,
        bpy.data.actions,
    ):
        for block in list(collection):
            if block.users == 0 and not getattr(block, "use_fake_user", False):
                collection.remove(block)


# ---------------------------------------------------------------------------
# 메타데이터
# ---------------------------------------------------------------------------

def asset_metadata(assets: list[dict]) -> dict:
    result = {}
    for row in assets:
        result[row["_class"]] = {
            "asset_name": row.get("asset_name"),
            "relative_path": row.get("relative_path"),
            "gender": row.get("gender"),
        }
    return result


def write_json(path: Path, data: dict) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    with path.open("w", encoding="utf-8") as fp:
        json.dump(data, fp, ensure_ascii=False, indent=2)


# ---------------------------------------------------------------------------
# 캐릭터 1명 생성
# ---------------------------------------------------------------------------

def generate_one(
    person_id: str,
    config: dict,
    grouped_assets: dict[str, list[dict]],
    walk_sources: list[bpy.types.Object],
) -> dict:
    human = None
    export_root = None

    try:
        gender = weighted_gender(config)
        assets = choose_character_assets(grouped_assets, gender, config)
        source_rig = random.choice(walk_sources)

        log(f"START {person_id}: gender={gender}, walk={source_rig.name}")

        human = HumanService.create_human()
        human.name = f"GEN_{person_id}_Human"

        body_values = apply_random_body(human, gender, config)

        # Sample 10과 동일하게 rig를 먼저 추가한 후 자산을 추가한다.
        destination_rig = add_mixamo_rig(human)
        destination_rig.name = f"GEN_{person_id}_Rig"

        apply_assets(human, assets)

        action_name = f"Walk_{source_rig.name.rsplit('.', 1)[-1]}"
        baked_action, frame_start, frame_end = snap_and_bake_mixamo(
            source_rig,
            destination_rig,
            action_name,
        )

        export_root, _, export_rig, export_action = create_export_copy(
            human,
            baked_action,
        )
        export_root.name = f"EXPORT_{person_id}"

        validate_export(export_root, export_rig, export_action)

        output_root = resolve_path(
            config["output_dir"],
            Path(config["_config_path"]),
        )
        glb_dir = output_root / "glb"
        meta_dir = output_root / "metadata"
        glb_dir.mkdir(parents=True, exist_ok=True)
        meta_dir.mkdir(parents=True, exist_ok=True)

        glb_path = glb_dir / f"{person_id}.glb"
        json_path = meta_dir / f"{person_id}.json"

        export_glb(
            glb_path,
            export_root,
            frame_start,
            frame_end,
        )

        metadata = {
            "status": "success",
            "person_id": person_id,
            "seed": config.get("random_seed"),
            "gender": gender,
            "rig_type": "mixamo",
            "body": body_values,
            "assets": asset_metadata(assets),
            "animation": {
                "type": "Walk",
                "source_rig": source_rig.name,
                "source_action": source_rig.animation_data.action.name,
                "export_action": export_action.name,
                "frame_start": frame_start,
                "frame_end": frame_end,
            },
            "output": {
                "glb": str(glb_path),
                "metadata": str(json_path),
                "size_bytes": glb_path.stat().st_size,
            },
        }
        write_json(json_path, metadata)

        log(f"DONE {person_id}: {glb_path}")
        return metadata

    finally:
        if export_root is not None:
            remove_hierarchy(export_root)
        if human is not None:
            remove_hierarchy(human)
        cleanup_orphans()
        deselect_all()


# ---------------------------------------------------------------------------
# Main
# ---------------------------------------------------------------------------

def main() -> None:
    ensure_object_mode()

    config_path = read_cli_config_path()
    config = load_config(config_path)

    seed = int(config.get("random_seed", 20260711))
    random.seed(seed)

    grouped_assets = load_asset_catalog(config)
    walk_sources = find_walk_sources(config)

    output_root = resolve_path(config["output_dir"], config_path)
    output_root.mkdir(parents=True, exist_ok=True)

    count = int(config.get("character_count", 5))
    start_index = int(config.get("start_index", 1))

    manifest = {
        "config": str(config_path),
        "seed": seed,
        "characters": [],
    }

    for offset in range(count):
        number = start_index + offset
        person_id = f"person_{number:04d}"

        try:
            result = generate_one(
                person_id,
                config,
                grouped_assets,
                walk_sources,
            )
        except Exception as error:
            traceback.print_exc()
            result = {
                "status": "failed",
                "person_id": person_id,
                "error_type": type(error).__name__,
                "error": str(error),
            }
            write_json(
                output_root / "failed" / f"{person_id}.json",
                result,
            )
            log(f"FAILED {person_id}: {type(error).__name__}: {error}")

        manifest["characters"].append(result)
        write_json(output_root / "manifest.json", manifest)

    success_count = sum(
        row.get("status") == "success"
        for row in manifest["characters"]
    )
    log(f"완료: success={success_count}, total={count}")


if __name__ == "__main__":
    main()
