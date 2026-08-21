from __future__ import annotations

import argparse
from hashlib import sha256
import json
import math
from pathlib import Path
import shutil
import sys
import time
import uuid
import xml.etree.ElementTree as ET

import ezdxf
from ezdxf.enums import TextEntityAlignment
import ifcopenshell
import ifcopenshell.geom
import numpy as np
from reportlab.lib.colors import HexColor
from reportlab.lib.units import mm
from reportlab.pdfbase import pdfmetrics
from reportlab.pdfbase.ttfonts import TTFont
from reportlab.pdfgen import canvas
import reportlab
import trimesh

from t0_model import BoxObject, MeshObject, build_objects, build_views, canonical_json, load_spec, serialise_geometry, spec_hash, stable_ifc_guid


GENERATOR_VERSION = "t0-spike-1"
FONT_PATH = Path("C:/Windows/Fonts/simhei.ttf")
SHEET_WIDTH_MM = 841.0
SHEET_HEIGHT_MM = 594.0
VIEW_SCALE = 50.0


class CancelledError(RuntimeError):
    pass


def _hash_file(path: Path) -> str:
    digest = sha256()
    with path.open("rb") as stream:
        for chunk in iter(lambda: stream.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def _check_cancel(cancel_file: Path | None) -> None:
    if cancel_file and cancel_file.exists():
        raise CancelledError("generation cancelled")


def _hold_with_cancel(milliseconds: int, cancel_file: Path | None) -> None:
    remaining = max(0, milliseconds) / 1000
    while remaining > 0:
        _check_cancel(cancel_file)
        interval = min(0.05, remaining)
        time.sleep(interval)
        remaining -= interval


def _point3(model: ifcopenshell.file, xyz) -> object:
    return model.create_entity("IfcCartesianPoint", Coordinates=tuple(float(v) for v in xyz))


def _direction(model: ifcopenshell.file, xyz) -> object:
    return model.create_entity("IfcDirection", DirectionRatios=tuple(float(v) for v in xyz))


def _axis3(model: ifcopenshell.file, xyz=(0.0, 0.0, 0.0)) -> object:
    return model.create_entity(
        "IfcAxis2Placement3D",
        Location=_point3(model, xyz),
        Axis=_direction(model, (0.0, 0.0, 1.0)),
        RefDirection=_direction(model, (1.0, 0.0, 0.0)),
    )


def _placement(model: ifcopenshell.file, relative_to=None, xyz=(0.0, 0.0, 0.0)) -> object:
    return model.create_entity("IfcLocalPlacement", PlacementRelTo=relative_to, RelativePlacement=_axis3(model, xyz))


def _box_representation(model: ifcopenshell.file, context, size_m) -> object:
    x, y, z = (float(v) for v in size_m)
    axis2 = model.create_entity(
        "IfcAxis2Placement2D",
        Location=model.create_entity("IfcCartesianPoint", Coordinates=(0.0, 0.0)),
        RefDirection=model.create_entity("IfcDirection", DirectionRatios=(1.0, 0.0)),
    )
    profile = model.create_entity("IfcRectangleProfileDef", ProfileType="AREA", Position=axis2, XDim=x, YDim=y)
    solid = model.create_entity(
        "IfcExtrudedAreaSolid",
        SweptArea=profile,
        Position=_axis3(model),
        ExtrudedDirection=_direction(model, (0.0, 0.0, 1.0)),
        Depth=z,
    )
    shape = model.create_entity(
        "IfcShapeRepresentation",
        ContextOfItems=context,
        RepresentationIdentifier="Body",
        RepresentationType="SweptSolid",
        Items=(solid,),
    )
    return model.create_entity("IfcProductDefinitionShape", Representations=(shape,))


def _mesh_representation(model: ifcopenshell.file, context, vertices_m, faces) -> object:
    points = model.create_entity("IfcCartesianPointList3D", CoordList=tuple(tuple(float(v) for v in point) for point in vertices_m))
    face_set = model.create_entity(
        "IfcTriangulatedFaceSet",
        Coordinates=points,
        Closed=True,
        CoordIndex=tuple(tuple(int(index) + 1 for index in face) for face in faces),
    )
    shape = model.create_entity(
        "IfcShapeRepresentation",
        ContextOfItems=context,
        RepresentationIdentifier="Body",
        RepresentationType="Tessellation",
        Items=(face_set,),
    )
    return model.create_entity("IfcProductDefinitionShape", Representations=(shape,))


def _add_source_properties(model: ifcopenshell.file, spec: dict, product, key: str, entity_id: str) -> None:
    properties = (
        model.create_entity("IfcPropertySingleValue", Name="EntityId", NominalValue=model.create_entity("IfcIdentifier", entity_id)),
        model.create_entity("IfcPropertySingleValue", Name="ProducerType", NominalValue=model.create_entity("IfcLabel", "demo")),
        model.create_entity("IfcPropertySingleValue", Name="FixtureId", NominalValue=model.create_entity("IfcIdentifier", spec["fixtureId"])),
        model.create_entity("IfcPropertySingleValue", Name="SourceKey", NominalValue=model.create_entity("IfcIdentifier", key)),
        model.create_entity("IfcPropertySingleValue", Name="SpecHash", NominalValue=model.create_entity("IfcIdentifier", spec_hash(spec))),
    )
    pset = model.create_entity(
        "IfcPropertySet",
        GlobalId=stable_ifc_guid(spec, f"pset:{key}"),
        Name="Pset_GuJianSource",
        HasProperties=properties,
    )
    model.create_entity(
        "IfcRelDefinesByProperties",
        GlobalId=stable_ifc_guid(spec, f"rel:pset:{key}"),
        RelatedObjects=(product,),
        RelatingPropertyDefinition=pset,
    )


def write_ifc(path: Path, spec: dict, objects: list[BoxObject | MeshObject]) -> None:
    model = ifcopenshell.file(schema="IFC4")
    length_unit = model.create_entity("IfcSIUnit", UnitType="LENGTHUNIT", Name="METRE")
    angle_unit = model.create_entity("IfcSIUnit", UnitType="PLANEANGLEUNIT", Name="RADIAN")
    units = model.create_entity("IfcUnitAssignment", Units=(length_unit, angle_unit))
    context = model.create_entity(
        "IfcGeometricRepresentationContext",
        ContextIdentifier="Model",
        ContextType="Model",
        CoordinateSpaceDimension=3,
        Precision=1e-5,
        WorldCoordinateSystem=_axis3(model),
        TrueNorth=_direction(model, (0.0, 1.0)),
    )
    project = model.create_entity(
        "IfcProject",
        GlobalId=stable_ifc_guid(spec, "spatial:project"),
        Name=spec["name"],
        LongName="T0 CAD feasibility fixture; DEMO ONLY",
        RepresentationContexts=(context,),
        UnitsInContext=units,
    )
    site = model.create_entity(
        "IfcSite",
        GlobalId=stable_ifc_guid(spec, "spatial:site"),
        Name="试验场地",
        ObjectPlacement=_placement(model),
        CompositionType="ELEMENT",
    )
    building = model.create_entity(
        "IfcBuilding",
        GlobalId=stable_ifc_guid(spec, "spatial:building"),
        Name=spec["name"],
        ObjectPlacement=_placement(model, site.ObjectPlacement),
        CompositionType="ELEMENT",
    )
    storey = model.create_entity(
        "IfcBuildingStorey",
        GlobalId=stable_ifc_guid(spec, "spatial:storey"),
        Name="首层",
        ObjectPlacement=_placement(model, building.ObjectPlacement),
        CompositionType="ELEMENT",
        Elevation=0.0,
    )
    model.create_entity("IfcRelAggregates", GlobalId=stable_ifc_guid(spec, "rel:project-site"), RelatingObject=project, RelatedObjects=(site,))
    model.create_entity("IfcRelAggregates", GlobalId=stable_ifc_guid(spec, "rel:site-building"), RelatingObject=site, RelatedObjects=(building,))
    model.create_entity("IfcRelAggregates", GlobalId=stable_ifc_guid(spec, "rel:building-storey"), RelatingObject=building, RelatedObjects=(storey,))

    products = []
    for item in objects:
        if isinstance(item, BoxObject):
            center_m = tuple(v / 1000 for v in item.center_mm)
            size_m = tuple(v / 1000 for v in item.size_mm)
            base = (center_m[0], center_m[1], center_m[2] - size_m[2] / 2)
            representation = _box_representation(model, context, size_m)
            placement = _placement(model, storey.ObjectPlacement, base)
        else:
            vertices_m = tuple(tuple(v / 1000 for v in point) for point in item.vertices_mm)
            representation = _mesh_representation(model, context, vertices_m, item.faces)
            placement = _placement(model, storey.ObjectPlacement)
        product = model.create_entity(
            item.ifc_class,
            GlobalId=item.ifc_guid,
            Name=item.name,
            ObjectPlacement=placement,
            Representation=representation,
            Tag=item.entity_id,
        )
        products.append(product)
        _add_source_properties(model, spec, product, item.key, item.entity_id)

    model.create_entity(
        "IfcRelContainedInSpatialStructure",
        GlobalId=stable_ifc_guid(spec, "rel:storey-elements"),
        RelatedElements=tuple(products),
        RelatingStructure=storey,
    )
    model.header.file_description.description = ("ViewDefinition [ReferenceView_V1.2]",)
    model.header.file_name.name = "t0-minimal-hall.ifc"
    model.header.file_name.time_stamp = spec["frozenAt"].replace("Z", "")
    model.header.file_name.author = ("JIAJIA",)
    model.header.file_name.organization = ("GuJian Workbench T0",)
    model.header.file_name.preprocessor_version = f"IfcOpenShell {ifcopenshell.version}"
    model.header.file_name.originating_system = GENERATOR_VERSION
    model.write(str(path))


def write_glb_from_ifc(ifc_path: Path, glb_path: Path, objects: list[BoxObject | MeshObject]) -> dict:
    model = ifcopenshell.open(str(ifc_path))
    settings = ifcopenshell.geom.settings()
    settings.set(settings.USE_WORLD_COORDS, True)
    colours = {item.entity_id: item.colour for item in objects}
    scene = trimesh.Scene()
    vertex_total = 0
    face_total = 0
    failures: list[str] = []
    for product in model.by_type("IfcElement"):
        if not product.Representation:
            continue
        try:
            shape = ifcopenshell.geom.create_shape(settings, product)
            vertices = np.asarray(shape.geometry.verts, dtype=float).reshape((-1, 3))
            faces = np.asarray(shape.geometry.faces, dtype=int).reshape((-1, 3))
            mesh = trimesh.Trimesh(vertices=vertices, faces=faces, process=False)
            colour = colours.get(product.Tag, (128, 128, 128))
            mesh.visual.face_colors = np.tile(np.asarray((*colour, 255), dtype=np.uint8), (len(faces), 1))
            scene.add_geometry(mesh, node_name=product.Tag, geom_name=product.Tag)
            vertex_total += len(vertices)
            face_total += len(faces)
        except Exception as exc:  # pragma: no cover - surfaced in verification report
            failures.append(f"{product.Tag}: {exc}")
    if failures or not scene.geometry:
        raise RuntimeError(f"IfcOpenShell geometry failures: {failures}")
    glb_path.write_bytes(scene.export(file_type="glb"))
    return {
        "geometryCount": len(scene.geometry),
        "vertexCount": vertex_total,
        "faceCount": face_total,
        "usePythonOpenCascade": False,
    }


LAYER_CONFIG = {
    "A-WALL": (7, 35, "CONTINUOUS"),
    "A-COLS": (1, 50, "CONTINUOUS"),
    "A-BEAM": (30, 35, "CONTINUOUS"),
    "A-OPEN": (4, 25, "CONTINUOUS"),
    "A-ROOF": (8, 35, "CONTINUOUS"),
    "A-GRID": (3, 18, "DASHED"),
    "A-GROUND": (7, 50, "CONTINUOUS"),
    "A-DIMS": (2, 18, "CONTINUOUS"),
    "A-TEXT": (7, 18, "CONTINUOUS"),
    "A-TITLE": (7, 35, "CONTINUOUS"),
}


def _set_xdata(entity, primitive: dict) -> None:
    if primitive.get("entityId"):
        entity.set_xdata("GUJIAN", [(1000, primitive["entityId"]), (1000, "demo")])


def _draw_dxf_view(msp, primitives: list[dict], offset_x: float) -> None:
    for primitive in primitives:
        layer = primitive["layer"]
        if primitive["kind"] == "rect":
            x = offset_x + primitive["x"]
            y = primitive["y"]
            w = primitive["width"]
            h = primitive["height"]
            entity = msp.add_lwpolyline(((x, y), (x + w, y), (x + w, y + h), (x, y + h)), close=True, dxfattribs={"layer": layer})
        else:
            entity = msp.add_lwpolyline(((offset_x + x, y) for x, y in primitive["points"]), close=primitive.get("closed", False), dxfattribs={"layer": layer})
        _set_xdata(entity, primitive)


def write_dxf(path: Path, spec: dict, views: dict[str, list[dict]]) -> None:
    doc = ezdxf.new("R2018")
    doc.units = ezdxf.units.MM
    doc.header["$INSUNITS"] = 4
    doc.header["$MEASUREMENT"] = 1
    doc.appids.add("GUJIAN")
    if "DASHED" not in doc.linetypes:
        doc.linetypes.add("DASHED", pattern=[0.75, 0.5, -0.25], description="Dashed 0.5 / 0.25")
    for name, (colour, lineweight, linetype) in LAYER_CONFIG.items():
        if name not in doc.layers:
            doc.layers.add(name, color=colour, lineweight=lineweight, linetype=linetype)
    if "GUJIAN_CN" not in doc.styles:
        doc.styles.add("GUJIAN_CN", font="simhei.ttf")
    dimstyle = doc.dimstyles.new("GUJIAN_100", dxfattribs={
        "dimtxt": 250,
        "dimasz": 150,
        "dimexe": 100,
        "dimexo": 80,
        "dimdec": 0,
        "dimtxsty": "GUJIAN_CN",
    })

    offsets = {"plan": 0.0, "elevation": 16000.0, "section": 30000.0}
    msp = doc.modelspace()
    for name, primitives in views.items():
        _draw_dxf_view(msp, primitives, offsets[name])

    width = sum(float(v) for v in spec["bays"])
    depth = float(spec["depth"])
    xs = [0.0]
    for span in spec["bays"]:
        xs.append(xs[-1] + float(span))
    for x0, x1 in zip(xs, xs[1:]):
        msp.add_linear_dim(base=(0, -1200), p1=(x0, 0), p2=(x1, 0), angle=0, dimstyle="GUJIAN_100", override={"dimtad": 1}).render()
    msp.add_linear_dim(base=(0, -2200), p1=(0, 0), p2=(width, 0), angle=0, dimstyle="GUJIAN_100", override={"dimtad": 1}).render()
    msp.add_linear_dim(base=(-1800, 0), p1=(0, 0), p2=(0, depth), angle=90, dimstyle="GUJIAN_100", override={"dimtad": 1}).render()
    msp.add_linear_dim(base=(16000 + width + 1800, 0), p1=(16000 + width, 0), p2=(16000 + width, float(spec["ridgeHeight"])), angle=90, dimstyle="GUJIAN_100", override={"dimtad": 1}).render()

    for text, insert in (
        ("首层平面 1:50", (width / 2, depth + 1800)),
        ("南立面 1:50", (16000 + width / 2, float(spec["ridgeHeight"]) + 1000)),
        ("A-A 剖面 1:50", (30000 + depth / 2, float(spec["ridgeHeight"]) + 1000)),
    ):
        msp.add_text(text, height=350, dxfattribs={"layer": "A-TEXT", "style": "GUJIAN_CN"}).set_placement(insert, align=TextEntityAlignment.MIDDLE_CENTER)

    psp = doc.layouts.new("A1-T0")
    psp.page_setup(size=(SHEET_WIDTH_MM, SHEET_HEIGHT_MM), margins=(10, 10, 10, 10), units="mm", name="A1 landscape")
    psp.add_lwpolyline(((10, 10), (831, 10), (831, 584), (10, 584)), close=True, dxfattribs={"layer": "A-TITLE"})
    psp.add_viewport(center=(210, 420), size=(370, 260), view_center_point=(width / 2, depth / 2), view_height=13000, status=2)
    psp.add_viewport(center=(620, 420), size=(370, 260), view_center_point=(16000 + width / 2, float(spec["ridgeHeight"]) / 2), view_height=13000, status=3)
    psp.add_viewport(center=(210, 155), size=(370, 220), view_center_point=(30000 + depth / 2, float(spec["ridgeHeight"]) / 2), view_height=11000, status=4)
    title_x, title_y, title_w, title_h = 430.0, 25.0, 390.0, 110.0
    psp.add_lwpolyline(((title_x, title_y), (title_x + title_w, title_y), (title_x + title_w, title_y + title_h), (title_x, title_y + title_h)), close=True, dxfattribs={"layer": "A-TITLE"})
    for y in (title_y + 30, title_y + 60, title_y + 85):
        psp.add_line((title_x, y), (title_x + title_w, y), dxfattribs={"layer": "A-TITLE"})
    for text, point, height in (
        (spec["name"], (title_x + 8, title_y + 92), 5.0),
        ("T0 CAD 可行性验证 / DEMO ONLY", (title_x + 8, title_y + 68), 3.5),
        ("图号 T0-01    比例 1:50", (title_x + 8, title_y + 38), 3.5),
        ("来源：参数化演示数据；不得用于正式成果", (title_x + 8, title_y + 10), 3.5),
    ):
        psp.add_text(text, height=height, dxfattribs={"layer": "A-TEXT", "style": "GUJIAN_CN"}).set_placement(point, align=TextEntityAlignment.LEFT)
    doc.saveas(path)


def _sheet_primitives(spec: dict, views: dict[str, list[dict]]) -> list[dict]:
    placements = {
        "plan": (45.0, 330.0),
        "elevation": (425.0, 330.0),
        "section": (60.0, 95.0),
    }
    result: list[dict] = [
        {"kind": "rect", "x": 10.0, "y": 10.0, "width": 821.0, "height": 574.0, "layer": "A-TITLE"},
    ]
    for view_name, primitives in views.items():
        ox, oy = placements[view_name]
        for primitive in primitives:
            if primitive["kind"] == "rect":
                result.append({
                    "kind": "rect",
                    "x": ox + primitive["x"] / VIEW_SCALE,
                    "y": oy + primitive["y"] / VIEW_SCALE,
                    "width": primitive["width"] / VIEW_SCALE,
                    "height": primitive["height"] / VIEW_SCALE,
                    "layer": primitive["layer"],
                    "entityId": primitive.get("entityId"),
                })
            else:
                result.append({
                    "kind": "polyline",
                    "points": [[ox + x / VIEW_SCALE, oy + y / VIEW_SCALE] for x, y in primitive["points"]],
                    "layer": primitive["layer"],
                    "entityId": primitive.get("entityId"),
                })
    result.extend((
        {"kind": "text", "x": 145.0, "y": 535.0, "text": "首层平面 1:50", "size": 5.0, "layer": "A-TEXT", "anchor": "middle"},
        {"kind": "text", "x": 540.0, "y": 490.0, "text": "南立面 1:50", "size": 5.0, "layer": "A-TEXT", "anchor": "middle"},
        {"kind": "text", "x": 140.0, "y": 250.0, "text": "A-A 剖面 1:50", "size": 5.0, "layer": "A-TEXT", "anchor": "middle"},
        {"kind": "rect", "x": 430.0, "y": 25.0, "width": 390.0, "height": 110.0, "layer": "A-TITLE"},
        {"kind": "line", "x1": 430.0, "y1": 55.0, "x2": 820.0, "y2": 55.0, "layer": "A-TITLE"},
        {"kind": "line", "x1": 430.0, "y1": 85.0, "x2": 820.0, "y2": 85.0, "layer": "A-TITLE"},
        {"kind": "line", "x1": 430.0, "y1": 110.0, "x2": 820.0, "y2": 110.0, "layer": "A-TITLE"},
        {"kind": "text", "x": 438.0, "y": 117.0, "text": spec["name"], "size": 5.0, "layer": "A-TEXT"},
        {"kind": "text", "x": 438.0, "y": 92.0, "text": "T0 CAD 可行性验证 / DEMO ONLY", "size": 3.5, "layer": "A-TEXT"},
        {"kind": "text", "x": 438.0, "y": 63.0, "text": "图号 T0-01    比例 1:50", "size": 3.5, "layer": "A-TEXT"},
        {"kind": "text", "x": 438.0, "y": 35.0, "text": "来源：参数化演示数据；不得用于正式成果", "size": 3.5, "layer": "A-TEXT"},
    ))

    xs = [0.0]
    for span in spec["bays"]:
        xs.append(xs[-1] + float(span))
    plan_x, plan_y = placements["plan"]
    for index, (x0, x1) in enumerate(zip(xs, xs[1:])):
        px0 = plan_x + x0 / VIEW_SCALE
        px1 = plan_x + x1 / VIEW_SCALE
        result.extend((
            {"kind": "line", "x1": px0, "y1": plan_y - 3.0, "x2": px0, "y2": plan_y - 16.0, "layer": "A-DIMS"},
            {"kind": "line", "x1": px0, "y1": plan_y - 12.0, "x2": px1, "y2": plan_y - 12.0, "layer": "A-DIMS"},
            {"kind": "text", "x": (px0 + px1) / 2, "y": plan_y - 10.0, "text": str(int(float(spec["bays"][index]))), "size": 3.0, "layer": "A-DIMS", "anchor": "middle"},
        ))
    last_x = plan_x + xs[-1] / VIEW_SCALE
    result.extend((
        {"kind": "line", "x1": last_x, "y1": plan_y - 3.0, "x2": last_x, "y2": plan_y - 24.0, "layer": "A-DIMS"},
        {"kind": "line", "x1": plan_x, "y1": plan_y - 22.0, "x2": last_x, "y2": plan_y - 22.0, "layer": "A-DIMS"},
        {"kind": "text", "x": (plan_x + last_x) / 2, "y": plan_y - 20.0, "text": str(int(xs[-1])), "size": 3.2, "layer": "A-DIMS", "anchor": "middle"},
    ))

    depth_top = plan_y + float(spec["depth"]) / VIEW_SCALE
    result.extend((
        {"kind": "line", "x1": plan_x - 15.0, "y1": plan_y, "x2": plan_x - 15.0, "y2": depth_top, "layer": "A-DIMS"},
        {"kind": "line", "x1": plan_x - 18.0, "y1": plan_y, "x2": plan_x - 3.0, "y2": plan_y, "layer": "A-DIMS"},
        {"kind": "line", "x1": plan_x - 18.0, "y1": depth_top, "x2": plan_x - 3.0, "y2": depth_top, "layer": "A-DIMS"},
        {"kind": "text", "x": plan_x - 12.0, "y": (plan_y + depth_top) / 2, "text": str(int(spec["depth"])), "size": 3.2, "layer": "A-DIMS", "anchor": "middle"},
    ))

    section_x = plan_x + float(spec["sectionX"]) / VIEW_SCALE
    result.extend((
        {"kind": "line", "x1": section_x, "y1": plan_y - 5.0, "x2": section_x, "y2": depth_top + 5.0, "layer": "A-DIMS"},
        {"kind": "text", "x": section_x - 3.0, "y": depth_top + 8.0, "text": "A", "size": 3.5, "layer": "A-TEXT"},
        {"kind": "text", "x": section_x - 3.0, "y": plan_y - 10.0, "text": "A", "size": 3.5, "layer": "A-TEXT"},
        {"kind": "line", "x1": last_x + 25.0, "y1": depth_top - 5.0, "x2": last_x + 25.0, "y2": depth_top + 25.0, "layer": "A-TEXT"},
        {"kind": "polyline", "points": [[last_x + 21.0, depth_top + 18.0], [last_x + 25.0, depth_top + 25.0], [last_x + 29.0, depth_top + 18.0]], "layer": "A-TEXT"},
        {"kind": "text", "x": last_x + 25.0, "y": depth_top + 30.0, "text": "N", "size": 4.0, "layer": "A-TEXT", "anchor": "middle"},
    ))

    elevation_x = placements["elevation"][0]
    elevation_y = placements["elevation"][1]
    height_x = elevation_x + xs[-1] / VIEW_SCALE + 18.0
    height_top = elevation_y + float(spec["ridgeHeight"]) / VIEW_SCALE
    result.extend((
        {"kind": "line", "x1": height_x, "y1": elevation_y, "x2": height_x, "y2": height_top, "layer": "A-DIMS"},
        {"kind": "line", "x1": height_x - 4.0, "y1": elevation_y, "x2": height_x + 4.0, "y2": elevation_y, "layer": "A-DIMS"},
        {"kind": "line", "x1": height_x - 4.0, "y1": height_top, "x2": height_x + 4.0, "y2": height_top, "layer": "A-DIMS"},
        {"kind": "text", "x": height_x + 8.0, "y": (elevation_y + height_top) / 2, "text": str(int(spec["ridgeHeight"])), "size": 3.2, "layer": "A-DIMS"},
        {"kind": "text", "x": 300.0, "y": 215.0, "text": "验证：稳定对象 ID / IFC-GLB 同源 / DXF 平立剖 / 来源追踪", "size": 3.5, "layer": "A-TEXT"},
        {"kind": "text", "x": 300.0, "y": 200.0, "text": "单位：mm    图纸阶段：T0 技术样张    成果属性：DEMO", "size": 3.5, "layer": "A-TEXT"},
        {"kind": "text", "x": 300.0, "y": 185.0, "text": "后续专业交付仍需图纸规范、详图、表格和人工专业复核", "size": 3.5, "layer": "A-TEXT"},
    ))
    return result


def _style_for(layer: str) -> tuple[str, float, str | None]:
    if layer in {"A-COLS", "A-GROUND"}:
        return "#111827", 0.7, None
    if layer == "A-GRID":
        return "#64748b", 0.25, "4 2"
    if layer == "A-ROOF":
        return "#334155", 0.55, None
    if layer == "A-OPEN":
        return "#0f766e", 0.4, None
    return "#1f2937", 0.35, None


def write_svg(path: Path, spec: dict, views: dict[str, list[dict]]) -> None:
    ET.register_namespace("", "http://www.w3.org/2000/svg")
    root = ET.Element("{http://www.w3.org/2000/svg}svg", {
        "width": "841mm",
        "height": "594mm",
        "viewBox": f"0 0 {SHEET_WIDTH_MM:g} {SHEET_HEIGHT_MM:g}",
        "role": "img",
        "aria-label": "T0 CAD feasibility sheet",
    })
    metadata = ET.SubElement(root, "{http://www.w3.org/2000/svg}metadata")
    metadata.text = canonical_json({"producerType": "demo", "fixtureId": spec["fixtureId"], "specHash": spec_hash(spec)})
    group = ET.SubElement(root, "{http://www.w3.org/2000/svg}g", {"fill": "none", "font-family": "SimHei, sans-serif"})
    for primitive in _sheet_primitives(spec, views):
        colour, stroke_width, dash = _style_for(primitive["layer"])
        common = {"stroke": colour, "stroke-width": f"{stroke_width:g}", "data-layer": primitive["layer"]}
        if primitive.get("entityId"):
            common["data-entity-ref"] = primitive["entityId"]
        if dash:
            common["stroke-dasharray"] = dash
        kind = primitive["kind"]
        if kind == "rect":
            attrs = common | {
                "x": f"{primitive['x']:g}",
                "y": f"{SHEET_HEIGHT_MM - primitive['y'] - primitive['height']:g}",
                "width": f"{primitive['width']:g}",
                "height": f"{primitive['height']:g}",
            }
            ET.SubElement(group, "{http://www.w3.org/2000/svg}rect", attrs)
        elif kind == "polyline":
            points = " ".join(f"{x:g},{SHEET_HEIGHT_MM - y:g}" for x, y in primitive["points"])
            ET.SubElement(group, "{http://www.w3.org/2000/svg}polyline", common | {"points": points})
        elif kind == "line":
            ET.SubElement(group, "{http://www.w3.org/2000/svg}line", common | {
                "x1": f"{primitive['x1']:g}", "y1": f"{SHEET_HEIGHT_MM - primitive['y1']:g}",
                "x2": f"{primitive['x2']:g}", "y2": f"{SHEET_HEIGHT_MM - primitive['y2']:g}",
            })
        elif kind == "text":
            text = ET.SubElement(group, "{http://www.w3.org/2000/svg}text", {
                "x": f"{primitive['x']:g}",
                "y": f"{SHEET_HEIGHT_MM - primitive['y']:g}",
                "fill": "#111827",
                "stroke": "none",
                "font-size": f"{primitive['size']:g}",
                "text-anchor": primitive.get("anchor", "start"),
                "data-layer": primitive["layer"],
            })
            text.text = primitive["text"]
    ET.ElementTree(root).write(path, encoding="utf-8", xml_declaration=True)


def write_pdf(path: Path, spec: dict, views: dict[str, list[dict]]) -> None:
    pdfmetrics.registerFont(TTFont("SimHei", str(FONT_PATH)))
    drawing = canvas.Canvas(str(path), pagesize=(SHEET_WIDTH_MM * mm, SHEET_HEIGHT_MM * mm), pageCompression=1)
    drawing.setTitle(f"{spec['name']} - T0")
    drawing.setAuthor("GuJian Workbench T0")
    drawing.setSubject("DEMO ONLY; CAD feasibility")
    for primitive in _sheet_primitives(spec, views):
        colour, stroke_width, dash = _style_for(primitive["layer"])
        drawing.setStrokeColor(HexColor(colour))
        drawing.setLineWidth(stroke_width * mm)
        drawing.setDash([4 * mm, 2 * mm] if dash else [])
        kind = primitive["kind"]
        if kind == "rect":
            drawing.rect(primitive["x"] * mm, primitive["y"] * mm, primitive["width"] * mm, primitive["height"] * mm, stroke=1, fill=0)
        elif kind == "polyline":
            points = primitive["points"]
            path_obj = drawing.beginPath()
            path_obj.moveTo(points[0][0] * mm, points[0][1] * mm)
            for x, y in points[1:]:
                path_obj.lineTo(x * mm, y * mm)
            drawing.drawPath(path_obj, stroke=1, fill=0)
        elif kind == "line":
            drawing.line(primitive["x1"] * mm, primitive["y1"] * mm, primitive["x2"] * mm, primitive["y2"] * mm)
        elif kind == "text":
            drawing.setFillColor(HexColor("#111827"))
            drawing.setFont("SimHei", primitive["size"] * mm)
            if primitive.get("anchor") == "middle":
                drawing.drawCentredString(primitive["x"] * mm, primitive["y"] * mm, primitive["text"])
            else:
                drawing.drawString(primitive["x"] * mm, primitive["y"] * mm, primitive["text"])
    drawing.showPage()
    drawing.save()


def generate(spec_path: Path, output: Path, cancel_file: Path | None = None, hold_ms: int = 0) -> dict:
    spec = load_spec(spec_path)
    objects = build_objects(spec)
    views = build_views(spec, objects)
    output = output.resolve()
    output.parent.mkdir(parents=True, exist_ok=True)
    if output.exists():
        raise FileExistsError(f"output already exists: {output}")
    stage = output.parent / f".{output.name}.staging-{uuid.uuid4().hex}"
    stage.mkdir()
    try:
        _hold_with_cancel(hold_ms, cancel_file)
        geometry_path = stage / "geometry.json"
        geometry_path.write_text(json.dumps(serialise_geometry(spec, objects, views), ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
        _check_cancel(cancel_file)
        ifc_path = stage / "t0-minimal-hall.ifc"
        write_ifc(ifc_path, spec, objects)
        _check_cancel(cancel_file)
        occ_stats = write_glb_from_ifc(ifc_path, stage / "t0-minimal-hall.glb", objects)
        _check_cancel(cancel_file)
        write_dxf(stage / "t0-multiview-sheet.dxf", spec, views)
        _check_cancel(cancel_file)
        write_svg(stage / "t0-multiview-sheet.svg", spec, views)
        write_pdf(stage / "t0-multiview-sheet.pdf", spec, views)
        _check_cancel(cancel_file)

        artifacts = []
        for artifact in sorted(stage.iterdir(), key=lambda item: item.name):
            if artifact.is_file():
                artifacts.append({"path": artifact.name, "bytes": artifact.stat().st_size, "sha256": _hash_file(artifact)})
        manifest = {
            "schemaVersion": "t0-manifest-1",
            "generatorVersion": GENERATOR_VERSION,
            "gate": "T0-A",
            "qualityLevel": "L0",
            "professionalQualityEligible": False,
            "projectId": spec["projectId"],
            "specHash": spec_hash(spec),
            "producerType": "demo",
            "fixtureId": spec["fixtureId"],
            "objectCount": len(objects),
            "entityMap": {item.key: {"entityId": item.entity_id, "ifcGuid": item.ifc_guid} for item in objects},
            "occGeometry": occ_stats,
            "environment": {
                "python": sys.version.split()[0],
                "ifcopenshell": ifcopenshell.version,
                "ezdxf": ezdxf.__version__,
                "trimesh": trimesh.__version__,
                "reportlab": reportlab.Version,
                "font": {"path": str(FONT_PATH), "sha256": _hash_file(FONT_PATH)},
                "pdfBackend": "ReportLab canvas",
            },
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
    parser = argparse.ArgumentParser(description="Generate the T0 CAD feasibility fixture")
    parser.add_argument("--spec", type=Path, required=True)
    parser.add_argument("--output", type=Path, required=True)
    parser.add_argument("--cancel-file", type=Path)
    parser.add_argument("--hold-ms", type=int, default=0)
    args = parser.parse_args()
    try:
        manifest = generate(args.spec, args.output, args.cancel_file, args.hold_ms)
        print(json.dumps({"status": "ok", "objectCount": manifest["objectCount"], "output": str(args.output)}, ensure_ascii=False))
        return 0
    except CancelledError as exc:
        print(json.dumps({"status": "cancelled", "reason": str(exc)}, ensure_ascii=False))
        return 2
    except Exception as exc:
        print(json.dumps({"status": "error", "type": exc.__class__.__name__, "reason": str(exc)}, ensure_ascii=False), file=sys.stderr)
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
