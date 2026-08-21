from __future__ import annotations

import argparse
from collections import Counter, OrderedDict
from hashlib import sha256
import gzip
import json
import math
import os
from pathlib import Path
import re
import shutil
from uuid import UUID, uuid4, uuid5

import ezdxf
from ezdxf import const
from ezdxf.document import CONST_MARKER_STRING, CREATED_BY_EZDXF, WRITTEN_BY_EZDXF


APPID = "GUJIAN_TRACE_V1"
DXF_OBJECT_NAMESPACE = UUID("8755ef76-c92a-5d97-9148-fac047c3ecb4")
FIXED_JULIAN_DATE = 2451544.5
DXF_NAME = "T0B.dxf"
SIDECAR_NAME = "T0B-source-map.ndjson"
BUILD_RECORD_NAME = "T0B-dxf-build-record.json"
REPOSITORY_ROOT = Path(__file__).resolve().parents[3]
FORBIDDEN_OUTPUT_TOKENS = (
    ".dwg",
    "downloads",
    "寺庙古建筑设计方案图",
    "一套完整的古建施工图",
)


class DXFGenerationError(ValueError):
    pass


def _require(condition: bool, message: str) -> None:
    if not condition:
        raise DXFGenerationError(message)


def _file_hash(path: Path) -> str:
    digest = sha256()
    with path.open("rb") as stream:
        for chunk in iter(lambda: stream.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def _canonical_hash(value: object) -> str:
    raw = json.dumps(value, ensure_ascii=False, sort_keys=True, separators=(",", ":")).encode("utf-8")
    return sha256(raw).hexdigest()


def _load_json(path: Path) -> dict:
    return json.loads(path.read_text(encoding="utf-8"))


def _load_json_gzip(path: Path) -> dict:
    with gzip.open(path, "rt", encoding="utf-8") as stream:
        return json.load(stream)


def _derived_cad_id(base_id: str, suffix: str) -> str:
    return str(uuid5(DXF_OBJECT_NAMESPACE, f"{base_id}:{suffix}"))


def _clean_text(value: object) -> str:
    return str(value).replace("\r", " ").replace("\n", " ")


def _xdata_tags(cad_object_id: str, provenance: dict) -> list[tuple[int, str]]:
    tags: list[tuple[int, str]] = [(1000, f"cadObjectId={cad_object_id}")]
    for key in sorted(provenance):
        value = provenance[key]
        values = value if isinstance(value, list) else [value]
        for item in values:
            if isinstance(item, (dict, list)):
                text = json.dumps(item, ensure_ascii=False, sort_keys=True, separators=(",", ":"))
            elif isinstance(item, bool):
                text = str(item).lower()
            elif item is None:
                text = "null"
            else:
                text = _clean_text(item)
            payload = f"{key}={text}"
            encoded = payload.encode("utf-8")
            _require(len(encoded) <= 255, f"XDATA value exceeds 255 bytes: {key}")
            tags.append((1000, payload))
    return tags


def _lineweight(value_mm: float) -> int:
    value = int(round(float(value_mm) * 100))
    allowed = sorted(item for item in const.VALID_DXF_LINEWEIGHTS if item >= 0)
    return min(allowed, key=lambda item: abs(item - value))


def _flatten_values(value: object) -> list[tuple[str, float]]:
    if isinstance(value, dict):
        return [(str(key), float(value[key])) for key in sorted(value)]
    if isinstance(value, list):
        return [(str(index + 1), float(item)) for index, item in enumerate(value)]
    raise DXFGenerationError("annotation valuesMm must be a list or object")


def _parse_scale(value: str) -> float:
    match = re.fullmatch(r"1:(\d+(?:\.\d+)?)", value)
    _require(match is not None, f"invalid paper scale: {value}")
    return float(match.group(1))


def _validate_pattern_definition(
    lines: list[tuple[float, tuple[float, float], tuple[float, float], list[float]]],
) -> list[tuple[float, tuple[float, float], tuple[float, float], list[float]]]:
    for angle, _, offset, _ in lines:
        radians = math.radians(float(angle))
        direction = (math.cos(radians), math.sin(radians))
        perpendicular_component = direction[0] * float(offset[1]) - direction[1] * float(offset[0])
        _require(math.hypot(*offset) > 0 and abs(perpendicular_component) > 1e-9, "hatch pattern offset cannot be zero or parallel to its line direction")
    return lines


def _pattern_definition(pattern_key: str, pattern: dict) -> list[tuple[float, tuple[float, float], tuple[float, float], list[float]]]:
    if pattern_key == "stone":
        lines = [(45.0, (0.0, 0.0), (0.0, 24.0), []), (135.0, (0.0, 0.0), (0.0, 24.0), [])]
    elif pattern_key == "timber":
        lines = [(0.0, (0.0, 0.0), (0.0, 18.0), [])]
    elif pattern_key == "earth":
        lines = [(0.0, (0.0, 0.0), (0.0, 24.0), [1.0, -7.0]), (90.0, (12.0, 0.0), (24.0, 0.0), [0.0, -8.0])]
    elif pattern_key == "ceramic":
        _require(pattern["patternId"] == "GJ-CERAMIC-DEMO" and pattern["source"] == "team-owned-demo", "ceramic target hatch is not team-owned")
        spacing = float(pattern["spacingMm"])
        lines = [(float(pattern["angleDeg"]), (0.0, 0.0), (0.0, spacing), [])]
    else:
        raise DXFGenerationError(f"unsupported target hatch pattern: {pattern_key}")
    return _validate_pattern_definition(lines)


class NativeDXFGenerator:
    def __init__(self, contract: dict, ir: dict, manifest: dict, font_config: dict) -> None:
        self.contract = contract
        self.ir = ir
        self.manifest = manifest
        self.font_config = font_config
        self.sidecar_rows: list[dict] = []
        self.requirement_ids_rendered: set[str] = set()
        self.view_stages = {stage["viewId"]: stage for stage in ir["modelSpace"]["viewStages"]}
        self.viewports = {
            viewport["viewId"]: viewport
            for layout in ir["paperSpace"]["layouts"]
            for viewport in layout["viewports"]
        }
        self._validate_inputs()

    def _validate_inputs(self) -> None:
        _require(self.contract.get("contractSignature") == self.ir.get("drawingPackageContractSignature"), "IR does not bind the DrawingPackageContract signature")
        _require(self.contract.get("contractRevisionId") == self.ir.get("drawingPackageContractRevisionId"), "IR does not bind the DrawingPackageContract revision")
        _require(self.contract.get("geometryRevisionId") == self.ir.get("geometryRevisionId") == self.manifest.get("geometryRevisionId"), "geometry revision binding differs")
        _require(self.contract.get("viewContractRevisionId") == self.ir.get("viewContractRevisionId"), "view contract revision binding differs")
        _require(self.contract.get("manifestBinding", {}).get("sha256") == self.ir.get("manifestSha256"), "manifest binding differs")
        _require(self.ir.get("schemaVersion") == "t0b-v2-drawing-package-ir-1", "unsupported DrawingPackageIR schema")
        _require(self.ir.get("status") == "generated-not-qualified" and self.ir.get("L1") is False, "IR qualification boundary was relaxed")
        _require(self.ir.get("modelSpace") == {**self.ir["modelSpace"], "unit": "mm", "insunits": 4, "scale": "1:1"}, "IR model-space policy differs")
        _require(len(self.view_stages) == 10 and len(self.ir["paperSpace"]["layouts"]) == 2, "IR drawing package view or layout count differs")
        bound_font = self.contract["fontPolicy"]["boundFonts"][0]
        _require(
            self.font_config
            == {
                "schemaVersion": "t0b-v2-logical-font-config-2",
                "family": "Gujian Sans SC",
                "postScriptName": "GujianSansSC-Regular",
                "styleName": "GJ-GUJIAN-SANS-SC",
                "assetStatus": "bound-licensed-static-instance",
                "fontFileName": "GujianSansSC-Regular.ttf",
                "fontAssetRelativePath": bound_font["relativeFontPath"],
                "fontSha256": bound_font["sha256"],
                "fontManifestRelativePath": bound_font["relativeManifestPath"],
                "fontManifestSha256": bound_font["manifestSha256"],
                "sourceFontSha256": bound_font["sourceFontSha256"],
                "sourceCommit": bound_font["sourceCommit"],
                "instanceWeight": 400,
                "licenseSpdx": "OFL-1.1",
                "fsType": 0,
                "releaseAssetIncluded": True,
                "pdfEmbeddingEligible": True,
                "source": "google-fonts-pinned-derived-instance",
                "qualificationBlocker": None,
            },
            "logical font configuration is invalid",
        )
        _require(self.manifest.get("producerType") == "demo", "manifest must retain demo provenance")
        _require("FONT_ASSET_NOT_BOUND" not in self.ir["qualificationBoundary"]["requiredBlockers"], "closed font blocker remains in IR")
        _require("BRACKET_DETAIL_SIMPLIFIED_GEOMETRY" in self.ir["qualificationBoundary"]["requiredBlockers"], "bracket detail blocker is missing")
        _require("QCAD_LOSSLESS_ROUNDTRIP_UNSUPPORTED" in self.ir["qualificationBoundary"]["requiredBlockers"], "QCAD lossless-roundtrip blocker is missing")

    def _new_document(self) -> ezdxf.document.Drawing:
        doc = ezdxf.new("R2018", setup=False)
        doc.header["$INSUNITS"] = 4
        doc.header["$MEASUREMENT"] = 1
        doc.header["$LUNITS"] = 2
        doc.header["$LTSCALE"] = 1.0
        doc.header["$PSLTSCALE"] = 1
        doc.header["$TDCREATE"] = FIXED_JULIAN_DATE
        doc.header["$TDUPDATE"] = FIXED_JULIAN_DATE
        fingerprint = str(uuid5(DXF_OBJECT_NAMESPACE, self.ir["drawingPackageIrSha256"])).upper()
        version = str(uuid5(DXF_OBJECT_NAMESPACE, self.contract["contractRevisionId"])).upper()
        doc.header["$FINGERPRINTGUID"] = "{" + fingerprint + "}"
        doc.header["$VERSIONGUID"] = "{" + version + "}"
        doc.header["$LASTSAVEDBY"] = "GUJIAN-CAD-WORKER"
        if APPID not in doc.appids:
            doc.appids.add(APPID)
        self._setup_linetypes(doc)
        self._setup_layers(doc)
        self._setup_text_and_dimensions(doc)
        self._setup_blocks(doc)
        return doc

    def _setup_linetypes(self, doc: ezdxf.document.Drawing) -> None:
        definitions = {
            "CENTER": ("center line", [2.0, 1.25, -0.25, 0.25, -0.25]),
            "HIDDEN": ("hidden line", [0.75, 0.5, -0.25]),
            "DASHED": ("dashed line", [0.75, 0.5, -0.25]),
        }
        for name, (description, pattern) in definitions.items():
            if name not in doc.linetypes:
                doc.linetypes.add(name, description=description, pattern=pattern)

    def _setup_layers(self, doc: ezdxf.document.Drawing) -> None:
        colors = {
            "GJ-CUT": 1,
            "GJ-OUTLINE": 7,
            "GJ-PROJECTION": 8,
            "GJ-HIDDEN": 9,
            "GJ-AXIS": 4,
            "GJ-DIMENSION": 2,
            "GJ-TEXT": 7,
            "GJ-HATCH": 8,
            "GJ-FRAME": 7,
        }
        for name, definition in sorted(self.ir["layerPolicy"]["layers"].items()):
            layer = doc.layers.get(name) if name in doc.layers else doc.layers.add(name)
            layer.dxf.linetype = definition["linetype"]
            layer.dxf.lineweight = _lineweight(definition["lineweightMm"])
            layer.dxf.color = colors.get(name, 7)

    def _setup_text_and_dimensions(self, doc: ezdxf.document.Drawing) -> None:
        standard = doc.styles.get("Standard")
        standard.dxf.font = self.font_config["fontFileName"]
        if self.font_config["styleName"] not in doc.styles:
            doc.styles.add(self.font_config["styleName"], font=self.font_config["fontFileName"])
        if "GJ-DIM" not in doc.dimstyles:
            style = doc.dimstyles.add("GJ-DIM")
            style.dxf.dimtxsty = self.font_config["styleName"]
            style.dxf.dimclrd = 256
            style.dxf.dimclre = 256
            style.dxf.dimclrt = 256
            style.dxf.dimdec = 0
            style.dxf.dimtad = 1

    def _setup_blocks(self, doc: ezdxf.document.Drawing) -> None:
        axis = doc.blocks.new("GJ_AXIS_BUBBLE")
        axis.add_circle((0, 0), 1.0, dxfattribs={"layer": "GJ-AXIS"})
        axis.add_line((-2.0, 0), (2.0, 0), dxfattribs={"layer": "GJ-AXIS"})
        axis.add_attdef("LABEL", (0, -0.35), height=0.7, dxfattribs={"layer": "GJ-TEXT", "style": self.font_config["styleName"], "halign": 1, "align_point": (0, -0.35)})

        level = doc.blocks.new("GJ_LEVEL_MARK")
        level.add_lwpolyline([(-1, 0), (0, 0.6), (1, 0), (-1, 0)], dxfattribs={"layer": "GJ-AXIS"})
        level.add_line((0, 0), (3.0, 0), dxfattribs={"layer": "GJ-AXIS"})
        level.add_attdef("LEVEL", (3.3, -0.25), height=0.7, dxfattribs={"layer": "GJ-TEXT", "style": self.font_config["styleName"]})

        section = doc.blocks.new("GJ_SECTION_MARK")
        section.add_circle((0, 0), 1.0, dxfattribs={"layer": "GJ-AXIS"})
        section.add_line((0, -2), (0, 2), dxfattribs={"layer": "GJ-AXIS"})
        section.add_attdef("TARGET", (0, -0.35), height=0.6, dxfattribs={"layer": "GJ-TEXT", "style": self.font_config["styleName"], "halign": 1, "align_point": (0, -0.35)})

        detail = doc.blocks.new("GJ_DETAIL_INDEX")
        detail.add_circle((0, 0), 1.0, dxfattribs={"layer": "GJ-AXIS"})
        detail.add_line((-1, 0), (1, 0), dxfattribs={"layer": "GJ-AXIS"})
        detail.add_attdef("TARGET", (0, 0.15), height=0.55, dxfattribs={"layer": "GJ-TEXT", "style": self.font_config["styleName"], "halign": 1, "align_point": (0, 0.15)})

        break_symbol = doc.blocks.new("GJ_BREAK_SYMBOL")
        break_symbol.add_lwpolyline([(-1.5, 0), (-0.5, 0.8), (0.5, -0.8), (1.5, 0)], dxfattribs={"layer": "GJ-TEXT"})

        title = doc.blocks.new("GJ_TITLEBLOCK")
        title.add_lwpolyline([(0, 0), (226, 0), (226, 55), (0, 55), (0, 0)], dxfattribs={"layer": "GJ-FRAME"})
        for y in (11, 22, 33, 44):
            title.add_line((0, y), (226, y), dxfattribs={"layer": "GJ-FRAME"})
        fields = ["PROJECT", "DRAWINGTITLE", "DRAWINGNUMBER", "SCALE", "UNIT", "STATUS", "REVISION", "DATE", "RESPONSIBILITYBOUNDARY"]
        for index, field in enumerate(fields):
            column = 0 if index < 5 else 113
            row = index if index < 5 else index - 5
            title.add_attdef(field, (column + 3, 3 + row * 11), height=2.5, dxfattribs={"layer": "GJ-TEXT", "style": self.font_config["styleName"]})

    def _register(self, entity, cad_object_id: str, object_class: str, provenance: dict) -> None:
        entity.set_xdata(APPID, _xdata_tags(cad_object_id, provenance))
        handle = entity.dxf.handle
        _require(isinstance(handle, str) and handle, "created CAD entity has no handle")
        self.sidecar_rows.append({
            "handle": handle,
            "cadObjectId": cad_object_id,
            "dxftype": entity.dxftype(),
            "objectClass": object_class,
            "provenance": provenance,
        })

    def _add_structural_geometry(self, doc: ezdxf.document.Drawing) -> dict[str, dict]:
        msp = doc.modelspace()
        line_index: dict[str, dict] = {}
        for stage in sorted(self.ir["modelSpace"]["viewStages"], key=lambda item: item["viewId"]):
            for line in stage["structuralLines"]:
                points = line["modelSpacePointsMm"]
                if line["cadObjectType"] == "LINE":
                    entity = msp.add_line(points[0], points[1], dxfattribs={"layer": line["layer"]})
                else:
                    closed = len(points) > 2 and points[0] == points[-1]
                    entity = msp.add_lwpolyline(points, close=closed, dxfattribs={"layer": line["layer"]})
                self._register(entity, line["cadObjectId"], "structural", line["xdata"])
                line_index[line["cadObjectId"]] = line
        return line_index

    def _add_material_hatches(self, doc: ezdxf.document.Drawing, line_index: dict[str, dict]) -> None:
        msp = doc.modelspace()
        patterns = self.ir["materialPolicy"]["patterns"]
        for stage in sorted(self.ir["modelSpace"]["viewStages"], key=lambda item: item["viewId"]):
            for region in sorted(stage["materialRegions"], key=lambda item: item["cadObjectId"]):
                pattern_key = region["targetHatchPatternKey"]
                pattern = patterns[pattern_key]
                _require(region["targetHatchPatternId"] == pattern["patternId"], "IR target hatch does not resolve to material policy")
                hatch = msp.add_hatch(dxfattribs={"layer": "GJ-HATCH"})
                hatch.set_pattern_fill(
                    name=pattern["patternId"],
                    scale=float(pattern.get("scale", 1.0)),
                    angle=0.0,
                    definition=_pattern_definition(pattern_key, pattern),
                )
                if region["sourceKind"] == "ViewGeometry.cutRegion":
                    rings = [line_index[cad_id]["modelSpacePointsMm"] for cad_id in region["boundaryCadObjectIds"]]
                else:
                    rings = [region["modelSpaceOuterMm"], *region["modelSpaceHolesMm"]]
                _require(rings and all(len(ring) >= 3 for ring in rings), f"{region['cadObjectId']} hatch boundary is incomplete")
                hatch.paths.add_polyline_path(rings[0], is_closed=True, flags=const.BOUNDARY_PATH_EXTERNAL)
                for ring in rings[1:]:
                    hatch.paths.add_polyline_path(ring, is_closed=True, flags=const.BOUNDARY_PATH_DEFAULT)
                self._register(hatch, region["cadObjectId"], "material-region", region["xdata"])

    def _annotation_context(self, view_id: str) -> tuple[dict, float, float]:
        stage = self.view_stages[view_id]
        denominator = _parse_scale(self.viewports[view_id]["scale"])
        return stage, denominator, max(25.0, 2.5 * denominator)

    def _register_annotation(self, entity, annotation: dict, suffix: str) -> None:
        cad_object_id = annotation["cadObjectId"] if suffix == "0" else _derived_cad_id(annotation["cadObjectId"], suffix)
        provenance = {"requirementId": annotation["requirementId"], "sourceRefs": annotation["sourceRefs"]}
        self._register(entity, cad_object_id, "annotation", provenance)
        self.requirement_ids_rendered.add(annotation["requirementId"])

    def _add_dimension_annotations(self, msp, annotation: dict) -> None:
        stage, denominator, text_height = self._annotation_context(annotation["viewId"])
        x1, y1, x2, y2 = stage["stagedBoundsMm"]
        width, height = x2 - x1, y2 - y1
        values = _flatten_values(annotation["semanticPayload"]["valuesMm"])
        for index, (_, value) in enumerate(values):
            value = abs(value)
            _require(value > 0, f"{annotation['requirementId']} contains a zero dimension")
            if value <= width * 0.92:
                center = (x1 + x2) / 2
                p1, p2 = (center - value / 2, y1 + text_height * (1.5 + index * 0.9)), (center + value / 2, y1 + text_height * (1.5 + index * 0.9))
                base = (center, y1 + text_height * (2.2 + index * 0.9))
                angle = 0
            else:
                center = (y1 + y2) / 2
                p1, p2 = (x1 + text_height * (1.5 + index * 0.9), center - value / 2), (x1 + text_height * (1.5 + index * 0.9), center + value / 2)
                base = (x1 + text_height * (2.2 + index * 0.9), center)
                angle = 90
            _require(value <= max(width, height) * 1.01, f"{annotation['requirementId']} dimension exceeds its frozen view stage")
            override = {"dimtxt": text_height, "dimasz": text_height * 0.8, "dimexo": text_height * 0.35, "dimexe": text_height * 0.35, "dimscale": 1.0}
            renderer = msp.add_linear_dim(base=base, p1=p1, p2=p2, angle=angle, dimstyle="GJ-DIM", override=override, dxfattribs={"layer": "GJ-DIMENSION"})
            renderer.render()
            dimension = renderer.dimension
            _require(not dimension.dxf.hasattr("text") or dimension.dxf.text in {"", "<>"}, "dimension text override is forbidden")
            self._register_annotation(dimension, annotation, f"dimension-{index}")

    def _insert_symbol(self, msp, block_name: str, point: tuple[float, float], scale: float, values: dict[str, str], annotation: dict, suffix: str):
        insert = msp.add_blockref(block_name, point, dxfattribs={"layer": "GJ-AXIS", "xscale": scale, "yscale": scale})
        if values:
            insert.add_auto_attribs(values)
        self._register_annotation(insert, annotation, suffix)
        for index, attrib in enumerate(insert.attribs):
            self._register_annotation(attrib, annotation, f"{suffix}-attrib-{index}")
        return insert

    def _add_axis_annotation(self, msp, annotation: dict) -> None:
        stage, _, text_height = self._annotation_context(annotation["viewId"])
        x1, y1, x2, y2 = stage["stagedBoundsMm"]
        scale = text_height * 0.6
        points = [(x1 + scale * 2, y1 + scale * 2), (x2 - scale * 2, y1 + scale * 2), (x1 + scale * 2, y2 - scale * 2), (x2 - scale * 2, y2 - scale * 2)]
        for index, point in enumerate(points):
            self._insert_symbol(msp, "GJ_AXIS_BUBBLE", point, scale, {"LABEL": str(index + 1)}, annotation, f"axis-{index}")

    def _add_level_annotation(self, msp, annotation: dict) -> None:
        stage, _, text_height = self._annotation_context(annotation["viewId"])
        x1, y1, x2, y2 = stage["stagedBoundsMm"]
        values = _flatten_values(annotation["semanticPayload"]["valuesMm"])
        labels = annotation["semanticPayload"].get("labels", [])
        translation_y = stage["viewToModelSpace"][1][2]
        for index, (_, value) in enumerate(values):
            target_y = value + translation_y
            if not (y1 + text_height <= target_y <= y2 - text_height):
                target_y = y1 + text_height * (1.5 + index * 1.5)
            label = labels[index] if index < len(labels) else ("±0.000" if value == 0 else f"{value / 1000:+.3f}")
            self._insert_symbol(msp, "GJ_LEVEL_MARK", (x2 - text_height * 5, target_y), text_height * 0.7, {"LEVEL": label}, annotation, f"level-{index}")

    def _add_reference_annotation(self, msp, annotation: dict, detail: bool) -> None:
        stage, _, text_height = self._annotation_context(annotation["viewId"])
        x1, y1, x2, y2 = stage["stagedBoundsMm"]
        target = annotation["semanticPayload"].get("targetViewId", "VIEW")
        block = "GJ_DETAIL_INDEX" if detail else "GJ_SECTION_MARK"
        point = ((x1 + x2) / 2, y2 - text_height * (2 if detail else 3))
        self._insert_symbol(msp, block, point, text_height * 0.7, {"TARGET": target}, annotation, "0")

    def _add_mtext_annotation(self, msp, annotation: dict) -> None:
        stage, _, text_height = self._annotation_context(annotation["viewId"])
        x1, y1, x2, y2 = stage["stagedBoundsMm"]
        payload = annotation["semanticPayload"]
        if "text" in payload:
            lines = [payload["text"]]
        elif "label" in payload:
            lines = [payload["label"]]
        else:
            lines = list(payload.get("labels", []))
        _require(lines, f"{annotation['requirementId']} has no annotation text")
        for index, text in enumerate(lines):
            if annotation["category"] == "viewTitles":
                point = (x1 + text_height, y1 - text_height * 1.2)
            elif annotation["category"] == "notes":
                point = (x1 + text_height, y2 - text_height * (1.5 + index * 1.2))
            else:
                point = (x1 + text_height, y2 - text_height * (2.8 + index * 1.2))
            entity = msp.add_mtext(text, dxfattribs={"layer": "GJ-TEXT", "style": self.font_config["styleName"], "char_height": text_height, "insert": point, "width": max(text_height * 8, (x2 - x1) * 0.45)})
            self._register_annotation(entity, annotation, f"text-{index}")

    def _break_points(self, annotation: dict) -> list[tuple[float, float]]:
        stage = self.view_stages[annotation["viewId"]]
        if stage["cropLimitLines"]:
            return [
                ((line["modelSpacePointsMm"][0][0] + line["modelSpacePointsMm"][-1][0]) / 2, (line["modelSpacePointsMm"][0][1] + line["modelSpacePointsMm"][-1][1]) / 2)
                for line in stage["cropLimitLines"]
            ]
        x1, y1, x2, y2 = stage["stagedBoundsMm"]
        points: set[tuple[float, float]] = set()
        for line in stage["structuralLines"]:
            for point in (line["modelSpacePointsMm"][0], line["modelSpacePointsMm"][-1]):
                if min(abs(point[0] - x1), abs(point[0] - x2), abs(point[1] - y1), abs(point[1] - y2)) <= 0.001:
                    points.add((round(point[0], 3), round(point[1], 3)))
        return sorted(points)

    def _add_break_annotation(self, msp, annotation: dict) -> None:
        _, _, text_height = self._annotation_context(annotation["viewId"])
        points = self._break_points(annotation)
        _require(points, f"{annotation['requirementId']} has no cropped endpoints for break symbols")
        for index, point in enumerate(points):
            self._insert_symbol(msp, "GJ_BREAK_SYMBOL", point, text_height * 0.8, {}, annotation, f"break-{index}")

    def _add_purlin_callout(self, msp, annotation: dict) -> None:
        target = annotation["semanticPayload"].get("targetEntityId")
        stage = self.view_stages[annotation["viewId"]]
        points = [point for line in stage["structuralLines"] if line["sourceEntityId"] == target for point in line["modelSpacePointsMm"]]
        _require(points, "eave purlin callout target has no IR structural geometry")
        center = (sum(point[0] for point in points) / len(points), sum(point[1] for point in points) / len(points))
        _, _, text_height = self._annotation_context(annotation["viewId"])
        entity = msp.add_mtext(annotation["semanticPayload"]["label"], dxfattribs={"layer": "GJ-TEXT", "style": self.font_config["styleName"], "char_height": text_height, "insert": (center[0] + text_height * 2, center[1] + text_height * 2), "width": text_height * 12})
        self._register_annotation(entity, annotation, "0")

    def _add_annotations(self, doc: ezdxf.document.Drawing) -> None:
        msp = doc.modelspace()
        model_annotations = [item for item in self.ir["annotations"] if item.get("viewId")]
        for annotation in sorted(model_annotations, key=lambda item: (item["viewId"], item["category"], item["requirementId"])):
            category = annotation["category"]
            if category == "dimensions":
                self._add_dimension_annotations(msp, annotation)
            elif category == "axes":
                self._add_axis_annotation(msp, annotation)
            elif category == "levels":
                self._add_level_annotation(msp, annotation)
            elif category == "sectionMarks":
                self._add_reference_annotation(msp, annotation, False)
            elif category == "detailIndices":
                self._add_reference_annotation(msp, annotation, True)
            elif category == "breakMarks":
                self._add_break_annotation(msp, annotation)
            elif annotation["requirementId"] == "DR-ED-PURLIN":
                self._add_purlin_callout(msp, annotation)
            elif category in {"viewTitles", "notes", "componentCallouts"}:
                self._add_mtext_annotation(msp, annotation)
            else:
                raise DXFGenerationError(f"unsupported annotation category: {category}")
        self._add_system_crop_breaks(msp)

    def _add_system_crop_breaks(self, msp) -> None:
        for view_id, stage in sorted(self.view_stages.items()):
            if view_id == "eaveDetail" or not stage["cropLimitLines"]:
                continue
            _, _, text_height = self._annotation_context(view_id)
            for index, line in enumerate(stage["cropLimitLines"]):
                first, last = line["modelSpacePointsMm"][0], line["modelSpacePointsMm"][-1]
                point = ((first[0] + last[0]) / 2, (first[1] + last[1]) / 2)
                entity = msp.add_blockref("GJ_BREAK_SYMBOL", point, dxfattribs={"layer": "GJ-TEXT", "xscale": text_height * 0.8, "yscale": text_height * 0.8})
                cad_id = _derived_cad_id(self.ir["drawingPackageIrSha256"], f"system-break:{view_id}:{index}")
                provenance = {"requirementId": f"SYSTEM-CROP-BREAK-{view_id}", "sourceRefs": [f"drawing-ir:{line['cadObjectId']}"]}
                self._register(entity, cad_id, "system-annotation", provenance)

    def _add_paper_space(self, doc: ezdxf.document.Drawing) -> None:
        if "Layout1" in doc.layouts and "T0B-01" not in doc.layouts:
            doc.layouts.rename("Layout1", "T0B-01")
        title_requirements = {item["layoutName"]: item for item in self.ir["annotations"] if item.get("layoutName")}
        for layout_record in self.ir["paperSpace"]["layouts"]:
            name = layout_record["layoutName"]
            layout = doc.layouts.get(name) if name in doc.layouts else doc.layouts.new(name)
            layout.page_setup(size=(841, 594), margins=(0, 0, 0, 0), units="mm", rotation=0, scale=(1, 1), name="ISO_A1_FULL_BLEED", device="None")
            default_viewport = next((viewport for viewport in layout.query("VIEWPORT") if viewport.dxf.id == 1), None)
            _require(default_viewport is not None, f"{name} has no default paper-space viewport")
            default_viewport.dxf.layer = "0"
            frame = layout.add_lwpolyline([(5, 5), (836, 5), (836, 589), (5, 589), (5, 5)], dxfattribs={"layer": "GJ-FRAME"})
            frame_id = _derived_cad_id(self.ir["drawingPackageIrSha256"], f"system-frame:{name}")
            self._register(frame, frame_id, "system-paper-frame", {"systemType": "paper-frame", "layoutName": name, "drawingPackageIrSha256": self.ir["drawingPackageIrSha256"]})

            title_requirement = title_requirements[name]
            fields = {
                "PROJECT": self.contract["packageIdentity"]["title"],
                "DRAWINGTITLE": layout_record["title"],
                "DRAWINGNUMBER": name,
                "SCALE": "见图",
                "UNIT": "mm",
                "STATUS": "generated-not-qualified",
                "REVISION": self.contract["contractRevisionId"],
                "DATE": self.ir["generatedAt"][:10],
                "RESPONSIBILITYBOUNDARY": "团队演示/非正式签发",
            }
            title_insert = layout.add_blockref("GJ_TITLEBLOCK", (610, 5), dxfattribs={"layer": "GJ-FRAME"})
            title_insert.add_auto_attribs(fields)
            self._register_annotation(title_insert, title_requirement, "0")
            for index, attrib in enumerate(title_insert.attribs):
                self._register_annotation(attrib, title_requirement, f"title-attrib-{index}")

            for index, viewport_record in enumerate(layout_record["viewports"], start=2):
                x, y, width, height = viewport_record["paperRectMm"]
                stage = self.view_stages[viewport_record["viewId"]]
                sx1, sy1, sx2, sy2 = stage["stagedBoundsMm"]
                scale = float(viewport_record["paperScale"])
                viewport = layout.add_viewport(
                    center=(x + width / 2, y + height / 2),
                    size=(width, height),
                    view_center_point=((sx1 + sx2) / 2, (sy1 + sy2) / 2),
                    view_height=height / scale,
                    status=index,
                    dxfattribs={"layer": "GJ-FRAME", "flags": const.VSF_VIEWPORT_ZOOM_LOCKING},
                )
                viewport.dxf.id = index
                cad_id = _derived_cad_id(self.ir["drawingPackageIrSha256"], f"system-viewport:{name}:{viewport_record['viewId']}")
                self._register(viewport, cad_id, "system-viewport", {"systemType": "viewport", "layoutName": name, "viewId": viewport_record["viewId"], "locked": True})

    def build_document(self) -> ezdxf.document.Drawing:
        doc = self._new_document()
        line_index = self._add_structural_geometry(doc)
        self._add_material_hatches(doc, line_index)
        self._add_annotations(doc)
        self._add_paper_space(doc)
        expected_requirements = {item["requirementId"] for item in self.ir["annotations"]}
        _require(self.requirement_ids_rendered == expected_requirements, "native annotation closure is incomplete")
        return doc


def _write_sidecar(path: Path, rows: list[dict]) -> None:
    ordered = sorted(rows, key=lambda item: item["cadObjectId"])
    raw = "".join(json.dumps(row, ensure_ascii=False, sort_keys=True, separators=(",", ":")) + "\n" for row in ordered)
    path.write_text(raw, encoding="utf-8", newline="\n")


def _validate_readback(path: Path, ir: dict, sidecar_rows: list[dict]) -> dict:
    doc = ezdxf.readfile(path)
    auditor = doc.audit()
    _require(not auditor.errors, f"ezdxf readback audit returned {len(auditor.errors)} errors")
    _require(doc.header["$INSUNITS"] == 4, "DXF readback lost millimetre units")
    forbidden_types = {
        entity.dxftype()
        for entity in doc.entitydb.values()
        if any(token in entity.dxftype().upper() for token in ("IMAGE", "UNDERLAY", "PROXY"))
    }
    _require(not forbidden_types, f"DXF readback contains forbidden external entity types: {sorted(forbidden_types)}")
    xref_blocks = [block.name for block in doc.blocks if int(block.block.dxf.flags) & (4 | 8 | 16 | 32)]
    _require(not xref_blocks, f"DXF readback contains xref blocks: {xref_blocks}")
    _require({layout.name for layout in doc.layouts if layout.name != "Model"} == {"T0B-01", "T0B-02"}, "DXF readback layout set differs")
    msp = doc.modelspace()
    structural = [entity for entity in msp if entity.dxftype() in {"LINE", "LWPOLYLINE"} and entity.dxf.layer in {"GJ-CUT", "GJ-OUTLINE", "GJ-PROJECTION", "GJ-HIDDEN"}]
    hatches = list(msp.query("HATCH"))
    _require(len(structural) == ir["statistics"]["structuralLineCount"], "DXF readback structural line count differs")
    _require(len(hatches) == ir["statistics"]["materialRegionCount"], "DXF readback material hatch count differs")
    _require(all(entity.has_xdata(APPID) for entity in [*structural, *hatches]), "DXF readback lost structural XDATA")
    all_viewports = [viewport for name in ("T0B-01", "T0B-02") for viewport in doc.layouts.get(name).query("VIEWPORT")]
    default_viewports = [viewport for viewport in all_viewports if viewport.dxf.id == 1]
    user_viewports = [viewport for viewport in all_viewports if viewport.dxf.id > 1]
    _require(len(default_viewports) == 2 and all(viewport.dxf.layer == "0" for viewport in default_viewports), "DXF readback default paper-space viewport layer differs")
    _require(len(user_viewports) == 10 and all(viewport.dxf.flags & const.VSF_VIEWPORT_ZOOM_LOCKING and viewport.dxf.layer == "GJ-FRAME" for viewport in user_viewports), "DXF readback user viewport count, lock, or layer differs")
    type_counts = Counter(entity.dxftype() for entity in msp)
    _require(all(type_counts[kind] > 0 for kind in ("DIMENSION", "MTEXT", "HATCH", "INSERT")), "native model-space object closure is incomplete")
    _require(len(sidecar_rows) == len({row["cadObjectId"] for row in sidecar_rows}) == len({row["handle"] for row in sidecar_rows}), "sidecar CAD object or handle ids are not unique")
    return {
        "ezdxfAuditErrors": len(auditor.errors),
        "modelSpaceTypeCounts": dict(sorted(type_counts.items())),
        "layoutCount": 2,
        "defaultViewportLayerZeroCount": len(default_viewports),
        "lockedUserViewportCount": len(user_viewports),
        "structuralXdataCoverage": 1.0,
        "materialHatchCount": len(hatches),
    }


def build_native_dxf(contract_path: Path, ir_path: Path, manifest_path: Path, font_config_path: Path, output_dir: Path) -> dict:
    _require(contract_path.name == "t0b-v2-drawing-package-contract.json", "unexpected DrawingPackageContract input")
    _require(ir_path.name == "drawing-package.ir.json.gz", "unexpected DrawingPackageIR input")
    _require(manifest_path.name == "geometry-manifest.json", "unexpected geometry manifest input")
    _require(font_config_path.name == "logical_font_config.json", "unexpected logical font input")
    contract = _load_json(contract_path)
    ir = _load_json_gzip(ir_path)
    manifest = _load_json(manifest_path)
    font_config = _load_json(font_config_path)
    font_path = REPOSITORY_ROOT / Path(*font_config.get("fontAssetRelativePath", "").split("/"))
    font_manifest_path = REPOSITORY_ROOT / Path(*font_config.get("fontManifestRelativePath", "").split("/"))
    _require(font_path.is_file() and _file_hash(font_path) == font_config.get("fontSha256"), "bound font file hash differs")
    _require(font_manifest_path.is_file() and _file_hash(font_manifest_path) == font_config.get("fontManifestSha256"), "bound font manifest hash differs")
    _require(_file_hash(manifest_path) == contract["manifestBinding"]["sha256"], "geometry manifest file hash differs from contract")
    generator = NativeDXFGenerator(contract, ir, manifest, font_config)

    staging = output_dir.parent / f".{output_dir.name}.staging-{uuid4().hex}"
    staging.mkdir(parents=True, exist_ok=False)
    try:
        doc = generator.build_document()
        dxf_path = staging / DXF_NAME
        doc.commit_pending_changes()
        doc.classes.add_required_classes(doc.dxfversion)
        doc.classes.classes = OrderedDict(sorted(doc.classes.classes.items(), key=lambda item: item[0]))
        metadata = doc.ezdxf_metadata()
        metadata[CREATED_BY_EZDXF] = CONST_MARKER_STRING
        metadata[WRITTEN_BY_EZDXF] = CONST_MARKER_STRING
        previous_fixed_metadata = ezdxf.options.write_fixed_meta_data_for_testing
        ezdxf.options.write_fixed_meta_data_for_testing = True
        try:
            doc.saveas(dxf_path, encoding="utf-8", fmt="asc")
        finally:
            ezdxf.options.write_fixed_meta_data_for_testing = previous_fixed_metadata
        _write_sidecar(staging / SIDECAR_NAME, generator.sidecar_rows)
        readback = _validate_readback(dxf_path, ir, generator.sidecar_rows)
        dxf_bytes = dxf_path.read_bytes()
        lowered = dxf_bytes.decode("utf-8", errors="ignore").lower()
        forbidden_token = next((token for token in FORBIDDEN_OUTPUT_TOKENS if token in lowered), None)
        _require(forbidden_token is None, f"DXF contains a forbidden external dependency token: {forbidden_token}")
        _require(not re.search(r"[a-z]:[/\\]", lowered), "DXF contains an absolute path")
        sidecar_path = staging / SIDECAR_NAME
        blockers = list(ir["qualificationBoundary"]["requiredBlockers"])
        record = {
            "schemaVersion": "t0b-v2-native-dxf-build-1",
            "status": "generated-not-qualified",
            "L1": False,
            "useBoundary": ["demo-only", "not-for-formal-signoff"],
            "generatedAt": ir["generatedAt"],
            "inputs": {
                "contract": {"name": contract_path.name, "sha256": _file_hash(contract_path), "signature": contract["contractSignature"], "revisionId": contract["contractRevisionId"]},
                "drawingPackageIr": {"name": ir_path.name, "sha256": _file_hash(ir_path), "drawingPackageIrSha256": ir["drawingPackageIrSha256"]},
                "manifest": {"name": manifest_path.name, "sha256": _file_hash(manifest_path), "producerType": manifest["producerType"]},
                "logicalFont": {"name": font_config_path.name, "sha256": _file_hash(font_config_path), **font_config},
            },
            "outputs": {
                "dxf": {"name": DXF_NAME, "sha256": sha256(dxf_bytes).hexdigest(), "dxfVersion": doc.dxfversion, "insunits": 4, "modelSpaceScale": "1:1"},
                "provenanceSidecar": {"name": SIDECAR_NAME, "sha256": _file_hash(sidecar_path), "rowCount": len(generator.sidecar_rows)},
            },
            "readback": readback,
            "autocadCompatibility": {
                "earthPatternId": "GJ_EARTH_V1",
                "earthPatternLineOffsetsMm": [[0, 24], [24, 0]],
                "parallelPatternOffsetRejected": True,
                "defaultPaperViewportLayer": "0",
                "userViewportLayer": "GJ-FRAME",
            },
            "qualification": {"requiredBlockers": blockers, "fontAssetStatus": "bound-licensed-static-instance", "generatorMaySetEligible": False},
            "crossFormatOutputs": {"status": "generated-by-separate-ir-consumer", "sourceIrRequired": True},
        }
        (staging / BUILD_RECORD_NAME).write_text(json.dumps(record, ensure_ascii=False, sort_keys=True, indent=2) + "\n", encoding="utf-8", newline="\n")
        if output_dir.exists():
            backup = output_dir.parent / f".{output_dir.name}.previous-{uuid4().hex}"
            os.replace(output_dir, backup)
            try:
                os.replace(staging, output_dir)
            except Exception:
                os.replace(backup, output_dir)
                raise
            shutil.rmtree(backup)
        else:
            os.replace(staging, output_dir)
        return record
    except Exception:
        shutil.rmtree(staging, ignore_errors=True)
        raise


def main() -> int:
    parser = argparse.ArgumentParser(description="Generate native R2018 DXF from frozen DrawingPackageIR.")
    parser.add_argument("--contract", type=Path, required=True)
    parser.add_argument("--ir", type=Path, required=True)
    parser.add_argument("--manifest", type=Path, required=True)
    parser.add_argument("--font-config", type=Path, required=True)
    parser.add_argument("--output-dir", type=Path, required=True)
    args = parser.parse_args()
    record = build_native_dxf(args.contract, args.ir, args.manifest, args.font_config, args.output_dir)
    print(json.dumps(record, ensure_ascii=False, indent=2))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
