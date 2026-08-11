from __future__ import annotations

import argparse
from dataclasses import dataclass
from hashlib import sha256
import html
import json
import math
from pathlib import Path
import shutil
import sys
import uuid

import ezdxf
import numpy as np
from reportlab.lib.pagesizes import A1, landscape
from reportlab.lib.units import mm
from reportlab.pdfbase import pdfmetrics
from reportlab.pdfbase.ttfonts import TTFont
from reportlab.pdfgen import canvas
import trimesh

from t0_model import canonical_json, spec_hash, stable_uuid


GENERATOR_VERSION = "t0b-professional-1"
FONT_PATH = Path(r"C:\Windows\Fonts\simhei.ttf")
LAYER_COLOURS = {
    "A-AXIS": 8,
    "A-CUT": 1,
    "A-OUTLINE": 7,
    "A-PROJ": 8,
    "A-HIDDEN": 9,
    "A-DIM": 3,
    "A-TEXT": 7,
    "A-HATCH": 9,
    "A-EXIST": 7,
    "A-DAMAGE": 1,
    "A-REPAIR": 5,
    "A-FRAME": 7,
    "A-ROOF": 8,
    "A-TIMBER": 30,
    "A-OPEN": 4,
}


@dataclass
class ModelObject:
    key: str
    category: str
    name: str
    entity_id: str
    mesh: trimesh.Trimesh
    colour: tuple[int, int, int, int]


def load_spec(path: Path) -> dict:
    spec = json.loads(path.read_text(encoding="utf-8"))
    required = {
        "schemaVersion", "projectId", "name", "fixtureId", "producerType", "unit",
        "sourceRefs", "baySpans", "depthSpans", "terrace", "timber", "roof",
        "openings", "foundation", "conditionNote",
    }
    missing = sorted(required - spec.keys())
    if missing:
        raise ValueError(f"missing fields: {', '.join(missing)}")
    if spec["producerType"] != "demo" or spec["unit"] != "mm":
        raise ValueError("T0-B requires demo provenance and millimetres")
    if len(spec["baySpans"]) != 3 or len(spec["depthSpans"]) != 2:
        raise ValueError("T0-B fixture requires three bays and two depth spans")
    if any(float(value) <= 0 for value in spec["baySpans"] + spec["depthSpans"]):
        raise ValueError("all spans must be positive")
    if float(spec["roof"]["ridgeHeight"]) <= float(spec["roof"]["eaveHeight"]):
        raise ValueError("ridge must be above eave")
    return spec


def _hash_file(path: Path) -> str:
    digest = sha256()
    with path.open("rb") as stream:
        for chunk in iter(lambda: stream.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def _mesh_colour(mesh: trimesh.Trimesh, colour: tuple[int, int, int, int]) -> trimesh.Trimesh:
    mesh.visual.face_colors = np.tile(np.array(colour, dtype=np.uint8), (len(mesh.faces), 1))
    return mesh


def _box(center, size) -> trimesh.Trimesh:
    mesh = trimesh.creation.box(extents=np.array(size, dtype=float) / 1000.0)
    mesh.apply_translation(np.array(center, dtype=float) / 1000.0)
    return mesh


def _cylinder_between(start, end, radius: float, sections: int = 12) -> trimesh.Trimesh:
    a = np.array(start, dtype=float) / 1000.0
    b = np.array(end, dtype=float) / 1000.0
    vector = b - a
    length = float(np.linalg.norm(vector))
    if length <= 1e-9:
        raise ValueError("zero-length cylinder")
    mesh = trimesh.creation.cylinder(radius=radius / 1000.0, height=length, sections=sections)
    transform = trimesh.geometry.align_vectors([0, 0, 1], vector / length)
    mesh.apply_transform(transform)
    mesh.apply_translation((a + b) / 2.0)
    return mesh


def _tube(points, radius: float, sections: int = 10) -> trimesh.Trimesh:
    return trimesh.util.concatenate([
        _cylinder_between(points[index], points[index + 1], radius, sections)
        for index in range(len(points) - 1)
    ])


def _roof_dimensions(spec: dict) -> tuple[float, float, float, float]:
    half_width = sum(float(value) for value in spec["baySpans"]) / 2.0
    half_depth = sum(float(value) for value in spec["depthSpans"]) / 2.0
    roof = spec["roof"]
    return (
        half_width,
        half_depth,
        half_width + float(roof["overhangX"]),
        half_depth + float(roof["overhangY"]),
    )


def roof_z(spec: dict, x: float, y: float) -> float:
    _, _, roof_half_x, roof_half_y = _roof_dimensions(spec)
    roof = spec["roof"]
    eave = float(roof["eaveHeight"])
    ridge = float(roof["ridgeHeight"])
    exponent = float(roof["profileExponent"])
    t = min(1.0, abs(y) / roof_half_y)
    base = eave + (ridge - eave) * (1.0 - t**exponent)
    corner = float(roof["cornerUplift"]) * (min(1.0, abs(x) / roof_half_x) ** 7) * (t**3)
    return base + corner


def _roof_surface(spec: dict, side: int) -> trimesh.Trimesh:
    _, _, half_x, half_y = _roof_dimensions(spec)
    thickness = float(spec["roof"]["surfaceThickness"])
    xs = np.linspace(-half_x, half_x, 35)
    ys = np.linspace(0.0, half_y * side, 19)
    top = [(float(x), float(y), roof_z(spec, float(x), float(y))) for y in ys for x in xs]
    bottom = [(x, y, z - thickness) for x, y, z in top]
    vertices = np.array(top + bottom, dtype=float) / 1000.0
    nx = len(xs)
    ny = len(ys)
    faces: list[tuple[int, int, int]] = []
    for j in range(ny - 1):
        for i in range(nx - 1):
            a = j * nx + i
            b = a + 1
            c = a + nx
            d = c + 1
            faces.extend(((a, b, d), (a, d, c)))
            offset = nx * ny
            faces.extend(((a + offset, d + offset, b + offset), (a + offset, c + offset, d + offset)))
    for row in (0, ny - 1):
        for i in range(nx - 1):
            a = row * nx + i
            b = a + 1
            ao = a + nx * ny
            bo = b + nx * ny
            faces.extend(((a, ao, bo), (a, bo, b)))
    for col in (0, nx - 1):
        for j in range(ny - 1):
            a = j * nx + col
            b = a + nx
            ao = a + nx * ny
            bo = b + nx * ny
            faces.extend(((a, b, bo), (a, bo, ao)))
    return trimesh.Trimesh(vertices=vertices, faces=np.array(faces), process=True)


def _add(records: list[ModelObject], spec: dict, key: str, category: str, name: str, mesh: trimesh.Trimesh, colour) -> None:
    records.append(ModelObject(key, category, name, stable_uuid(spec, key), _mesh_colour(mesh, colour), colour))


def build_model(spec: dict) -> list[ModelObject]:
    records: list[ModelObject] = []
    width = sum(float(v) for v in spec["baySpans"])
    depth = sum(float(v) for v in spec["depthSpans"])
    half_width = width / 2.0
    half_depth = depth / 2.0
    roof_half_x = half_width + float(spec["roof"]["overhangX"])
    roof_half_y = half_depth + float(spec["roof"]["overhangY"])
    terrace = spec["terrace"]
    timber = spec["timber"]
    foundation = spec["foundation"]
    terrace_h = float(terrace["height"])
    column_top = terrace_h + float(timber["columnHeight"])
    column_r = float(timber["columnDiameter"]) / 2.0
    beam_d = float(timber["beamDepth"])
    beam_w = float(timber["beamWidth"])

    _add(records, spec, "terrace:main", "terrace", "石台基", _box((0, 0, terrace_h / 2), (width + 1800, depth + 1800, terrace_h)), (185, 180, 170, 255))
    for index in range(int(terrace["stepCount"])):
        step_h = terrace_h / float(terrace["stepCount"])
        _add(records, spec, f"terrace:step:{index}", "terrace", f"踏步 {index + 1}", _box((0, -half_depth - 900 - 300 * index, step_h * (index + 0.5)), (float(terrace["stepWidth"]) + 300 * index, 600, step_h)), (165, 160, 152, 255))

    x_axes = [-half_width]
    for span in spec["baySpans"]:
        x_axes.append(x_axes[-1] + float(span))
    y_axes = [-half_depth, half_depth]
    for row, y in enumerate(y_axes):
        for index, x in enumerate(x_axes):
            _add(records, spec, f"column:{row}:{index}", "column", f"檐柱 {row + 1}-{index + 1}", _cylinder_between((x, y, terrace_h), (x, y, column_top), column_r, 20), (128, 49, 35, 255))
            _add(records, spec, f"foundation:{row}:{index}", "foundation", f"柱下基础 {row + 1}-{index + 1}", _box((x, y, -float(foundation["depth"]) / 2), (float(foundation["footingWidth"]), float(foundation["footingWidth"]), float(foundation["depth"]))), (132, 126, 118, 255))

    for row, y in enumerate(y_axes):
        _add(records, spec, f"beam:eave:{row}", "beam", f"檐檩下梁 {row + 1}", _box((0, y, column_top - beam_d / 2), (width, beam_w, beam_d)), (105, 37, 28, 255))
        for index, x in enumerate(x_axes):
            bracket_parts = [
                _box((x, y, column_top + 120), (900, 360, 180)),
                _box((x, y, column_top + 300), (620, 520, 180)),
                _box((x, y, column_top + 480), (1050, 280, 160)),
            ]
            _add(records, spec, f"bracket:{row}:{index}", "bracket", f"檐下承托 {row + 1}-{index + 1}", trimesh.util.concatenate(bracket_parts), (118, 43, 30, 255))

    purlin_ratio = [0.18, 0.42, 0.66, 0.88]
    for side in (-1, 1):
        for index, ratio in enumerate(purlin_ratio):
            y = side * roof_half_y * ratio
            z = roof_z(spec, 0, y) - 260
            _add(records, spec, f"purlin:{side}:{index}", "purlin", f"檩条 {side}-{index + 1}", _cylinder_between((-half_width - 300, y, z), (half_width + 300, y, z), float(timber["purlinDiameter"]) / 2, 16), (111, 42, 30, 255))

    for side in (-1, 1):
        for index, x in enumerate(np.linspace(-half_width, half_width, 17)):
            points = []
            for y_abs in np.linspace(300, roof_half_y, 12):
                y = side * float(y_abs)
                points.append((float(x), y, roof_z(spec, float(x), y) - 210))
            _add(records, spec, f"rafter:{side}:{index}", "rafter", f"椽 {side}-{index + 1}", _tube(points, float(timber["rafterWidth"]) / 2, 8), (142, 62, 40, 255))

    _add(records, spec, "roof:surface:south", "roofSurface", "南坡瓦面基层", _roof_surface(spec, -1), (72, 78, 82, 255))
    _add(records, spec, "roof:surface:north", "roofSurface", "北坡瓦面基层", _roof_surface(spec, 1), (72, 78, 82, 255))

    ridge_half = width * 0.30
    tile_spacing = float(spec["roof"]["tileSpacing"])
    tile_radius = float(spec["roof"]["tileRadius"])
    for side in (-1, 1):
        tile_meshes = []
        for x in np.arange(-roof_half_x + tile_spacing / 2, roof_half_x, tile_spacing):
            start_ratio = max(0.0, (abs(float(x)) - ridge_half) / max(1.0, roof_half_x - ridge_half)) * 0.55
            points = []
            for ratio in np.linspace(start_ratio, 1.0, 11):
                y = side * roof_half_y * float(ratio)
                points.append((float(x), y, roof_z(spec, float(x), y) + 55))
            tile_meshes.append(_tube(points, tile_radius, 8))
        _add(records, spec, f"tiles:{side}", "tiles", f"瓦垄 {side}", trimesh.util.concatenate(tile_meshes), (52, 57, 61, 255))

    ridge_z = float(spec["roof"]["ridgeHeight"]) + 210
    ridge_r = float(spec["roof"]["ridgeRadius"])
    _add(records, spec, "ridge:main", "ridge", "正脊", _cylinder_between((-ridge_half, 0, ridge_z), (ridge_half, 0, ridge_z), ridge_r, 18), (56, 61, 64, 255))
    for side in (-1, 1):
        for end in (-1, 1):
            points = []
            for ratio in np.linspace(0, 1, 10):
                x = end * (ridge_half + (roof_half_x - ridge_half) * float(ratio))
                y = side * roof_half_y * float(ratio)
                points.append((x, y, roof_z(spec, x, y) + 130))
            _add(records, spec, f"ridge:hip:{side}:{end}", "ridge", f"戗脊 {side}-{end}", _tube(points, ridge_r * 0.65, 10), (56, 61, 64, 255))

    for side in (-1, 1):
        points = [(float(x), side * roof_half_y, roof_z(spec, float(x), side * roof_half_y) - 40) for x in np.linspace(-roof_half_x, roof_half_x, 31)]
        _add(records, spec, f"eave:{side}", "eave", f"檐口 {side}", _tube(points, 90, 10), (78, 55, 42, 255))

    front_y = -half_depth - 70
    opening = spec["openings"]
    for bay_index, (x0, x1) in enumerate(zip(x_axes[:-1], x_axes[1:])):
        parts: list[trimesh.Trimesh] = []
        if bay_index == 1:
            for leaf in range(4):
                leaf_x0 = x0 + (x1 - x0) * leaf / 4
                leaf_x1 = x0 + (x1 - x0) * (leaf + 1) / 4
                parts.append(_box(((leaf_x0 + leaf_x1) / 2, front_y, terrace_h + float(opening["doorHeight"]) / 2), (leaf_x1 - leaf_x0 - 40, 100, float(opening["doorHeight"]))))
                for row in range(3):
                    parts.append(_box(((leaf_x0 + leaf_x1) / 2, front_y - 55, terrace_h + 1850 + row * 330), (leaf_x1 - leaf_x0 - 140, 55, 55)))
            category = "door"
            name = "中央隔扇门"
        else:
            sill = terrace_h + float(opening["sillHeight"])
            height = 2100.0
            parts.extend([
                _box(((x0 + x1) / 2, front_y, sill + height / 2), (x1 - x0 - 180, 100, height)),
            ])
            for col in range(1, int(opening["latticeColumns"])):
                x = x0 + (x1 - x0) * col / int(opening["latticeColumns"])
                parts.append(_box((x, front_y - 55, sill + height / 2), (45, 55, height - 120)))
            for row in range(1, int(opening["latticeRows"])):
                z = sill + height * row / int(opening["latticeRows"])
                parts.append(_box(((x0 + x1) / 2, front_y - 55, z), (x1 - x0 - 260, 55, 45)))
            category = "latticeWindow"
            name = f"花格窗 {bay_index + 1}"
        _add(records, spec, f"opening:{bay_index}", category, name, trimesh.util.concatenate(parts), (76, 105, 88, 255) if bay_index != 1 else (105, 38, 28, 255))

    return records


def _line(a, b, layer="A-PROJ", source=None):
    return {"kind": "line", "a": list(a), "b": list(b), "layer": layer, "source": source}


def _poly(points, layer="A-PROJ", source=None, closed=False):
    return {"kind": "poly", "points": [list(p) for p in points], "layer": layer, "source": source, "closed": closed}


def _rect(x, y, width, height, layer="A-PROJ", source=None):
    return {"kind": "rect", "x": x, "y": y, "width": width, "height": height, "layer": layer, "source": source}


def _circle(center, radius, layer="A-PROJ", source=None):
    return {"kind": "circle", "center": list(center), "radius": radius, "layer": layer, "source": source}


def _text(point, value, height=180, layer="A-TEXT", source=None):
    return {"kind": "text", "point": list(point), "text": value, "height": height, "layer": layer, "source": source}


def _dim_h(x1, x2, y, offset, text=None):
    return {"kind": "dimH", "x1": x1, "x2": x2, "y": y, "offset": offset, "text": text, "layer": "A-DIM"}


def _dim_v(y1, y2, x, offset, text=None):
    return {"kind": "dimV", "y1": y1, "y2": y2, "x": x, "offset": offset, "text": text, "layer": "A-DIM"}


def _hatch_rect(x, y, width, height, layer="A-HATCH"):
    return {"kind": "hatchRect", "x": x, "y": y, "width": width, "height": height, "layer": layer}


def _block(point, name, scale=1.0, source=None):
    return {"kind": "block", "point": list(point), "name": name, "scale": scale, "layer": "A-TIMBER", "source": source}


def build_views(spec: dict) -> dict[str, list[dict]]:
    width = sum(float(v) for v in spec["baySpans"])
    depth = sum(float(v) for v in spec["depthSpans"])
    half_width = width / 2
    half_depth = depth / 2
    roof_half_x = half_width + float(spec["roof"]["overhangX"])
    roof_half_y = half_depth + float(spec["roof"]["overhangY"])
    terrace_h = float(spec["terrace"]["height"])
    column_top = terrace_h + float(spec["timber"]["columnHeight"])
    column_d = float(spec["timber"]["columnDiameter"])
    ridge = float(spec["roof"]["ridgeHeight"])
    x_axes = [-half_width]
    for span in spec["baySpans"]:
        x_axes.append(x_axes[-1] + float(span))

    front: list[dict] = [_line((-7800, 0), (7800, 0), "A-OUTLINE")]
    front.extend((_rect(-6900, 0, 13800, terrace_h, "A-OUTLINE"), _hatch_rect(-6900, 0, 13800, terrace_h, "A-HATCH")))
    for joint in np.arange(-6600, 6700, 600):
        front.append(_line((float(joint), 0), (float(joint), terrace_h), "A-PROJ"))
    front.append(_line((-6900, terrace_h / 2), (6900, terrace_h / 2), "A-PROJ"))
    for step in range(3):
        front.append(_rect(-1500 - step * 160, -300 * (step + 1), 3000 + step * 320, 300, "A-OUTLINE"))
    for index, x in enumerate(x_axes):
        source = stable_uuid(spec, f"column:0:{index}")
        front.append(_rect(x - column_d / 2, terrace_h, column_d, column_top - terrace_h, "A-CUT", source))
        front.append(_block((x, column_top), "BRACKET", 1.0, stable_uuid(spec, f"bracket:0:{index}")))
        front.append(_line((x, -1200), (x, ridge + 1200), "A-AXIS"))
        front.append(_text((x - 80, -1150), str(index + 1), 220, "A-TEXT"))
    front.append(_rect(-half_width, column_top - 520, width, 520, "A-TIMBER", stable_uuid(spec, "beam:eave:0")))

    sill = terrace_h + float(spec["openings"]["sillHeight"])
    for bay_index, (x0, x1) in enumerate(zip(x_axes[:-1], x_axes[1:])):
        if bay_index == 1:
            height = float(spec["openings"]["doorHeight"])
            front.append(_rect(x0 + 120, terrace_h, x1 - x0 - 240, height, "A-OPEN", stable_uuid(spec, f"opening:{bay_index}")))
            for leaf in range(1, 4):
                x = x0 + (x1 - x0) * leaf / 4
                front.append(_line((x, terrace_h), (x, terrace_h + height), "A-OPEN"))
            for row in range(1, 4):
                z = terrace_h + height * row / 4
                front.append(_line((x0 + 120, z), (x1 - 120, z), "A-OPEN"))
            for leaf in range(4):
                leaf_x0 = x0 + 120 + (x1 - x0 - 240) * leaf / 4
                leaf_x1 = x0 + 120 + (x1 - x0 - 240) * (leaf + 1) / 4
                front.append(_rect(leaf_x0 + 90, terrace_h + 120, leaf_x1 - leaf_x0 - 180, 520, "A-PROJ"))
                front.append(_rect(leaf_x0 + 90, terrace_h + 780, leaf_x1 - leaf_x0 - 180, 520, "A-PROJ"))
                for diagonal in range(3):
                    xa = leaf_x0 + 120 + diagonal * (leaf_x1 - leaf_x0 - 240) / 3
                    front.append(_line((xa, terrace_h + 1600), (min(leaf_x1 - 100, xa + 420), terrace_h + 2020), "A-PROJ"))
                    front.append(_line((xa, terrace_h + 2020), (min(leaf_x1 - 100, xa + 420), terrace_h + 1600), "A-PROJ"))
        else:
            height = 2100
            front.append(_rect(x0 + 160, sill, x1 - x0 - 320, height, "A-OPEN", stable_uuid(spec, f"opening:{bay_index}")))
            for col in range(1, 6):
                x = x0 + (x1 - x0) * col / 6
                front.append(_line((x, sill), (x, sill + height), "A-OPEN"))
            for row in range(1, 4):
                z = sill + height * row / 4
                front.append(_line((x0 + 160, z), (x1 - 160, z), "A-OPEN"))
            cell_w = (x1 - x0 - 320) / 6
            cell_h = height / 4
            for col in range(6):
                for row in range(4):
                    xa = x0 + 160 + col * cell_w
                    za = sill + row * cell_h
                    front.append(_line((xa + 60, za + cell_h / 2), (xa + cell_w / 2, za + cell_h - 60), "A-PROJ"))
                    front.append(_line((xa + cell_w / 2, za + cell_h - 60), (xa + cell_w - 60, za + cell_h / 2), "A-PROJ"))
                    front.append(_line((xa + cell_w - 60, za + cell_h / 2), (xa + cell_w / 2, za + 60), "A-PROJ"))
                    front.append(_line((xa + cell_w / 2, za + 60), (xa + 60, za + cell_h / 2), "A-PROJ"))

    front.append(_rect(-half_width, column_top - 980, width, 360, "A-TIMBER"))
    for panel in range(18):
        x0 = -half_width + width * panel / 18
        x1 = -half_width + width * (panel + 1) / 18
        front.append(_rect(x0 + 25, column_top - 940, x1 - x0 - 50, 280, "A-PROJ"))
        front.append(_line((x0 + 70, column_top - 800), (x1 - 70, column_top - 680), "A-PROJ"))
        front.append(_line((x0 + 70, column_top - 680), (x1 - 70, column_top - 800), "A-PROJ"))

    eave_points = [(float(x), roof_z(spec, float(x), -roof_half_y)) for x in np.linspace(-roof_half_x, roof_half_x, 49)]
    front.append(_poly(eave_points, "A-OUTLINE", stable_uuid(spec, "eave:-1")))
    ridge_half = width * 0.30
    front.append(_line((-ridge_half, ridge), (ridge_half, ridge), "A-OUTLINE", stable_uuid(spec, "ridge:main")))
    front.append(_poly([(-roof_half_x, eave_points[0][1]), (-ridge_half, ridge), (ridge_half, ridge), (roof_half_x, eave_points[-1][1])], "A-ROOF"))
    for ratio in np.linspace(0.10, 0.90, 9):
        y = -roof_half_y * float(ratio)
        x_limit = ridge_half + (roof_half_x - ridge_half) * float(ratio)
        front.append(_poly([(float(x), roof_z(spec, float(x), y) + 40) for x in np.linspace(-x_limit, x_limit, 41)], "A-PROJ", stable_uuid(spec, "roof:surface:south")))
    for x in np.linspace(-roof_half_x + 180, roof_half_x - 180, 37):
        top_x = max(-ridge_half, min(ridge_half, float(x) * ridge_half / roof_half_x))
        front.append(_line((top_x, ridge - 100), (float(x), roof_z(spec, float(x), -roof_half_y) + 60), "A-PROJ", stable_uuid(spec, "tiles:-1")))
    for x in np.linspace(-roof_half_x + 180, roof_half_x - 180, 41):
        front.append(_circle((float(x), roof_z(spec, float(x), -roof_half_y) - 40), 55, "A-ROOF", stable_uuid(spec, "tiles:-1")))
    for end in (-1, 1):
        x = end * ridge_half
        front.append(_circle((x, ridge + 80), 180, "A-ROOF"))
        front.append(_poly([(x, ridge + 260), (x + end * 220, ridge + 520), (x + end * 420, ridge + 300)], "A-ROOF"))
    for level, label in ((0, "±0.000"), (terrace_h, "+0.900"), (column_top, "+5.100"), (float(spec["roof"]["eaveHeight"]), "+5.400"), (ridge, "+9.000")):
        front.append(_line((7000, level), (7600, level), "A-DIM"))
        front.append(_text((7040, level + 100), label, 180, "A-TEXT"))
    chain_y = -1500
    for index, span in enumerate(spec["baySpans"]):
        front.append(_dim_h(x_axes[index], x_axes[index + 1], 0, chain_y, str(span)))
    front.extend((_dim_h(-half_width, half_width, 0, -2200, str(int(width))), _dim_v(0, ridge, half_width, 1700, str(int(ridge)))))
    front.extend((_dim_h(-roof_half_x, roof_half_x, float(spec["roof"]["eaveHeight"]), -2900, str(int(roof_half_x * 2))), _text((-7500, 10100), "南立面：瓦作、木构、门窗、台基与病害索引", 220)))
    damage_source = stable_uuid(spec, "condition:D-COL-01")
    front.extend((_circle((x_axes[1], terrace_h + 200), 180, "A-DAMAGE", damage_source), _line((x_axes[1] + 180, terrace_h + 300), (2500, 2500), "A-DAMAGE", damage_source), _text((2600, 2500), "D-COL-01 柱脚表面劣化（DEMO）", 180, "A-DAMAGE", damage_source)))

    section: list[dict] = [_line((-6500, 0), (6500, 0), "A-OUTLINE"), _rect(-5200, 0, 10400, terrace_h, "A-CUT"), _hatch_rect(-5200, -1200, 10400, 1200, "A-HATCH")]
    for layer_z in (-900, -600, -300, 300, 600):
        section.append(_line((-5200, layer_z), (5200, layer_z), "A-PROJ"))
    for y in (-half_depth, half_depth):
        section.extend((_rect(y - column_d / 2, terrace_h, column_d, column_top - terrace_h, "A-CUT"), _hatch_rect(y - 550, -1200, 1100, 1200, "A-HATCH"), _block((y, column_top), "BRACKET", 1.0)))
    section.append(_rect(-half_depth, column_top - 520, depth, 520, "A-CUT"))
    profile = [(float(y), roof_z(spec, 0, float(y))) for y in np.linspace(-roof_half_y, roof_half_y, 61)]
    section.append(_poly(profile, "A-OUTLINE"))
    section.append(_poly([(y, z - 180) for y, z in profile], "A-CUT"))
    for offset in (55, 110, 165):
        section.append(_poly([(y, z + offset) for y, z in profile], "A-PROJ"))
    for side in (-1, 1):
        for ratio in (0.18, 0.42, 0.66, 0.88):
            y = side * roof_half_y * ratio
            z = roof_z(spec, 0, y) - 260
            section.append(_circle((y, z), float(spec["timber"]["purlinDiameter"]) / 2, "A-CUT"))
    for y in np.linspace(-roof_half_y, roof_half_y, 29):
        z = roof_z(spec, 0, float(y))
        section.append(_line((float(y), z - 180), (float(y), z + 150), "A-PROJ"))
    for y in np.linspace(-roof_half_y + 120, roof_half_y - 120, 35):
        section.append(_circle((float(y), roof_z(spec, 0, float(y)) + 110), 45, "A-ROOF"))
    section.extend((_dim_h(-half_depth, half_depth, 0, -1700, str(int(depth))), _dim_h(-roof_half_y, roof_half_y, 0, -2400, str(int(roof_half_y * 2))), _dim_v(0, ridge, half_depth, 1800, str(int(ridge)))))
    section.extend((_line((1000, 7600), (2800, 8200), "A-TEXT"), _text((2900, 8200), "瓦面、望板、椽、檩分层表达", 180), _line((-3200, 4300), (-5200, 3600), "A-TEXT"), _text((-6100, 3400), "柱梁枋与承托构件", 180), _line((3600, -650), (5200, -1500), "A-TEXT"), _text((2500, -1850), "台基与柱下基础剖切填充", 180), _text((-6200, 10100), "横剖面：屋面—木构—台基—基础同源剖切", 220)))

    detail: list[dict] = []
    detail_profile = []
    for local_x, y in zip(np.linspace(0, 4200, 29), np.linspace(-roof_half_y, -roof_half_y * 0.28, 29)):
        detail_profile.append((float(local_x), roof_z(spec, 0, float(y)) - float(spec["roof"]["eaveHeight"]) + 3000))
    detail.append(_poly(detail_profile, "A-OUTLINE"))
    detail.append(_poly([(x, z - 180) for x, z in detail_profile], "A-CUT"))
    for offset in (55, 110, 165):
        detail.append(_poly([(x, z + offset) for x, z in detail_profile], "A-PROJ"))
    for index in (5, 14, 23):
        x, z = detail_profile[index]
        detail.append(_circle((x, z - 260), 150, "A-CUT"))
        detail.append(_text((x - 180, z - 620), f"檩 {index // 9 + 1}", 150))
    detail.append(_block((1050, 2500), "BRACKET", 1.4))
    detail.append(_rect(840, 0, 420, 2500, "A-CUT"))
    detail.append(_rect(350, -500, 1400, 500, "A-CUT"))
    detail.append(_hatch_rect(350, -1000, 1400, 500, "A-HATCH"))
    detail.extend((_text((-300, 5750), "1:20 檐口—承托—柱身—柱础构造详图", 210), _text((-300, 5400), "瓦面、望板、椽、檩与承托分层；全部为 DEMO", 160), _line((1800, 4350), (4700, 5000), "A-TEXT"), _text((3100, 5050), "瓦面三层表达", 160), _line((1120, 2750), (3500, 3200), "A-TEXT"), _text((3550, 3200), "承托构件", 160), _dim_v(0, 2500, 1050, -950, "2500"), _dim_h(350, 1750, -500, -1250, "1400")))

    plan: list[dict] = [_rect(-6900, -5100, 13800, 10200, "A-OUTLINE"), _poly([(-roof_half_x, -roof_half_y), (roof_half_x, -roof_half_y), (ridge_half, 0), (-ridge_half, 0)], "A-ROOF", closed=True), _poly([(-roof_half_x, roof_half_y), (roof_half_x, roof_half_y), (ridge_half, 0), (-ridge_half, 0)], "A-ROOF", closed=True)]
    for x in x_axes:
        plan.append(_line((x, -half_depth - 800), (x, half_depth + 800), "A-AXIS"))
        for y in (-half_depth, half_depth):
            plan.append(_circle((x, y), column_d / 2, "A-CUT"))
        plan.append(_block((x, -half_depth), "BRACKET", 0.45))
    for y in (-half_depth, half_depth):
        plan.append(_line((-half_width - 800, y), (half_width + 800, y), "A-AXIS"))
    for x in np.linspace(-roof_half_x, roof_half_x, 25):
        plan.append(_line((float(x), -roof_half_y), (max(-ridge_half, min(ridge_half, float(x) * ridge_half / roof_half_x)), 0), "A-PROJ"))
        plan.append(_line((float(x), roof_half_y), (max(-ridge_half, min(ridge_half, float(x) * ridge_half / roof_half_x)), 0), "A-PROJ"))
    plan.extend((_dim_h(-half_width, half_width, -half_depth, -6500, str(int(width))), _dim_v(-half_depth, half_depth, half_width, 1700, str(int(depth))), _text((-6800, 5700), "屋顶平面 1:50", 220)))
    return {"frontElevation": front, "transverseSection": section, "eaveDetail": detail, "roofPlan": plan}


def _attach_xdata(doc, entity, source: str | None) -> None:
    if source:
        entity.set_xdata("GUJIAN_SOURCE", [(1000, source), (1000, "demo")])


def _ensure_dxf_resources(doc) -> None:
    doc.appids.add("GUJIAN_SOURCE")
    if "DASHED" not in doc.linetypes:
        doc.linetypes.add("DASHED", pattern=[0.75, 0.5, -0.25], description="Dashed 0.5 / 0.25")
    doc.styles.add("GUJIAN_CN", font="simhei.ttf")
    for name, colour in LAYER_COLOURS.items():
        layer = doc.layers.add(name, color=colour)
        layer.dxf.lineweight = 50 if name in {"A-CUT", "A-OUTLINE"} else 25
    doc.layers.get("A-HIDDEN").dxf.linetype = "DASHED"
    dim = doc.dimstyles.new("GUJIAN-DIM")
    dim.dxf.dimtxt = 180
    dim.dxf.dimasz = 120
    dim.dxf.dimexe = 100
    dim.dxf.dimexo = 60
    dim.dxf.dimtxsty = "GUJIAN_CN"
    bracket = doc.blocks.new("BRACKET")
    bracket.add_lwpolyline([(-520, 0), (520, 0), (360, 180), (-360, 180)], close=True, dxfattribs={"layer": "A-TIMBER"})
    bracket.add_lwpolyline([(-330, 180), (330, 180), (220, 360), (-220, 360)], close=True, dxfattribs={"layer": "A-TIMBER"})
    bracket.add_line((-520, 360), (520, 360), dxfattribs={"layer": "A-TIMBER"})


def _add_dxf_primitive(doc, msp, primitive: dict, offset: tuple[float, float]) -> None:
    ox, oy = offset
    layer = primitive["layer"]
    source = primitive.get("source")
    kind = primitive["kind"]
    entity = None
    if kind == "line":
        entity = msp.add_line((primitive["a"][0] + ox, primitive["a"][1] + oy), (primitive["b"][0] + ox, primitive["b"][1] + oy), dxfattribs={"layer": layer})
    elif kind == "poly":
        points = [(p[0] + ox, p[1] + oy) for p in primitive["points"]]
        entity = msp.add_lwpolyline(points, close=primitive.get("closed", False), dxfattribs={"layer": layer})
    elif kind == "rect" or kind == "hatchRect":
        points = [(primitive["x"] + ox, primitive["y"] + oy), (primitive["x"] + primitive["width"] + ox, primitive["y"] + oy), (primitive["x"] + primitive["width"] + ox, primitive["y"] + primitive["height"] + oy), (primitive["x"] + ox, primitive["y"] + primitive["height"] + oy)]
        if kind == "rect":
            entity = msp.add_lwpolyline(points, close=True, dxfattribs={"layer": layer})
        else:
            hatch = msp.add_hatch(color=9, dxfattribs={"layer": layer})
            hatch.paths.add_polyline_path(points, is_closed=True)
            entity = hatch
    elif kind == "circle":
        entity = msp.add_circle((primitive["center"][0] + ox, primitive["center"][1] + oy), primitive["radius"], dxfattribs={"layer": layer})
    elif kind == "text":
        entity = msp.add_mtext(primitive["text"], dxfattribs={"layer": layer, "style": "GUJIAN_CN", "char_height": primitive["height"]})
        entity.set_location((primitive["point"][0] + ox, primitive["point"][1] + oy))
    elif kind == "block":
        entity = msp.add_blockref("BRACKET", (primitive["point"][0] + ox, primitive["point"][1] + oy), dxfattribs={"layer": layer, "xscale": primitive["scale"], "yscale": primitive["scale"]})
    elif kind == "dimH":
        text = primitive.get("text") or f"{abs(primitive['x2'] - primitive['x1']):.0f}"
        entity = msp.add_linear_dim(base=((primitive["x1"] + primitive["x2"]) / 2 + ox, primitive["offset"] + oy), p1=(primitive["x1"] + ox, primitive["y"] + oy), p2=(primitive["x2"] + ox, primitive["y"] + oy), angle=0, text=text, dimstyle="GUJIAN-DIM", dxfattribs={"layer": layer}).render()
    elif kind == "dimV":
        text = primitive.get("text") or f"{abs(primitive['y2'] - primitive['y1']):.0f}"
        entity = msp.add_linear_dim(base=(primitive["x"] + primitive["offset"] + ox, (primitive["y1"] + primitive["y2"]) / 2 + oy), p1=(primitive["x"] + ox, primitive["y1"] + oy), p2=(primitive["x"] + ox, primitive["y2"] + oy), angle=90, text=text, dimstyle="GUJIAN-DIM", dxfattribs={"layer": layer}).render()
    if entity is not None:
        _attach_xdata(doc, entity, source)


def write_dxf(path: Path, spec: dict, views: dict[str, list[dict]]) -> dict:
    doc = ezdxf.new("R2018")
    doc.units = ezdxf.units.MM
    _ensure_dxf_resources(doc)
    msp = doc.modelspace()
    offsets = {"frontElevation": (0, 0), "transverseSection": (22000, 0), "eaveDetail": (39000, 0), "roofPlan": (0, -17000)}
    for name, primitives in views.items():
        for primitive in primitives:
            _add_dxf_primitive(doc, msp, primitive, offsets[name])
    for label, point in (("南立面 1:50", (-7000, 10800)), ("横剖面 1:50", (16000, 10800)), ("檐口构造详图 1:20", (33500, 10800)), ("屋顶平面 1:50", (-7000, -10000))):
        msp.add_mtext(label, dxfattribs={"layer": "A-TEXT", "style": "GUJIAN_CN", "char_height": 260}).set_location(point)
    layout = doc.layouts.new("A1-T0B")
    layout.page_setup(size=(841, 594), margins=(10, 10, 10, 10), units="mm")
    layout.add_viewport(center=(205, 430), size=(380, 250), view_center_point=(0, 4200), view_height=12500, status=2)
    layout.add_viewport(center=(575, 430), size=(330, 250), view_center_point=(22000, 4200), view_height=12500, status=3)
    layout.add_viewport(center=(190, 165), size=(350, 220), view_center_point=(0, -17000), view_height=12500, status=4)
    layout.add_viewport(center=(500, 165), size=(230, 220), view_center_point=(39000, 3200), view_height=7200, status=5)
    layout.add_mtext("T0-B 古建局部专业样板 / L1 / DEMO ONLY", dxfattribs={"layer": "A-TEXT", "style": "GUJIAN_CN", "char_height": 4}).set_location((650, 70))
    doc.saveas(path)
    auditor = doc.audit()
    if auditor.errors:
        raise RuntimeError(f"DXF audit failed: {len(auditor.errors)} errors")
    return {"entities": len(msp), "layouts": doc.layouts.names()}


def _paper_xy(point, bbox, origin, scale):
    return origin[0] + (point[0] - bbox[0]) / scale, origin[1] + (point[1] - bbox[1]) / scale


def _line_width(layer: str) -> float:
    if layer == "A-CUT":
        return 0.55
    if layer == "A-OUTLINE":
        return 0.40
    if layer in {"A-AXIS", "A-HIDDEN", "A-HATCH"}:
        return 0.16
    return 0.24


def _pdf_primitive(pdf, primitive, bbox, origin, scale):
    kind = primitive["kind"]
    layer = primitive["layer"]
    pdf.setStrokeColorRGB(0.68, 0.12, 0.12) if layer == "A-DAMAGE" else pdf.setStrokeColorRGB(0.08, 0.08, 0.08)
    pdf.setFillColorRGB(0.68, 0.12, 0.12) if layer == "A-DAMAGE" else pdf.setFillColorRGB(0.08, 0.08, 0.08)
    pdf.setLineWidth(_line_width(layer) * mm)
    if layer == "A-AXIS":
        pdf.setDash(4 * mm, 2 * mm)
    else:
        pdf.setDash()
    if kind == "line":
        a = _paper_xy(primitive["a"], bbox, origin, scale); b = _paper_xy(primitive["b"], bbox, origin, scale)
        pdf.line(a[0] * mm, a[1] * mm, b[0] * mm, b[1] * mm)
    elif kind == "poly":
        path = pdf.beginPath()
        first = _paper_xy(primitive["points"][0], bbox, origin, scale); path.moveTo(first[0] * mm, first[1] * mm)
        for point in primitive["points"][1:]:
            x, y = _paper_xy(point, bbox, origin, scale); path.lineTo(x * mm, y * mm)
        if primitive.get("closed"):
            path.close()
        pdf.drawPath(path, stroke=1, fill=0)
    elif kind in {"rect", "hatchRect"}:
        x, y = _paper_xy((primitive["x"], primitive["y"]), bbox, origin, scale)
        w = primitive["width"] / scale; h = primitive["height"] / scale
        pdf.rect(x * mm, y * mm, w * mm, h * mm, stroke=1, fill=0)
        if kind == "hatchRect":
            spacing = 3.0
            cursor = -h
            while cursor < w:
                x1 = max(0.0, cursor); y1 = max(0.0, -cursor)
                x2 = min(w, cursor + h); y2 = min(h, w - cursor)
                pdf.line((x + x1) * mm, (y + y1) * mm, (x + x2) * mm, (y + y2) * mm)
                cursor += spacing
    elif kind == "circle":
        x, y = _paper_xy(primitive["center"], bbox, origin, scale)
        pdf.circle(x * mm, y * mm, primitive["radius"] / scale * mm, stroke=1, fill=0)
    elif kind == "text":
        x, y = _paper_xy(primitive["point"], bbox, origin, scale)
        pdf.setFont("GUJIAN_CN", max(5.5, primitive["height"] / scale * 2.8346))
        pdf.drawString(x * mm, y * mm, primitive["text"])
    elif kind == "block":
        x, y = _paper_xy(primitive["point"], bbox, origin, scale); s = primitive["scale"] / scale
        pdf.rect((x - 520 * s) * mm, y * mm, 1040 * s * mm, 180 * s * mm, stroke=1, fill=0)
        pdf.rect((x - 330 * s) * mm, (y + 180 * s) * mm, 660 * s * mm, 180 * s * mm, stroke=1, fill=0)
    elif kind == "dimH":
        p1 = _paper_xy((primitive["x1"], primitive["y"]), bbox, origin, scale); p2 = _paper_xy((primitive["x2"], primitive["y"]), bbox, origin, scale)
        d1 = _paper_xy((primitive["x1"], primitive["offset"]), bbox, origin, scale); d2 = _paper_xy((primitive["x2"], primitive["offset"]), bbox, origin, scale)
        pdf.line(p1[0] * mm, p1[1] * mm, d1[0] * mm, d1[1] * mm); pdf.line(p2[0] * mm, p2[1] * mm, d2[0] * mm, d2[1] * mm); pdf.line(d1[0] * mm, d1[1] * mm, d2[0] * mm, d2[1] * mm)
        pdf.setFont("GUJIAN_CN", 6.2); pdf.drawCentredString((d1[0] + d2[0]) / 2 * mm, (d1[1] + 1.2) * mm, primitive.get("text") or "")
    elif kind == "dimV":
        p1 = _paper_xy((primitive["x"], primitive["y1"]), bbox, origin, scale); p2 = _paper_xy((primitive["x"], primitive["y2"]), bbox, origin, scale)
        d1 = _paper_xy((primitive["x"] + primitive["offset"], primitive["y1"]), bbox, origin, scale); d2 = _paper_xy((primitive["x"] + primitive["offset"], primitive["y2"]), bbox, origin, scale)
        pdf.line(p1[0] * mm, p1[1] * mm, d1[0] * mm, d1[1] * mm); pdf.line(p2[0] * mm, p2[1] * mm, d2[0] * mm, d2[1] * mm); pdf.line(d1[0] * mm, d1[1] * mm, d2[0] * mm, d2[1] * mm)
        pdf.saveState(); pdf.setFont("GUJIAN_CN", 6.2); pdf.translate((d1[0] + 1.2) * mm, (d1[1] + d2[1]) / 2 * mm); pdf.rotate(90); pdf.drawCentredString(0, 0, primitive.get("text") or ""); pdf.restoreState()


VIEW_LAYOUT = {
    "frontElevation": {"bbox": (-7800, -2500, 7800, 9800), "origin": (15, 305), "scale": 42.0, "title": "南立面 1:50"},
    "transverseSection": {"bbox": (-6500, -2500, 6500, 9800), "origin": (400, 305), "scale": 42.0, "title": "横剖面 1:50"},
    "eaveDetail": {"bbox": (-600, -1400, 5200, 6100), "origin": (15, 30), "scale": 31.0, "title": "檐口构造详图 1:20"},
    "roofPlan": {"bbox": (-7800, -7000, 7800, 7000), "origin": (285, 30), "scale": 55.0, "title": "屋顶平面 1:50"},
}


def write_pdf(path: Path, spec: dict, views: dict[str, list[dict]]) -> None:
    pdfmetrics.registerFont(TTFont("GUJIAN_CN", str(FONT_PATH)))
    pdf = canvas.Canvas(str(path), pagesize=landscape(A1), pageCompression=1)
    pdf.setTitle(f"{spec['name']} - T0-B L1")
    pdf.setAuthor("古建保护成果工作台")
    pdf.rect(10 * mm, 10 * mm, 821 * mm, 574 * mm, stroke=1, fill=0)
    for name, primitives in views.items():
        layout = VIEW_LAYOUT[name]
        for primitive in primitives:
            _pdf_primitive(pdf, primitive, layout["bbox"], layout["origin"], layout["scale"])
        pdf.setFont("GUJIAN_CN", 9)
        pdf.drawString(layout["origin"][0] * mm, (layout["origin"][1] + (layout["bbox"][3] - layout["bbox"][1]) / layout["scale"] + 3) * mm, layout["title"])
    pdf.setLineWidth(0.35 * mm)
    pdf.rect(610 * mm, 30 * mm, 211 * mm, 220 * mm, stroke=1, fill=0)
    rows = [
        (235, "T0-B 古建局部专业样板"), (215, spec["name"]), (195, "质量等级：L1   来源：DEMO"),
        (175, "图号：T0B-01   图幅：A1"), (155, "单位：mm   比例：见图名"),
        (130, "同源：三维 / 立面 / 剖面 / 详图 / CAD"), (105, "状态：不得用于正式设计、施工或保护工程"),
        (70, "检查：对象、曲面屋面、瓦作、木构、标注、来源"), (45, "2026-08-11"),
    ]
    pdf.setFont("GUJIAN_CN", 8)
    for y, value in rows:
        pdf.drawString(620 * mm, y * mm, value)
    pdf.save()


def _svg_line(parts, a, b, width, colour="#202124", dash=None):
    dash_attr = f' stroke-dasharray="{dash}"' if dash else ""
    parts.append(f'<line x1="{a[0]:.3f}" y1="{594-a[1]:.3f}" x2="{b[0]:.3f}" y2="{594-b[1]:.3f}" stroke="{colour}" stroke-width="{width:.3f}"{dash_attr}/>' )


def _svg_primitive(parts, primitive, bbox, origin, scale):
    kind = primitive["kind"]; layer = primitive["layer"]; colour = "#a32020" if layer == "A-DAMAGE" else "#202124"; width = _line_width(layer)
    if kind == "line":
        _svg_line(parts, _paper_xy(primitive["a"], bbox, origin, scale), _paper_xy(primitive["b"], bbox, origin, scale), width, colour, "4 2" if layer == "A-AXIS" else None)
    elif kind == "poly":
        pts = [_paper_xy(p, bbox, origin, scale) for p in primitive["points"]]
        encoded = " ".join(f"{x:.3f},{594-y:.3f}" for x, y in pts)
        tag = "polygon" if primitive.get("closed") else "polyline"
        parts.append(f'<{tag} points="{encoded}" fill="none" stroke="{colour}" stroke-width="{width:.3f}"/>')
    elif kind in {"rect", "hatchRect"}:
        x, y = _paper_xy((primitive["x"], primitive["y"]), bbox, origin, scale); w = primitive["width"] / scale; h = primitive["height"] / scale
        fill = 'url(#hatch)' if kind == "hatchRect" else "none"
        parts.append(f'<rect x="{x:.3f}" y="{594-y-h:.3f}" width="{w:.3f}" height="{h:.3f}" fill="{fill}" stroke="{colour}" stroke-width="{width:.3f}"/>')
    elif kind == "circle":
        x, y = _paper_xy(primitive["center"], bbox, origin, scale); r = primitive["radius"] / scale
        parts.append(f'<circle cx="{x:.3f}" cy="{594-y:.3f}" r="{r:.3f}" fill="none" stroke="{colour}" stroke-width="{width:.3f}"/>')
    elif kind == "text":
        x, y = _paper_xy(primitive["point"], bbox, origin, scale); size = max(2.2, primitive["height"] / scale)
        parts.append(f'<text x="{x:.3f}" y="{594-y:.3f}" font-family="SimHei, sans-serif" font-size="{size:.3f}" fill="{colour}">{html.escape(primitive["text"])}</text>')
    elif kind == "block":
        x, y = _paper_xy(primitive["point"], bbox, origin, scale); s = primitive["scale"] / scale
        parts.append(f'<rect x="{x-520*s:.3f}" y="{594-y-180*s:.3f}" width="{1040*s:.3f}" height="{180*s:.3f}" fill="none" stroke="{colour}" stroke-width="{width:.3f}"/>')
        parts.append(f'<rect x="{x-330*s:.3f}" y="{594-y-360*s:.3f}" width="{660*s:.3f}" height="{180*s:.3f}" fill="none" stroke="{colour}" stroke-width="{width:.3f}"/>')
    elif kind == "dimH":
        p1 = _paper_xy((primitive["x1"], primitive["y"]), bbox, origin, scale); p2 = _paper_xy((primitive["x2"], primitive["y"]), bbox, origin, scale); d1 = _paper_xy((primitive["x1"], primitive["offset"]), bbox, origin, scale); d2 = _paper_xy((primitive["x2"], primitive["offset"]), bbox, origin, scale)
        for a, b in ((p1, d1), (p2, d2), (d1, d2)): _svg_line(parts, a, b, width, colour)
        parts.append(f'<text x="{(d1[0]+d2[0])/2:.3f}" y="{594-d1[1]-1.2:.3f}" text-anchor="middle" font-family="SimHei, sans-serif" font-size="2.6">{html.escape(primitive.get("text") or "")}</text>')
    elif kind == "dimV":
        p1 = _paper_xy((primitive["x"], primitive["y1"]), bbox, origin, scale); p2 = _paper_xy((primitive["x"], primitive["y2"]), bbox, origin, scale); d1 = _paper_xy((primitive["x"] + primitive["offset"], primitive["y1"]), bbox, origin, scale); d2 = _paper_xy((primitive["x"] + primitive["offset"], primitive["y2"]), bbox, origin, scale)
        for a, b in ((p1, d1), (p2, d2), (d1, d2)): _svg_line(parts, a, b, width, colour)


def write_svg(path: Path, spec: dict, views: dict[str, list[dict]]) -> None:
    parts = ['<svg xmlns="http://www.w3.org/2000/svg" width="841mm" height="594mm" viewBox="0 0 841 594" role="img" aria-label="T0-B professional heritage drawing">', '<defs><pattern id="hatch" width="3" height="3" patternUnits="userSpaceOnUse" patternTransform="rotate(45)"><line x1="0" y1="0" x2="0" y2="3" stroke="#777" stroke-width="0.12"/></pattern></defs>', '<rect x="10" y="10" width="821" height="574" fill="white" stroke="#111" stroke-width="0.5"/>']
    for name, primitives in views.items():
        layout = VIEW_LAYOUT[name]
        for primitive in primitives:
            _svg_primitive(parts, primitive, layout["bbox"], layout["origin"], layout["scale"])
        top = layout["origin"][1] + (layout["bbox"][3] - layout["bbox"][1]) / layout["scale"] + 3
        parts.append(f'<text x="{layout["origin"][0]}" y="{594-top}" font-family="SimHei, sans-serif" font-size="3.5">{layout["title"]}</text>')
    parts.append('<rect x="610" y="344" width="211" height="220" fill="none" stroke="#111" stroke-width="0.35"/>')
    for index, value in enumerate(("T0-B 古建局部专业样板", spec["name"], "质量等级：L1 / DEMO ONLY", "同源三维、立面、剖面、详图与 CAD", "不得用于正式设计、施工或保护工程")):
        parts.append(f'<text x="620" y="{365 + index * 18}" font-family="SimHei, sans-serif" font-size="3.2">{html.escape(value)}</text>')
    parts.append("</svg>")
    path.write_text("\n".join(parts) + "\n", encoding="utf-8")


def write_glb(path: Path, objects: list[ModelObject]) -> dict:
    scene = trimesh.Scene()
    categories: dict[str, int] = {}
    z_up_to_gltf_y_up = np.array([
        [1.0, 0.0, 0.0, 0.0],
        [0.0, 0.0, 1.0, 0.0],
        [0.0, -1.0, 0.0, 0.0],
        [0.0, 0.0, 0.0, 1.0],
    ])
    for record in objects:
        gltf_mesh = record.mesh.copy()
        gltf_mesh.apply_transform(z_up_to_gltf_y_up)
        gltf_mesh.metadata.update({"entityId": record.entity_id, "category": record.category, "producerType": "demo", "sourceCoordinateSystem": "Z_UP_MM"})
        scene.add_geometry(gltf_mesh, node_name=f"{record.category}|{record.key}|{record.entity_id}", geom_name=record.entity_id)
        categories[record.category] = categories.get(record.category, 0) + 1
    path.write_bytes(scene.export(file_type="glb"))
    bounds = scene.bounds.tolist()
    return {"meshObjects": len(objects), "categories": categories, "bounds": bounds}


def generate(spec_path: Path, output: Path) -> dict:
    if output.exists():
        raise FileExistsError(f"output already exists: {output}")
    spec = load_spec(spec_path)
    stage = output.parent / f".{output.name}.staging-{uuid.uuid4().hex}"
    stage.mkdir(parents=True)
    try:
        objects = build_model(spec)
        views = build_views(spec)
        geometry = {
            "schemaVersion": "t0b-geometry-1", "gate": "T0-B", "qualityLevel": "L1",
            "projectId": spec["projectId"], "fixtureId": spec["fixtureId"], "producerType": "demo",
            "specHash": spec_hash(spec), "sourceRefs": spec["sourceRefs"],
            "objects": [{"key": item.key, "entityId": item.entity_id, "category": item.category, "name": item.name, "producerType": "demo", "sourceRefs": spec["sourceRefs"]} for item in objects],
            "views": views,
        }
        (stage / "geometry.json").write_text(json.dumps(geometry, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
        glb_stats = write_glb(stage / "t0b-professional-hall.glb", objects)
        dxf_stats = write_dxf(stage / "t0b-professional-sheet.dxf", spec, views)
        write_svg(stage / "t0b-professional-sheet.svg", spec, views)
        write_pdf(stage / "t0b-professional-sheet.pdf", spec, views)
        artifacts = [{"path": item.name, "bytes": item.stat().st_size, "sha256": _hash_file(item)} for item in sorted(stage.iterdir()) if item.is_file()]
        manifest = {
            "schemaVersion": "t0b-manifest-1", "generatorVersion": GENERATOR_VERSION,
            "gate": "T0-B", "qualityLevel": "L1", "localProfessionalSampleEligible": True,
            "professionalDeliverableEligible": False,
            "formalEligibility": False, "producerType": "demo", "projectId": spec["projectId"],
            "fixtureId": spec["fixtureId"], "specHash": spec_hash(spec), "sourceRefs": spec["sourceRefs"],
            "objectCount": len(objects), "entityMap": {item.key: item.entity_id for item in objects},
            "glb": glb_stats, "dxf": dxf_stats,
            "environment": {"python": sys.version.split()[0], "ezdxf": ezdxf.__version__, "trimesh": trimesh.__version__, "font": {"path": str(FONT_PATH), "sha256": _hash_file(FONT_PATH)}, "pdfBackend": "ReportLab canvas"},
            "artifacts": artifacts,
        }
        (stage / "manifest.json").write_text(json.dumps(manifest, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
        stage.replace(output)
        return manifest
    except Exception:
        if stage.exists() and stage.parent == output.parent and stage.name.startswith(f".{output.name}.staging-"):
            shutil.rmtree(stage)
        raise


def main() -> int:
    parser = argparse.ArgumentParser(description="Generate the T0-B professional heritage sample")
    parser.add_argument("--spec", type=Path, required=True)
    parser.add_argument("--output", type=Path, required=True)
    args = parser.parse_args()
    try:
        manifest = generate(args.spec.resolve(), args.output.resolve())
        print(json.dumps({"status": "ok", "gate": manifest["gate"], "qualityLevel": manifest["qualityLevel"], "objects": manifest["objectCount"]}, ensure_ascii=False))
        return 0
    except Exception as exc:
        print(json.dumps({"status": "error", "type": exc.__class__.__name__, "reason": str(exc)}, ensure_ascii=False), file=sys.stderr)
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
