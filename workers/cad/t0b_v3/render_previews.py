from __future__ import annotations

from hashlib import sha256
import json
import math
from pathlib import Path
import sys

import bpy
from mathutils import Vector


def _file_hash(path: Path) -> str:
    digest = sha256()
    with path.open("rb") as stream:
        for chunk in iter(lambda: stream.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def _look_at(target_object, target: Vector) -> None:
    direction = target - target_object.location
    target_object.rotation_euler = direction.to_track_quat("-Z", "Y").to_euler()


def _material(name: str, color: tuple[float, float, float, float]):
    material = bpy.data.materials.get(name) or bpy.data.materials.new(name)
    material.diffuse_color = color
    material.use_nodes = True
    shader = material.node_tree.nodes.get("Principled BSDF")
    shader.inputs["Base Color"].default_value = color
    shader.inputs["Roughness"].default_value = 0.68
    shader.inputs["Metallic"].default_value = 0.0
    return material


def _visible(record: dict, mode: str) -> bool:
    component = record["componentType"]
    centroid = record["centroid"]
    if mode == "assembly":
        return True
    if mode == "eave-support":
        return record["key"] in {
            "column:0:0",
            "eave-beam:0",
            "bracket-seat:0:0",
            "bracket-arm-x:0:0",
            "bracket-arm-y:0:0",
            "bearing-block:0:0",
            "purlin:0",
        }
    if mode == "column-base":
        return record["key"] in {
            "column:0:0",
            "column-base:0:0",
            "foundation:0:0:course:0",
            "foundation:0:0:course:1",
            "foundation:0:0:course:2",
        }
    if mode == "door-window":
        return component in {
            "wall",
            "doorFrameMember",
            "doorLeafStile",
            "doorLeafRail",
            "doorLeafPanel",
            "latticeFrameMember",
            "latticeBar",
        }
    raise ValueError(f"unsupported preview mode: {mode}")


def main() -> int:
    args = sys.argv[sys.argv.index("--") + 1 :] if "--" in sys.argv else []
    if len(args) != 4:
        raise SystemExit("usage: blender --background --python render_previews.py -- input.glb manifest.json mode output.png")
    glb_path = Path(args[0]).resolve()
    manifest_path = Path(args[1]).resolve()
    mode = args[2]
    output_path = Path(args[3]).resolve()
    output_path.parent.mkdir(parents=True, exist_ok=True)

    manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
    records = {item["entityId"]: item for item in manifest["entities"]}
    bpy.ops.wm.read_factory_settings(use_empty=True)
    bpy.ops.import_scene.gltf(filepath=str(glb_path))
    meshes = [item for item in bpy.context.scene.objects if item.type == "MESH"]
    palette = {
        "timber-demo": _material("timber-demo", (0.42, 0.10, 0.055, 1.0)),
        "stone-demo": _material("stone-demo", (0.55, 0.57, 0.58, 1.0)),
        "earth-demo": _material("earth-demo", (0.62, 0.49, 0.34, 1.0)),
        "ceramic-demo": _material("ceramic-demo", (0.15, 0.17, 0.19, 1.0)),
    }
    visible = []
    for obj in meshes:
        record = records.get(obj.name)
        if record is None:
            raise RuntimeError(f"GLB object has no manifest record: {obj.name}")
        obj.hide_render = not _visible(record, mode)
        if obj.hide_render:
            continue
        material_code = record["materialFact"]["materialCode"]
        obj.data.materials.clear()
        obj.data.materials.append(palette[material_code])
        visible.append(obj)
    if not visible:
        raise RuntimeError("preview selection is empty")

    bounds = [obj.matrix_world @ Vector(corner) for obj in visible for corner in obj.bound_box]
    minimum = Vector(tuple(min(point[index] for point in bounds) for index in range(3)))
    maximum = Vector(tuple(max(point[index] for point in bounds) for index in range(3)))
    target = (minimum + maximum) / 2
    extent = maximum - minimum
    span = max(extent)
    if mode == "eave-support":
        target = Vector((-1.8, -3.0, 4.65))
        span = 2.6
        direction = Vector((1.1, -1.2, 0.8)).normalized()
    elif mode == "column-base":
        target = Vector((-1.8, -3.0, 1.45))
        span = 3.9
        direction = Vector((1.0, -1.2, 0.6)).normalized()
    elif mode == "door-window":
        target = Vector((0.0, -3.05, 2.0))
        span = 4.3
        direction = Vector((0.0, -1.0, 0.08)).normalized()
    else:
        direction = Vector((1.3, -1.6, 1.2)).normalized()

    bpy.ops.object.camera_add(location=target + direction * span * 3.0)
    camera = bpy.context.object
    camera.data.type = "ORTHO"
    camera.data.ortho_scale = span * (1.6 if mode == "assembly" else 1.2)
    _look_at(camera, target)
    bpy.context.scene.camera = camera

    bpy.ops.object.light_add(type="SUN", location=(8.0, -8.0, 16.0))
    sun = bpy.context.object
    sun.rotation_euler = (math.radians(28), math.radians(-18), math.radians(35))
    sun.data.energy = 2.2
    bpy.ops.object.light_add(type="AREA", location=target + Vector((-span, -span, span * 1.5)))
    area = bpy.context.object
    area.data.energy = 1200
    area.data.shape = "DISK"
    area.data.size = span
    _look_at(area, target)

    scene = bpy.context.scene
    scene.render.engine = "BLENDER_EEVEE"
    scene.render.resolution_x = 1600
    scene.render.resolution_y = 1000
    scene.render.resolution_percentage = 100
    scene.render.image_settings.file_format = "PNG"
    scene.render.filepath = str(output_path)
    scene.render.film_transparent = False
    scene.world = bpy.data.worlds.new("T0B V3 World")
    scene.world.color = (0.92, 0.93, 0.94)
    try:
        scene.view_settings.look = "AgX - Medium High Contrast"
    except TypeError:
        pass
    bpy.ops.render.render(write_still=True)

    record = {
        "schemaVersion": "t0b-v3-preview-1",
        "status": "preview-only-not-quality-pass",
        "qualification": {"localProfessionalSampleEligible": False, "L1": False},
        "mode": mode,
        "blenderVersion": bpy.app.version_string,
        "geometryRevisionId": manifest["geometryRevisionId"],
        "visibleObjects": len(visible),
        "input": {"path": glb_path.name, "sha256": _file_hash(glb_path)},
        "manifest": {"path": manifest_path.name, "sha256": _file_hash(manifest_path)},
        "renderer": {"path": Path(__file__).name, "sha256": _file_hash(Path(__file__).resolve())},
        "output": {"path": output_path.name, "sha256": _file_hash(output_path), "pixels": [1600, 1000]},
    }
    output_path.with_suffix(".json").write_text(json.dumps(record, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    print(json.dumps(record, ensure_ascii=False))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
