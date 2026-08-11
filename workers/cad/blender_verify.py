from __future__ import annotations

import json
import math
from pathlib import Path
import sys

import bpy
from mathutils import Vector


def _look_at(camera, target: Vector) -> None:
    direction = target - camera.location
    camera.rotation_euler = direction.to_track_quat("-Z", "Y").to_euler()


def main() -> int:
    args = sys.argv[sys.argv.index("--") + 1 :] if "--" in sys.argv else []
    if len(args) != 2:
        raise SystemExit("usage: blender --background --python blender_verify.py -- input.glb preview.png")
    glb_path = Path(args[0]).resolve()
    output_path = Path(args[1]).resolve()
    output_path.parent.mkdir(parents=True, exist_ok=True)

    bpy.ops.wm.read_factory_settings(use_empty=True)
    bpy.ops.import_scene.gltf(filepath=str(glb_path))
    meshes = [obj for obj in bpy.context.scene.objects if obj.type == "MESH"]
    if not meshes:
        raise RuntimeError("GLB contains no mesh objects")

    bounds = []
    for obj in meshes:
        for corner in obj.bound_box:
            bounds.append(obj.matrix_world @ Vector(corner))
    minimum = Vector((min(point.x for point in bounds), min(point.y for point in bounds), min(point.z for point in bounds)))
    maximum = Vector((max(point.x for point in bounds), max(point.y for point in bounds), max(point.z for point in bounds)))
    target = (minimum + maximum) / 2

    extent = maximum - minimum
    span = max(extent.x, extent.y, extent.z)
    camera_direction = Vector((1.3, -1.6, 1.2)).normalized()
    bpy.ops.object.camera_add(location=target + camera_direction * span * 3.0)
    camera = bpy.context.object
    camera.data.type = "ORTHO"
    camera.data.ortho_scale = span * 1.65
    _look_at(camera, target)
    bpy.context.scene.camera = camera

    bpy.ops.object.light_add(type="SUN", location=(8.0, -8.0, 16.0))
    sun = bpy.context.object
    sun.rotation_euler = (math.radians(28), math.radians(-18), math.radians(35))
    sun.data.energy = 2.0
    bpy.ops.object.light_add(type="AREA", location=target + Vector((-span, -span, span * 1.5)))
    area = bpy.context.object
    area.data.energy = 1100
    area.data.shape = "DISK"
    area.data.size = span
    _look_at(area, target)

    scene = bpy.context.scene
    scene.render.engine = "BLENDER_EEVEE"
    scene.render.resolution_x = 1400
    scene.render.resolution_y = 900
    scene.render.resolution_percentage = 100
    scene.render.image_settings.file_format = "PNG"
    scene.render.filepath = str(output_path)
    scene.render.film_transparent = False
    scene.world = bpy.data.worlds.new("T0 World")
    scene.world.color = (0.92, 0.94, 0.96)
    try:
        scene.view_settings.look = "AgX - Medium High Contrast"
    except TypeError:
        pass
    bpy.ops.render.render(write_still=True)

    print(json.dumps({
        "status": "passed",
        "meshObjects": len(meshes),
        "bounds": {"min": list(minimum), "max": list(maximum)},
        "preview": str(output_path),
    }))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
