import bpy
import csv
import json
import random
from pathlib import Path


# ============================================================
# 사용자 설정
# ============================================================

CSV_PATH = Path(r"E:\projects\virtual_dataset\mpfb_asset_list_classified.csv")
OUTPUT_DIR = Path(r"E:\projects\virtual_dataset\mpfb_generated")

CHARACTER_GENDER = "male"       # male / female
CHARACTER_COUNT = 10
START_INDEX = 1

# 같은 숫자를 쓰면 같은 조합이 재현됨
RANDOM_SEED = 20260711

# 여성 캐릭터가 dress를 입을 확률
DRESS_PROBABILITY = 0.25

# 액세서리 적용 확률
ACCESSORY_PROBABILITY = 0.20

ENABLED_VALUES = {
    "1", "true", "yes", "y", "on", "사용", "사용함"
}


# ============================================================
# 기본 함수
# ============================================================

def normalize(value):
    return str(value or "").strip().lower()


def find_human():
    active = bpy.context.active_object

    if (
        active is not None
        and active.type == "MESH"
        and active.name.lower() == "human"
    ):
        return active

    human = bpy.data.objects.get("Human")

    if human is not None and human.type == "MESH":
        return human

    # 이름이 달라진 경우 후보 탐색
    for obj in bpy.context.scene.objects:
        if obj.type != "MESH":
            continue

        if any(
            modifier.type == "ARMATURE"
            for modifier in obj.modifiers
        ):
            return obj

    raise RuntimeError(
        "Human 몸 메시를 찾을 수 없습니다. "
        "Human 메시를 선택한 상태에서 실행하세요."
    )


def find_rig(human):
    for modifier in human.modifiers:
        if (
            modifier.type == "ARMATURE"
            and modifier.object is not None
        ):
            return modifier.object

    raise RuntimeError(
        f"{human.name}에 연결된 Armature를 찾지 못했습니다."
    )


def select_only(objects):
    bpy.ops.object.select_all(action="DESELECT")

    valid_objects = [
        obj for obj in objects
        if obj is not None and obj.name in bpy.data.objects
    ]

    for obj in valid_objects:
        obj.select_set(True)

    if valid_objects:
        bpy.context.view_layer.objects.active = valid_objects[0]


def activate_human(human):
    select_only([human])
    bpy.context.view_layer.objects.active = human


def gender_matches(asset_gender, character_gender):
    asset_gender = normalize(asset_gender)
    character_gender = normalize(character_gender)

    return asset_gender in {
        "",
        "unisex",
        "all",
        "both",
        character_gender,
    }


def get_asset_path(row):
    candidate_columns = [
        "full_path",
        "filepath",
        "file_path",
        "path",
    ]

    for column in candidate_columns:
        value = str(row.get(column, "")).strip()

        if value:
            return Path(value)

    return None


# ============================================================
# CSV 읽기
# ============================================================

def load_assets():
    if not CSV_PATH.exists():
        raise FileNotFoundError(
            f"CSV 파일을 찾을 수 없습니다: {CSV_PATH}"
        )

    with CSV_PATH.open(
        "r",
        encoding="utf-8-sig",
        newline="",
    ) as file:
        rows = list(csv.DictReader(file))

    grouped = {}

    for row in rows:
        enabled = normalize(row.get("enabled", "1"))

        if enabled not in ENABLED_VALUES:
            continue

        category = normalize(row.get("category"))

        if category in {
            "",
            "unknown",
            "exclude",
        }:
            continue

        if not gender_matches(
            row.get("gender", "unisex"),
            CHARACTER_GENDER,
        ):
            continue

        path = get_asset_path(row)

        if path is None:
            continue

        if not path.exists():
            print("[파일 없음]", path)
            continue

        if path.suffix.lower() != ".mhclo":
            continue

        copied = dict(row)
        copied["_path"] = path
        copied["_category"] = category

        grouped.setdefault(category, []).append(copied)

    return grouped


def choose_asset(grouped, category, required=False):
    candidates = grouped.get(category, [])

    if not candidates:
        if required:
            raise RuntimeError(
                f"사용 가능한 '{category}' 에셋이 없습니다."
            )

        return None

    return random.choice(candidates)


def choose_combination(grouped):
    selected = []

    use_dress = (
        CHARACTER_GENDER == "female"
        and bool(grouped.get("dress"))
        and random.random() < DRESS_PROBABILITY
    )

    if use_dress:
        selected.append(
            choose_asset(
                grouped,
                "dress",
                required=True,
            )
        )
    else:
        selected.append(
            choose_asset(
                grouped,
                "top",
                required=True,
            )
        )
        selected.append(
            choose_asset(
                grouped,
                "bottom",
                required=True,
            )
        )

    shoes = choose_asset(grouped, "shoes")
    hair = choose_asset(grouped, "hair")

    if shoes:
        selected.append(shoes)

    if hair:
        selected.append(hair)

    if random.random() < ACCESSORY_PROBABILITY:
        accessory = choose_asset(
            grouped,
            "accessory",
        )

        if accessory:
            selected.append(accessory)

    return selected


# ============================================================
# MPFB 에셋 적용
# ============================================================

def apply_asset(human, row):
    activate_human(human)

    before_names = set(bpy.data.objects.keys())

    result = bpy.ops.mpfb.load_library_clothes(
        filepath=str(row["_path"]),
        object_type="Clothes",
        material_type="MAKESKIN",
    )

    if "FINISHED" not in result:
        raise RuntimeError(
            f"에셋 적용 실패: {row['_path']} / {result}"
        )

    after_names = set(bpy.data.objects.keys())
    new_names = after_names - before_names

    new_objects = [
        bpy.data.objects[name]
        for name in new_names
        if name in bpy.data.objects
    ]

    print(
        "[적용]",
        row["_category"],
        row["_path"].stem,
        "생성 오브젝트:",
        [obj.name for obj in new_objects],
    )

    return new_objects


def remove_generated_objects(objects):
    for obj in list(objects):
        if obj is None:
            continue

        if obj.name not in bpy.data.objects:
            continue

        bpy.data.objects.remove(
            obj,
            do_unlink=True,
        )


# ============================================================
# GLB 내보내기 대상 탐색
# ============================================================

def get_base_character_objects(human, rig):
    """
    Human과 동일한 리그를 사용하는 기존 메시를 포함한다.
    눈, 치아 등 기본 인체 부속 메시가 있으면 함께 내보낸다.
    """
    objects = {human, rig}

    for obj in bpy.context.scene.objects:
        if obj.type != "MESH":
            continue

        for modifier in obj.modifiers:
            if (
                modifier.type == "ARMATURE"
                and modifier.object == rig
            ):
                objects.add(obj)
                break

    # 리그의 자식 오브젝트도 포함
    for child in rig.children_recursive:
        if child.type in {
            "MESH",
            "EMPTY",
        }:
            objects.add(child)

    return list(objects)


def export_glb(
    filepath,
    export_objects,
):
    select_only(export_objects)

    bpy.ops.export_scene.gltf(
        filepath=str(filepath),
        export_format="GLB",
        use_selection=True,

        # 리깅
        export_skins=True,
        export_all_influences=False,

        # 애니메이션이 있으면 함께 저장
        export_animations=True,

        # 재질과 텍스처
        export_materials="EXPORT",

        # 메시
        export_apply=False,

        # 불필요한 조명·카메라 제외
        export_cameras=False,
        export_lights=False,
    )

    if not filepath.exists():
        raise RuntimeError(
            f"GLB 파일이 생성되지 않았습니다: {filepath}"
        )


# ============================================================
# 조합 정보 JSON 저장
# ============================================================

def save_metadata(
    filepath,
    person_id,
    selected_assets,
):
    data = {
        "person_id": person_id,
        "gender": CHARACTER_GENDER,
        "assets": {
            row["_category"]: {
                "name": row.get(
                    "asset_name",
                    row["_path"].stem,
                ),
                "path": str(row["_path"]),
            }
            for row in selected_assets
        },
    }

    filepath.write_text(
        json.dumps(
            data,
            ensure_ascii=False,
            indent=2,
        ),
        encoding="utf-8",
    )


# ============================================================
# 메인 실행
# ============================================================

def main():
    random.seed(RANDOM_SEED)

    OUTPUT_DIR.mkdir(
        parents=True,
        exist_ok=True,
    )

    human = find_human()
    rig = find_rig(human)

    grouped = load_assets()

    print("=" * 70)
    print("Human:", human.name)
    print("Rig:", rig.name)
    print("Gender:", CHARACTER_GENDER)
    print("Output:", OUTPUT_DIR)
    print("=" * 70)

    for category, items in sorted(grouped.items()):
        print(f"{category}: {len(items)}개")

    # 스크립트 실행 전부터 존재하던 기본 캐릭터 구성
    base_objects = get_base_character_objects(
        human,
        rig,
    )

    print(
        "기본 내보내기 오브젝트:",
        [obj.name for obj in base_objects],
    )

    used_signatures = set()
    generated_count = 0
    attempts = 0

    while generated_count < CHARACTER_COUNT:
        attempts += 1

        if attempts > CHARACTER_COUNT * 100:
            raise RuntimeError(
                "서로 다른 조합을 충분히 만들지 못했습니다. "
                "사용 가능한 에셋 수를 확인하세요."
            )

        selected_assets = choose_combination(grouped)

        signature = tuple(
            sorted(
                (
                    row["_category"],
                    str(row["_path"]),
                )
                for row in selected_assets
            )
        )

        # 동일 조합 중복 방지
        if signature in used_signatures:
            continue

        used_signatures.add(signature)

        person_number = (
            START_INDEX + generated_count
        )

        person_id = f"person_{person_number:04d}"

        print("\n" + "=" * 70)
        print("생성 시작:", person_id)

        for row in selected_assets:
            print(
                "-",
                row["_category"],
                row["_path"].stem,
            )

        generated_objects = []

        try:
            for row in selected_assets:
                created = apply_asset(
                    human,
                    row,
                )
                generated_objects.extend(created)

            export_objects = list(
                set(base_objects + generated_objects)
            )

            glb_path = (
                OUTPUT_DIR
                / f"{person_id}.glb"
            )

            json_path = (
                OUTPUT_DIR
                / f"{person_id}.json"
            )

            export_glb(
                glb_path,
                export_objects,
            )

            save_metadata(
                json_path,
                person_id,
                selected_assets,
            )

            print("[GLB 완료]", glb_path)
            print("[JSON 완료]", json_path)

            generated_count += 1

        except Exception as error:
            print("[생성 실패]", person_id)
            print(repr(error))

        finally:
            # 이번 회차에 생성된 의상만 삭제
            remove_generated_objects(
                generated_objects
            )

            activate_human(human)

    print("\n" + "=" * 70)
    print(
        f"완료: {generated_count}명 생성"
    )
    print("저장 경로:", OUTPUT_DIR)
    print("=" * 70)


main()