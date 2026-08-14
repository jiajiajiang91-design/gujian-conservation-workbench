from __future__ import annotations

import hashlib
import io
import json
import math
import uuid
import zipfile
from dataclasses import dataclass
from pathlib import Path
from typing import Any

import cadquery as cq
import ifcopenshell
import numpy as np
import trimesh
from PIL import Image, ImageDraw

from .contracts import canonical_bytes, geometry_spec_input_hash, sha256_bytes, validate_geometry_spec


REVISION_NAMESPACE = uuid.UUID("5101927e-4f9d-5fa7-a411-eafec4d17d24")
SURFACE_AXES = {"xMin": (0, -1), "xMax": (0, 1), "yMin": (1, -1), "yMax": (1, 1), "zMin": (2, -1), "zMax": (2, 1)}


@dataclass(frozen=True)
class BuiltObject:
    record: dict[str, Any]
    shape: cq.Shape
    vertices: np.ndarray
    faces: np.ndarray
    mesh_hash: str


def _number(value: str) -> float:
    if "/" in value:
        left, right = value.split("/", 1)
        return float(left) / float(right)
    return float(value)


def _shape_for(record: dict[str, Any]) -> cq.Shape:
    solid = record["solid"]
    kind = solid["kind"]
    if kind == "box":
        shape = cq.Workplane("XY").box(_number(solid["sizeX"]), _number(solid["sizeY"]), _number(solid["sizeZ"])).translate(tuple(solid["centerMm"]))
        return shape.val()
    if kind == "cylinder":
        radius, height = _number(solid["radius"]), _number(solid["height"])
        direction = {"x": cq.Vector(1, 0, 0), "y": cq.Vector(0, 1, 0), "z": cq.Vector(0, 0, 1)}[solid["axis"]]
        center = cq.Vector(*solid["centerMm"])
        return cq.Solid.makeCylinder(radius, height, center - direction.multiply(height / 2), direction)
    axis = solid["axis"]
    plane = {"x": "YZ", "y": "XZ", "z": "XY"}[axis]
    profile = [(float(x), float(y)) for x, y in solid["profileMm"]]
    shape = cq.Workplane(plane).polyline(profile).close().extrude(_number(solid["depth"])).translate(tuple(solid["originMm"]))
    return shape.val()


def _mesh_for(shape: cq.Shape, tolerance: float) -> tuple[np.ndarray, np.ndarray]:
    vertices, faces = shape.tessellate(tolerance, 0.1)
    points = np.array([[item.x, item.y, item.z] for item in vertices], dtype=np.float64)
    triangles = np.array(faces, dtype=np.int64)
    return points, triangles


def _mesh_hash(vertices: np.ndarray, faces: np.ndarray) -> str:
    rounded = np.round(vertices, 3)
    canonical_faces = []
    for face in faces:
        points = [tuple(float(value) for value in rounded[index]) for index in face]
        rotations = [points[offset:] + points[:offset] for offset in range(3)]
        canonical_faces.append(min(rotations))
    return sha256_bytes(canonical_bytes(sorted(canonical_faces)))


def _build_objects(spec: dict[str, Any]) -> list[BuiltObject]:
    result: list[BuiltObject] = []
    tolerance = float(spec["tolerances"]["tessellationMm"])
    for record in spec["objects"]:
        shape = _shape_for(record)
        if not shape.isValid() or shape.Volume() <= 0:
            raise ValueError(f"invalid BRep for object {record['id']}")
        vertices, faces = _mesh_for(shape, tolerance)
        result.append(BuiltObject(record, shape, vertices, faces, _mesh_hash(vertices, faces)))
    return result


def _surface(shape: cq.Shape, name: str) -> cq.Shape:
    if name not in SURFACE_AXES:
        raise ValueError(f"unsupported semantic surface: {name}")
    axis, side = SURFACE_AXES[name]
    faces = list(shape.Faces())
    centers = [face.Center().toTuple()[axis] for face in faces]
    target = (min if side < 0 else max)(centers)
    selected = [face for face, center in zip(faces, centers, strict=True) if math.isclose(center, target, abs_tol=1e-5)]
    if not selected:
        raise ValueError(f"semantic surface not found: {name}")
    return cq.Compound.makeCompound(selected)


def _interface_metrics(interface: dict[str, Any], objects: dict[str, BuiltObject]) -> dict[str, Any]:
    left = objects[interface["fromObjectId"]]
    right = objects[interface["toObjectId"]]
    left_surface = _surface(left.shape, interface["fromSurface"])
    right_surface = _surface(right.shape, interface["toSurface"])
    surface_distance = float(left_surface.distance(right_surface))
    shape_distance = float(left.shape.distance(right.shape))
    intersection = left.shape.intersect(right.shape)
    overlap_volume = float(intersection.Volume()) if intersection and not intersection.isNull() else 0.0
    interface_type = interface["interfaceType"]
    maximum_gap = float(interface["maximumGapMm"])
    maximum_overlap = float(interface["maximumUnexpectedOverlapMm3"])
    minimum_overlap = interface["minimumDeclaredOverlapMm3"]
    if surface_distance > maximum_gap + 1e-6 or shape_distance > maximum_gap + 1e-6:
        raise ValueError(f"interface gap exceeds contract: {interface['id']}")
    if interface_type == "lap":
        if minimum_overlap is None or overlap_volume + 1e-6 < float(minimum_overlap):
            raise ValueError(f"declared lap is not present: {interface['id']}")
    elif overlap_volume > maximum_overlap + 1e-6:
        raise ValueError(f"unexpected interface overlap: {interface['id']}")
    return {
        "id": interface["id"], "fromObjectId": interface["fromObjectId"], "toObjectId": interface["toObjectId"],
        "fromSurface": interface["fromSurface"], "toSurface": interface["toSurface"],
        "surfaceDistanceMm": round(surface_distance, 6), "shapeDistanceMm": round(shape_distance, 6),
        "overlapVolumeMm3": round(overlap_volume, 6), "passed": True,
    }


def _entity_record(item: BuiltObject, brep_sha256: str) -> dict[str, Any]:
    box = item.shape.BoundingBox()
    return {
        "id": item.record["id"], "stableKey": item.record["stableKey"],
        "componentType": item.record["componentType"], "displayNameZh": item.record["displayNameZh"],
        "materialCode": item.record["materialCode"], "meshHash": item.mesh_hash,
        "brepSha256": brep_sha256,
        "vertexCount": int(len(item.vertices)), "faceCount": int(len(item.faces)),
        "volumeMm3": round(float(item.shape.Volume()), 6),
        "boundsMm": [[round(box.xmin, 6), round(box.ymin, 6), round(box.zmin, 6)], [round(box.xmax, 6), round(box.ymax, 6), round(box.zmax, 6)]],
        "producer": item.record["producer"], "factRefs": item.record["factRefs"],
        "evidenceRefs": item.record["evidenceRefs"], "unknownRefs": item.record["unknownRefs"],
    }


def _write_glb(path: Path, objects: list[BuiltObject]) -> None:
    scene = trimesh.Scene()
    for item in objects:
        # Internal geometry and IFC are Z-up/mm. glTF is Y-up/metre.
        glb_vertices = np.column_stack((item.vertices[:, 0], item.vertices[:, 2], -item.vertices[:, 1])) / 1000.0
        mesh = trimesh.Trimesh(vertices=glb_vertices, faces=item.faces, process=False)
        mesh.metadata.update({"sourceEntityId": item.record["id"], "componentType": item.record["componentType"]})
        scene.add_geometry(mesh, node_name=item.record["id"], geom_name=item.record["id"])
    path.write_bytes(scene.export(file_type="glb"))


def _write_ifc(path: Path, spec: dict[str, Any], objects: list[BuiltObject]) -> None:
    model = ifcopenshell.file(schema="IFC4")
    def global_id(label: str) -> str:
        return ifcopenshell.guid.compress(uuid.uuid5(REVISION_NAMESPACE, f"{spec['inputHash']}:{label}").hex)
    origin = model.create_entity("IfcCartesianPoint", Coordinates=(0.0, 0.0, 0.0))
    axis = model.create_entity("IfcAxis2Placement3D", Location=origin)
    context = model.create_entity(
        "IfcGeometricRepresentationContext", ContextIdentifier=None, ContextType="Model",
        CoordinateSpaceDimension=3, Precision=1e-5, WorldCoordinateSystem=axis, TrueNorth=None,
    )
    unit = model.create_entity("IfcSIUnit", UnitType="LENGTHUNIT", Prefix="MILLI", Name="METRE")
    unit_assignment = model.create_entity("IfcUnitAssignment", Units=[unit])
    project = model.create_entity(
        "IfcProject", GlobalId=global_id("project"), Name="代理几何项目",
        RepresentationContexts=[context], UnitsInContext=unit_assignment,
    )
    placement = model.create_entity("IfcLocalPlacement", RelativePlacement=axis)
    site = model.create_entity("IfcSite", GlobalId=global_id("site"), Name="项目场地", ObjectPlacement=placement, CompositionType="ELEMENT")
    building = model.create_entity("IfcBuilding", GlobalId=global_id("building"), Name="项目建筑", ObjectPlacement=placement, CompositionType="ELEMENT")
    storey = model.create_entity("IfcBuildingStorey", GlobalId=global_id("storey"), Name="几何层", ObjectPlacement=placement, CompositionType="ELEMENT")
    model.create_entity("IfcRelAggregates", GlobalId=global_id("rel:project-site"), RelatingObject=project, RelatedObjects=[site])
    model.create_entity("IfcRelAggregates", GlobalId=global_id("rel:site-building"), RelatingObject=site, RelatedObjects=[building])
    model.create_entity("IfcRelAggregates", GlobalId=global_id("rel:building-storey"), RelatingObject=building, RelatedObjects=[storey])
    products = []
    for item in objects:
        coordinates = model.create_entity("IfcCartesianPointList3D", CoordList=item.vertices.tolist())
        face_set = model.create_entity(
            "IfcTriangulatedFaceSet", Coordinates=coordinates, Closed=True,
            CoordIndex=[[int(index) + 1 for index in face] for face in item.faces],
        )
        representation = model.create_entity(
            "IfcShapeRepresentation", ContextOfItems=context, RepresentationIdentifier="Body",
            RepresentationType="Tessellation", Items=[face_set],
        )
        product_shape = model.create_entity("IfcProductDefinitionShape", Representations=[representation])
        product = model.create_entity(
            "IfcBuildingElementProxy", GlobalId=global_id(f"product:{item.record['id']}"),
            Name=item.record["id"], ObjectType=item.record["componentType"], ObjectPlacement=placement,
            Representation=product_shape, PredefinedType="NOTDEFINED",
        )
        products.append(product)
    model.create_entity(
        "IfcRelContainedInSpatialStructure", GlobalId=global_id("rel:storey-products"),
        RelatedElements=products, RelatingStructure=storey,
    )
    model.header.file_name.name = "model.ifc"
    model.header.file_name.time_stamp = "2000-01-01T00:00:00"
    model.header.file_name.author = ("Gujian Workbench",)
    model.header.file_name.organization = ("Proxy Output",)
    model.header.file_name.preprocessor_version = "gujian-project-geometry-1.0"
    model.header.file_name.originating_system = "gujian-project-geometry-1.0"
    model.header.file_name.authorization = "UNSIGNED_PROXY_OUTPUT"
    model.write(str(path))


def _write_preview(path: Path, objects: list[BuiltObject]) -> None:
    width, height = 1600, 1000
    image = Image.new("RGB", (width, height), "#f4f5f6")
    draw = ImageDraw.Draw(image)
    points: list[tuple[float, float]] = []
    records: list[tuple[BuiltObject, list[tuple[float, float]]]] = []
    for item in objects:
        box = item.shape.BoundingBox()
        corners = [(x, y, z) for x in (box.xmin, box.xmax) for y in (box.ymin, box.ymax) for z in (box.zmin, box.zmax)]
        projected = [(x - y * 0.55, z + (x + y) * 0.18) for x, y, z in corners]
        points.extend(projected)
        records.append((item, projected))
    min_x, max_x = min(x for x, _ in points), max(x for x, _ in points)
    min_y, max_y = min(y for _, y in points), max(y for _, y in points)
    scale = min((width - 160) / max(max_x - min_x, 1), (height - 160) / max(max_y - min_y, 1))
    def paper(point: tuple[float, float]) -> tuple[float, float]:
        return 80 + (point[0] - min_x) * scale, height - 80 - (point[1] - min_y) * scale
    edges = [(0, 1), (0, 2), (0, 4), (1, 3), (1, 5), (2, 3), (2, 6), (3, 7), (4, 5), (4, 6), (5, 7), (6, 7)]
    for item, projected in records:
        color = "#202426" if item.record["unknownRefs"] else "#6b2d27"
        for start, end in edges:
            draw.line([paper(projected[start]), paper(projected[end])], fill=color, width=2)
    draw.text((36, 28), "项目驱动几何预览｜代理成果｜未签发｜L1=false", fill="#202426")
    image.save(path, dpi=(150, 150))


def build_geometry_package(spec_value: dict[str, Any], output_dir: Path) -> dict[str, Any]:
    spec = validate_geometry_spec(spec_value)
    output_dir.mkdir(parents=True, exist_ok=False)
    objects = _build_objects(spec)
    by_id = {item.record["id"]: item for item in objects}
    # Keep the exact OCP BRep for downstream sections and visibility work.  GLB
    # remains the browser preview/transport form; it is not the cutting source.
    brep_dir = output_dir / "brep"
    brep_dir.mkdir()
    brep_hashes: dict[str, str] = {}
    for item in objects:
        brep_path = brep_dir / f"{item.record['id']}.brep"
        item.shape.exportBrep(str(brep_path))
        brep_hashes[item.record["id"]] = sha256_bytes(brep_path.read_bytes())
    brep_bundle_path = output_dir / "model-brep.zip"
    with zipfile.ZipFile(brep_bundle_path, "w", compression=zipfile.ZIP_DEFLATED, compresslevel=9) as archive:
        for brep_path in sorted(brep_dir.glob("*.brep"), key=lambda path: path.name):
            info = zipfile.ZipInfo(f"brep/{brep_path.name}", date_time=(2000, 1, 1, 0, 0, 0))
            info.compress_type = zipfile.ZIP_DEFLATED
            info.external_attr = 0o100644 << 16
            info.create_system = 3
            archive.writestr(info, brep_path.read_bytes(), compress_type=zipfile.ZIP_DEFLATED, compresslevel=9)
    entities = [_entity_record(item, brep_hashes[item.record["id"]]) for item in objects]
    interfaces = [_interface_metrics(item, by_id) for item in spec["interfaces"]]
    entity_closure = sha256_bytes(canonical_bytes(entities))
    interface_closure = sha256_bytes(canonical_bytes(interfaces))
    signature = sha256_bytes(canonical_bytes({
        "specInputHash": geometry_spec_input_hash(spec), "entityClosureHash": entity_closure,
        "interfaceClosureHash": interface_closure,
    }))
    revision_id = str(uuid.uuid5(REVISION_NAMESPACE, signature))

    glb_path = output_dir / "model.glb"
    ifc_path = output_dir / "model.ifc"
    source_path = output_dir / "source-map.ndjson"
    report_path = output_dir / "geometry-report.json"
    preview_path = output_dir / "preview.png"
    _write_glb(glb_path, objects)
    _write_ifc(ifc_path, spec, objects)
    source_path.write_text("\n".join(json.dumps(record, ensure_ascii=False, sort_keys=True) for record in entities) + "\n", encoding="utf-8", newline="\n")
    report = {
        "schemaVersion": "1.0", "status": "passed-geometry-technical-only",
        "qualification": "generated-not-qualified", "l1Eligible": False, "formalEligibility": False,
        "geometryRevisionId": revision_id, "geometrySignature": signature,
        "entityCount": len(entities), "interfaceCount": len(interfaces),
        "unknownCount": len(spec["unknowns"]), "interfaceChecks": interfaces,
        "blockers": ["PROFESSIONAL_REVIEW_REQUIRED", "FORMAL_SIGNOFF_UNAVAILABLE"],
    }
    report_path.write_bytes(canonical_bytes(report))
    _write_preview(preview_path, objects)

    provisional = {
        "schemaVersion": "1.0", "geometryRevisionId": revision_id,
        "projectId": spec["projectId"], "projectRevisionId": spec["projectRevisionId"],
        "geometrySpecId": spec["id"], "inputHash": spec["inputHash"],
        "entityClosureHash": entity_closure, "interfaceClosureHash": interface_closure,
        "geometrySignature": signature, "status": "generated-not-qualified", "l1Eligible": False,
        "formalEligibility": False, "blockers": report["blockers"], "entities": entities,
        "interfaces": interfaces, "assets": [],
    }
    manifest_path = output_dir / "manifest.json"
    assets = []
    for kind, path, mime_type in [
        ("ifc", ifc_path, "application/x-step"), ("glb", glb_path, "model/gltf-binary"),
        ("brepBundle", brep_bundle_path, "application/zip"),
        ("sourceMap", source_path, "application/x-ndjson"), ("report", report_path, "application/json"),
        ("preview", preview_path, "image/png"),
    ]:
        data = path.read_bytes()
        assets.append({"kind": kind, "fileName": path.name, "sha256": sha256_bytes(data), "byteLength": len(data), "mimeType": mime_type})
    provisional["assets"] = assets
    manifest_path.write_bytes(canonical_bytes(provisional))
    manifest_data = manifest_path.read_bytes()
    provisional["assets"].append({"kind": "manifest", "fileName": manifest_path.name, "sha256": sha256_bytes(manifest_data), "byteLength": len(manifest_data), "mimeType": "application/json"})
    return provisional
