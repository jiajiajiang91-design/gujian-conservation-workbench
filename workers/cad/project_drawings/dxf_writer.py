from __future__ import annotations

import hashlib
import json
import uuid
from collections import OrderedDict
from pathlib import Path
from typing import Any

import ezdxf
from ezdxf import const
from ezdxf.document import CONST_MARKER_STRING, CREATED_BY_EZDXF, WRITTEN_BY_EZDXF


CAD_NAMESPACE = uuid.UUID("b7fbddea-740b-524a-9a26-731688e73043")
APP_ID = "GJ_PROV"
FIXED_JULIAN_DATE = 2451544.5


def _hash(path: Path) -> str:
    return hashlib.sha256(path.read_bytes()).hexdigest()


def _cad_id(ir_hash: str, value: str) -> str:
    return str(uuid.uuid5(CAD_NAMESPACE, f"{ir_hash}:{value}"))


def _stage_views(ir: dict[str, Any]) -> dict[str, dict[str, Any]]:
    stages: dict[str, dict[str, Any]] = {}
    cursor = 0.0
    for view in sorted(ir["views"], key=lambda item: item["viewId"]):
        width = max(view["boundsMm"][1][0] - view["boundsMm"][0][0], 1.0)
        offset = [cursor - view["boundsMm"][0][0], -view["boundsMm"][0][1]]
        stages[view["viewId"]] = {"offset": offset, "bounds": [cursor, 0.0, cursor + width, view["boundsMm"][1][1] - view["boundsMm"][0][1]]}
        cursor += width + 2000.0
    return stages


class NativeDxfWriter:
    def __init__(self, ir: dict[str, Any], font_file_name: str):
        self.ir = ir
        self.font_file_name = font_file_name
        self.stages = _stage_views(ir)
        self.sidecar: list[dict[str, Any]] = []

    def _register(self, entity, cad_id: str, object_class: str, provenance: dict[str, Any]) -> None:
        payload = {
            "cadObjectId": cad_id,
            "handle": entity.dxf.handle,
            "dxftype": entity.dxftype(),
            "objectClass": object_class,
            **provenance,
        }
        entity.set_xdata(APP_ID, [(1000, cad_id), (1000, json.dumps(provenance, ensure_ascii=False, sort_keys=True, separators=(",", ":")))])
        self.sidecar.append(payload)

    def _document(self):
        # Keep the DXF resource table minimal. The full ezdxf setup adds many
        # unused OpenSans/Liberation styles that qualification tools then report
        # as substituted fonts even though the drawing never references them.
        doc = ezdxf.new("R2018")
        doc.header["$INSUNITS"] = 4
        doc.header["$TDCREATE"] = FIXED_JULIAN_DATE
        doc.header["$TDUPDATE"] = FIXED_JULIAN_DATE
        fingerprint = str(uuid.uuid5(CAD_NAMESPACE, self.ir["drawingIrSha256"])).upper()
        version = str(uuid.uuid5(CAD_NAMESPACE, self.ir["artifactRequirementMatrixId"])).upper()
        doc.header["$FINGERPRINTGUID"] = "{" + fingerprint + "}"
        doc.header["$VERSIONGUID"] = "{" + version + "}"
        doc.header["$LASTSAVEDBY"] = "GUJIAN-CAD-WORKER"
        doc.appids.add(APP_ID)
        if "GJ-DASHED" not in doc.linetypes:
            doc.linetypes.add("GJ-DASHED", pattern=[18.0, 12.0, -6.0], description="Gujian hidden or pending boundary")
        if "GJ-CENTER" not in doc.linetypes:
            doc.linetypes.add("GJ-CENTER", pattern=[39.0, 24.0, -6.0, 3.0, -6.0], description="Gujian axis centre line")
        layers = {
            "GJ-CUT": (7, 50, "Continuous"), "GJ-OUTLINE": (7, 35, "Continuous"),
            "GJ-PROJECTION": (8, 18, "Continuous"), "GJ-HIDDEN": (8, 18, "GJ-DASHED"),
            "GJ-AXIS": (4, 13, "GJ-CENTER"), "GJ-DIMENSION": (2, 18, "Continuous"),
            "GJ-TEXT": (7, 18, "Continuous"), "GJ-HATCH": (9, 13, "Continuous"),
            "GJ-CONDITION": (1, 30, "GJ-DASHED"), "GJ-FRAME": (7, 35, "Continuous"),
        }
        for name, (color, lineweight, linetype) in layers.items():
            if name not in doc.layers:
                doc.layers.add(name, color=color, lineweight=lineweight, linetype=linetype)
        style = doc.styles.add("GJ-TEXT", font=self.font_file_name)
        style.set_extended_font_data("Gujian Sans SC", italic=False, bold=False)
        dim = doc.dimstyles.duplicate_entry("Standard", "GJ-DIM")
        dim.dxf.dimtxsty = "GJ-TEXT"
        dim.dxf.dimtxt = 125
        dim.dxf.dimasz = 100
        title = doc.blocks.new("GJ_TITLEBLOCK")
        title.add_lwpolyline([(0, 0), (221, 0), (221, 30), (0, 30), (0, 0)], dxfattribs={"layer": "GJ-FRAME"})
        for tag, point, height in (("PROJECT", (3, 22), 4), ("TITLE", (3, 14), 4), ("NUMBER", (3, 6), 3), ("STATUS", (83, 6), 3), ("REVISION", (145, 6), 3), ("DATE", (178, 6), 3)):
            title.add_attdef(tag, insert=point, height=height, dxfattribs={"layer": "GJ-TEXT", "style": "GJ-TEXT"})
        condition = doc.blocks.new("GJ_CONDITION_MARK")
        condition.add_circle((0, 0), 120, dxfattribs={"layer": "GJ-CONDITION"})
        condition.add_line((-85, -85), (85, 85), dxfattribs={"layer": "GJ-CONDITION"})
        condition.add_line((-85, 85), (85, -85), dxfattribs={"layer": "GJ-CONDITION"})
        return doc

    # 纸面标注排布的共用常量（GB/T 50001 图线与字体一章的取值区间内）。
    # 模型空间按视图比例放大：纸上 8 mm 在 1:100 的图上是 800 mm。
    DIMENSION_OFFSET_PAPER_MM = 8.0
    TITLE_OFFSET_PAPER_MM = 15.0
    QUALIFICATION_OFFSET_PAPER_MM = 6.0

    def _add_model_space(self, doc) -> None:
        msp = doc.modelspace()
        layer_map = self.ir["layerPolicy"]
        for view in self.ir["views"]:
            stage = self.stages[view["viewId"]]
            for line in view["lines"]:
                points = [(point[0] + stage["offset"][0], point[1] + stage["offset"][1]) for point in line["pointsMm"]]
                entity = msp.add_line(points[0], points[1], dxfattribs={"layer": layer_map[line["lineClass"]]})
                self._register(entity, _cad_id(self.ir["drawingIrSha256"], line["lineId"]), "structure", {
                    "viewId": view["viewId"], "sourceEntityId": line["sourceEntityId"],
                    "geometryRevisionId": self.ir["geometryRevisionId"], "derivation": line["derivation"],
                })
            for region in view["materialRegions"]:
                boundary = [(point[0] + stage["offset"][0], point[1] + stage["offset"][1]) for point in region["boundaryMm"]]
                hatch = msp.add_hatch(color=9, dxfattribs={"layer": "GJ-HATCH"})
                hatch.set_pattern_fill("ANSI31", scale=80.0, angle=45.0)
                hatch.paths.add_polyline_path(boundary, is_closed=True)
                self._register(hatch, _cad_id(self.ir["drawingIrSha256"], region["regionId"]), "materialRegion", {
                    "viewId": view["viewId"], "sourceEntityId": region["sourceEntityId"],
                    "geometryRevisionId": self.ir["geometryRevisionId"], "materialCode": region["materialCode"],
                })
        # 标注只从 IR 取。写出器不再自己判断该标什么，只负责怎么画。
        for annotation in self.ir["annotations"]:
            self._add_annotation(msp, annotation)

    def _add_annotation(self, msp, annotation: dict[str, Any]) -> None:
        view = next((item for item in self.ir["views"] if item["viewId"] == annotation["viewId"]), None)
        if view is None:
            raise ValueError(f"annotation points at an unknown view: {annotation['requirementId']}")
        stage = self.stages[view["viewId"]]
        offset = stage["offset"]
        scale = float(view["scaleDenominator"])
        layer = self.ir["layerPolicy"][annotation["layerKey"]]
        height = float(annotation["paperTextHeightMm"]) * scale
        placed = [(point[0] + offset[0], point[1] + offset[1]) for point in annotation["anchorMm"]]
        cad_id = _cad_id(self.ir["drawingIrSha256"], annotation["requirementId"])
        kind = annotation["kind"]

        if kind == "overallDimension":
            first, second = placed[0], placed[1]
            base_y = first[1] - self.DIMENSION_OFFSET_PAPER_MM * scale
            dimension = msp.add_linear_dim(
                base=((first[0] + second[0]) / 2, base_y), p1=first, p2=second, angle=0,
                dimstyle="GJ-DIM", dxfattribs={"layer": layer},
            )
            dimension.render()
            self._register(dimension.dimension, cad_id, "annotation", annotation)
            return

        if kind == "viewTitle":
            anchor = (placed[0][0], placed[0][1] - self.TITLE_OFFSET_PAPER_MM * scale)
            label = msp.add_text(annotation["text"], dxfattribs={
                "layer": layer, "height": height, "style": "GJ-TEXT", "insert": anchor,
            })
            self._register(label, cad_id, "annotation", annotation)
            return

        if kind == "qualification":
            anchor = (placed[0][0], placed[0][1] + self.QUALIFICATION_OFFSET_PAPER_MM * scale)
            note = msp.add_mtext(annotation["text"], dxfattribs={
                "layer": layer, "char_height": height, "style": "GJ-TEXT",
                "width": max(1200.0, (stage["bounds"][2] - stage["bounds"][0]) * 0.45),
            })
            note.set_location(anchor)
            self._register(note, cad_id, "annotation", annotation)
            return

        if kind == "conditionCandidate":
            insert = msp.add_blockref("GJ_CONDITION_MARK", placed[0], dxfattribs={"layer": layer})
            self._register(insert, cad_id, "annotation", annotation)
            note = msp.add_mtext(annotation["text"], dxfattribs={
                "layer": layer, "char_height": height, "style": "GJ-TEXT",
            })
            note.set_location((placed[0][0] + 180, placed[0][1] + 180))
            self._register(note, _cad_id(self.ir["drawingIrSha256"], annotation["requirementId"] + ":text"), "annotation", annotation)
            return

        raise ValueError(f"unsupported annotation kind: {kind}")

    def _add_paper_space(self, doc) -> None:
        first_name = self.ir["sheets"][0]["drawingNumber"]
        if "Layout1" in doc.layouts and first_name not in doc.layouts:
            doc.layouts.rename("Layout1", first_name)
        view_by_id = {item["viewId"]: item for item in self.ir["views"]}
        requirement_by_id = {item["id"]: item for item in self.ir["viewRequirements"]}
        for sheet in self.ir["sheets"]:
            name = sheet["drawingNumber"]
            layout = doc.layouts.get(name) if name in doc.layouts else doc.layouts.new(name)
            width, height = sheet["pageMm"]
            layout.page_setup(size=(width, height), margins=(0, 0, 0, 0), units="mm", rotation=0, scale=(1, 1), name=f"ISO_{int(width)}x{int(height)}", device="None")
            default_viewport = next((item for item in layout.query("VIEWPORT") if item.dxf.id == 1), None)
            if default_viewport is not None:
                default_viewport.dxf.layer = "0"
            frame = layout.add_lwpolyline([(5, 5), (width - 5, 5), (width - 5, height - 5), (5, height - 5), (5, 5)], dxfattribs={"layer": "GJ-FRAME"})
            self._register(frame, _cad_id(self.ir["drawingIrSha256"], f"frame:{name}"), "system", {"sheetId": sheet["id"], "systemType": "paperFrame"})
            insert = layout.add_blockref("GJ_TITLEBLOCK", (width - 226, 5), dxfattribs={"layer": "GJ-FRAME"})
            insert.add_auto_attribs({
                "PROJECT": self.ir["titleZh"], "TITLE": sheet["displayLabelZh"], "NUMBER": name,
                "STATUS": "代理成果·未签发", "REVISION": self.ir["revisionLabel"], "DATE": "未签发",
            })
            self._register(insert, _cad_id(self.ir["drawingIrSha256"], f"titleblock:{name}"), "system", {"sheetId": sheet["id"], "systemType": "titleBlock"})
            for index, view_id in enumerate(sheet["viewIds"], start=2):
                requirement = requirement_by_id[view_id]
                rect = requirement["viewportRectMm"]
                stage = self.stages[view_id]
                sx1, sy1, sx2, sy2 = stage["bounds"]
                viewport = layout.add_viewport(
                    center=(rect[0] + rect[2] / 2, rect[1] + rect[3] / 2), size=(rect[2], rect[3]),
                    view_center_point=((sx1 + sx2) / 2, (sy1 + sy2) / 2), view_height=rect[3] * requirement["scaleDenominator"],
                    status=index, dxfattribs={"layer": "GJ-FRAME", "flags": const.VSF_VIEWPORT_ZOOM_LOCKING},
                )
                viewport.dxf.id = index
                self._register(viewport, _cad_id(self.ir["drawingIrSha256"], f"viewport:{name}:{view_id}"), "system", {
                    "sheetId": sheet["id"], "viewId": view_id, "geometryRevisionId": self.ir["geometryRevisionId"], "locked": True,
                })
                view = view_by_id[view_id]
                view_label = layout.add_mtext(
                    f"{view['displayLabelZh']}  1:{view['scaleDenominator']}  {view['drawingRef']}",
                    dxfattribs={"layer": "GJ-TEXT", "char_height": 4, "style": "GJ-TEXT"},
                )
                view_label.set_location((rect[0], rect[1] - 6))
                self._register(view_label, _cad_id(self.ir["drawingIrSha256"], f"paper-title:{name}:{view_id}"), "annotation", {
                    "requirementId": f"paper-title:{view_id}", "sheetId": sheet["id"], "viewId": view_id, "sourceRefs": [view_id],
                })

    def write(self, output_dir: Path) -> dict[str, Any]:
        output_dir.mkdir(parents=True, exist_ok=True)
        doc = self._document()
        self._add_model_space(doc)
        self._add_paper_space(doc)
        dxf_path = output_dir / "drawings.dxf"
        sidecar_path = output_dir / "drawing-source-map.ndjson"
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
        rows = sorted(self.sidecar, key=lambda item: item["cadObjectId"])
        sidecar_path.write_text("".join(json.dumps(item, ensure_ascii=False, sort_keys=True, separators=(",", ":")) + "\n" for item in rows), encoding="utf-8", newline="\n")
        reopened = ezdxf.readfile(dxf_path)
        auditor = reopened.audit()
        if auditor.errors:
            raise ValueError(f"DXF audit failed: {len(auditor.errors)}")
        return {
            "dxf": {"fileName": dxf_path.name, "sha256": _hash(dxf_path), "byteLength": dxf_path.stat().st_size},
            "sourceMap": {"fileName": sidecar_path.name, "sha256": _hash(sidecar_path), "byteLength": sidecar_path.stat().st_size},
            "trackedObjectCount": len(rows),
        }
