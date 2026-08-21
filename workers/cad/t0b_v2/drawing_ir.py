from __future__ import annotations

import argparse
import gzip
from hashlib import sha256
import json
import os
from pathlib import Path
import shutil
from uuid import UUID, uuid4, uuid5

from .drawing_contract import (
    DrawingContractError,
    prepare_drawing_generation_input,
    load_drawing_package_contract,
)


CAD_OBJECT_NAMESPACE = UUID("f19472cf-8a79-596c-b52f-d05c4dd2bc70")


class DrawingIRError(ValueError):
    pass


def _hash_bytes(value: bytes) -> str:
    return sha256(value).hexdigest()


def _file_hash(path: Path) -> str:
    digest = sha256()
    with path.open("rb") as stream:
        for chunk in iter(lambda: stream.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def _canonical_hash(value: dict) -> str:
    raw = json.dumps(value, ensure_ascii=False, sort_keys=True, separators=(",", ":")).encode("utf-8")
    return sha256(raw).hexdigest()


def _cad_id(revision_id: str, object_kind: str, view_id: str, source_id: str) -> str:
    return str(uuid5(CAD_OBJECT_NAMESPACE, json.dumps([revision_id, object_kind, view_id, source_id], separators=(",", ":"))))


def _apply(matrix: list[list[float]], point: list[float]) -> list[float]:
    return [
        round(float(matrix[0][0] * point[0] + matrix[0][1] * point[1] + matrix[0][2]), 9),
        round(float(matrix[1][0] * point[0] + matrix[1][1] * point[1] + matrix[1][2]), 9),
    ]


def _read_bound_json_gzip(path: Path) -> dict:
    with gzip.open(path, "rt", encoding="utf-8") as stream:
        return json.load(stream)


def _safe_bound_path(base_dir: Path, relative_path: str) -> Path:
    base = base_dir.resolve()
    path = (base / Path(*relative_path.split("/"))).resolve()
    try:
        path.relative_to(base)
    except ValueError as error:
        raise DrawingIRError("bound input escaped the drawing package directory") from error
    return path


class DrawingPackageIRBuilder:
    def __init__(self, generation_input: dict, contract_dir: Path) -> None:
        try:
            self.contract = prepare_drawing_generation_input(generation_input)
        except DrawingContractError as error:
            raise DrawingIRError(str(error)) from error
        self.contract_dir = contract_dir
        self.stages = {stage["viewId"]: stage for stage in self.contract["viewStages"]}
        self.bindings = {binding["viewId"]: binding for binding in self.contract["viewGeometryBindings"]}

    def _load_manifest(self) -> dict:
        binding = self.contract["manifestBinding"]
        path = _safe_bound_path(self.contract_dir, binding["relativePath"])
        if _file_hash(path) != binding["sha256"]:
            raise DrawingIRError("geometry manifest hash differs from DrawingPackageContract")
        manifest = json.loads(path.read_text(encoding="utf-8"))
        if manifest.get("geometryRevisionId") != self.contract["geometryRevisionId"] or manifest.get("producerType") != "demo":
            raise DrawingIRError("geometry manifest identity differs from DrawingPackageContract")
        source_refs = manifest.get("sourceRefs", [])
        entity_refs = [ref for entity in manifest.get("entities", []) for ref in entity.get("sourceRefs", [])]
        if not source_refs or not all(isinstance(ref, str) and ref.startswith("demo:") for ref in [*source_refs, *entity_refs]):
            raise DrawingIRError("manifest contains a non-demo source dependency")
        return manifest

    def _load_views(self) -> dict[str, dict]:
        result: dict[str, dict] = {}
        for binding in self.contract["viewGeometryBindings"]:
            path = _safe_bound_path(self.contract_dir, binding["relativePath"])
            if _file_hash(path) != binding["fileSha256"]:
                raise DrawingIRError(f"{binding['viewId']} file hash differs from DrawingPackageContract")
            view = _read_bound_json_gzip(path)
            if view.get("viewId") != binding["viewId"] or view.get("viewGeometrySha256") != binding["viewGeometrySha256"]:
                raise DrawingIRError(f"{binding['viewId']} internal ViewGeometry identity is invalid")
            if view.get("geometryRevisionId") != self.contract["geometryRevisionId"] or view.get("viewContractRevisionId") != self.contract["viewContractRevisionId"]:
                raise DrawingIRError(f"{binding['viewId']} revision binding is invalid")
            if view.get("status") != "generated-not-qualified" or view.get("qualification") != "not-drawing-output":
                raise DrawingIRError(f"{binding['viewId']} has an unexpected qualification state")
            if view.get("viewFrame", {}).get("clipRectMm") != self.stages[binding["viewId"]]["sourceClipRectMm"]:
                raise DrawingIRError(f"{binding['viewId']} clip rectangle differs from its staging contract")
            result[binding["viewId"]] = view
        return result

    def _line_record(self, view_id: str, source: dict, entity: dict, structural: bool) -> dict:
        stage = self.stages[view_id]
        points = source["pointsMm"]
        model_points = [_apply(stage["viewToModelSpace"], point) for point in points]
        restored = [_apply(stage["modelSpaceToView"], point) for point in model_points]
        tolerance = float(self.contract["modelSpacePolicy"]["inverseLineMatchToleranceMm"])
        if any(max(abs(restored[index][axis] - points[index][axis]) for axis in range(2)) > tolerance for index in range(len(points))):
            raise DrawingIRError(f"{view_id}:{source['lineId']} failed inverse staging match")
        line_class = source["lineClass"]
        layer_policy = self.contract["layerPolicy"]
        layer = layer_policy["baseClassLayerMap"].get(line_class)
        if not structural and line_class == "cropLimit":
            layer = "GJ-HATCH"
        if source.get("visibility") == "hidden":
            layer = layer_policy["visibilityLayerOverride"]["hidden"]
        if layer is None:
            raise DrawingIRError(f"{view_id}:{source['lineId']} has no frozen layer mapping")
        cad_type = "LWPOLYLINE" if len(points) > 2 or source.get("closed") else "LINE"
        cad_object_id = _cad_id(self.contract["contractRevisionId"], "structural-line" if structural else "crop-limit", view_id, source["lineId"])
        return {
            "cadObjectId": cad_object_id,
            "cadObjectType": cad_type,
            "objectClass": "structural" if structural else "nonstructural-crop-limit",
            "viewId": view_id,
            "sourceLineId": source["lineId"],
            "sourceEntityId": source["sourceEntityId"],
            "sourceComponentType": source["sourceComponentType"],
            "sourceRefs": entity["sourceRefs"],
            "geometryRevisionId": self.contract["geometryRevisionId"],
            "viewContractRevisionId": self.contract["viewContractRevisionId"],
            "derivation": source["derivation"],
            "derivationTransform": source["derivationTransform"],
            "lineClass": line_class,
            "visibility": source.get("visibility", "visible"),
            "layer": layer,
            "viewPointsMm": points,
            "modelSpacePointsMm": model_points,
            "xdata": {
                "applicationId": self.contract["provenancePolicy"]["xdataApplicationId"],
                "sourceEntityId": source["sourceEntityId"],
                "geometryRevisionId": self.contract["geometryRevisionId"],
                "viewContractRevisionId": self.contract["viewContractRevisionId"],
                "viewId": view_id,
                "derivation": source["derivation"],
                "derivationTransform": source["derivationTransform"],
            },
        }

    def _target_hatch(self, material_code: str) -> tuple[str, dict]:
        material_policy = self.contract["materialPolicy"]
        pattern_key = material_policy["materialCodePatternMap"].get(material_code)
        if pattern_key is None or pattern_key not in material_policy["patterns"]:
            raise DrawingIRError(f"unknown material code has no target hatch: {material_code}")
        return pattern_key, material_policy["patterns"][pattern_key]

    def _material_records(self, view_id: str, view: dict, structural_by_line_id: dict[str, str], manifest_entities: dict[str, dict]) -> list[dict]:
        stage = self.stages[view_id]
        result: list[dict] = []
        for source in view.get("cutRegions", []):
            boundary_ids = [source["outerBoundaryLineId"], *source.get("holeBoundaryLineIds", [])]
            if any(line_id not in structural_by_line_id for line_id in boundary_ids):
                raise DrawingIRError(f"{view_id}:{source['regionId']} refers to a missing cut boundary")
            cad_object_id = _cad_id(self.contract["contractRevisionId"], "material-region", view_id, source["regionId"])
            pattern_key, pattern = self._target_hatch(source["materialCode"])
            result.append(
                {
                    "cadObjectId": cad_object_id,
                    "cadObjectType": "HATCH",
                    "objectClass": "material-region",
                    "viewId": view_id,
                    "sourceRegionId": source["regionId"],
                    "sourceKind": "ViewGeometry.cutRegion",
                    "sourceEntityId": source["sourceEntityId"],
                    "sourceRefs": manifest_entities[source["sourceEntityId"]]["sourceRefs"],
                    "materialCode": source["materialCode"],
                    "sourceMaterialHatch": source.get("materialHatch"),
                    "targetHatchPatternKey": pattern_key,
                    "targetHatchPatternId": pattern["patternId"],
                    "layer": "GJ-HATCH",
                    "boundaryCadObjectIds": [structural_by_line_id[line_id] for line_id in boundary_ids],
                    "xdata": {"applicationId": self.contract["provenancePolicy"]["xdataApplicationId"], "sourceEntityId": source["sourceEntityId"], "geometryRevisionId": self.contract["geometryRevisionId"], "viewContractRevisionId": self.contract["viewContractRevisionId"], "viewId": view_id, "derivation": "ViewGeometry.cutRegion", "derivationTransform": view["viewFrame"]["modelToView"]},
                }
            )
        for source in view.get("materialRegions", []):
            cad_object_id = _cad_id(self.contract["contractRevisionId"], "material-region", view_id, source["regionId"])
            pattern_key, pattern = self._target_hatch(source["materialCode"])
            result.append(
                {
                    "cadObjectId": cad_object_id,
                    "cadObjectType": "HATCH",
                    "objectClass": "material-region",
                    "viewId": view_id,
                    "sourceRegionId": source["regionId"],
                    "sourceKind": "ViewGeometry.materialRegion",
                    "sourceEntityId": source["sourceEntityId"],
                    "sourceRefs": manifest_entities[source["sourceEntityId"]]["sourceRefs"],
                    "materialCode": source["materialCode"],
                    "sourceMaterialHatch": source.get("materialHatch"),
                    "targetHatchPatternKey": pattern_key,
                    "targetHatchPatternId": pattern["patternId"],
                    "layer": "GJ-HATCH",
                    "viewOuterMm": source["outerMm"],
                    "viewHolesMm": source["holesMm"],
                    "modelSpaceOuterMm": [_apply(stage["viewToModelSpace"], point) for point in source["outerMm"]],
                    "modelSpaceHolesMm": [[_apply(stage["viewToModelSpace"], point) for point in ring] for ring in source["holesMm"]],
                    "xdata": {"applicationId": self.contract["provenancePolicy"]["xdataApplicationId"], "sourceEntityId": source["sourceEntityId"], "geometryRevisionId": self.contract["geometryRevisionId"], "viewContractRevisionId": self.contract["viewContractRevisionId"], "viewId": view_id, "derivation": "ViewGeometry.materialRegion", "derivationTransform": view["viewFrame"]["modelToView"]},
                }
            )
        return sorted(result, key=lambda item: item["cadObjectId"])

    def _annotation_records(self) -> list[dict]:
        result: list[dict] = []
        for view_id, categories in self.contract["annotationRequirements"]["views"].items():
            for category, requirements in categories.items():
                for requirement in requirements:
                    requirement_id = requirement["requirementId"]
                    result.append(
                        {
                            "cadObjectId": _cad_id(self.contract["contractRevisionId"], "annotation", view_id, requirement_id),
                            "cadObjectType": requirement["cadType"],
                            "objectClass": "annotation-requirement",
                            "viewId": view_id,
                            "category": category,
                            "requirementId": requirement_id,
                            "sourceRefs": requirement["sourceRefs"],
                            "semanticPayload": requirement,
                            "xdata": {"applicationId": self.contract["provenancePolicy"]["xdataApplicationId"], "requirementId": requirement_id, "sourceRefs": requirement["sourceRefs"]},
                        }
                    )
        for requirement in self.contract["annotationRequirements"]["titleBlocks"]:
            requirement_id = requirement["requirementId"]
            result.append(
                {
                    "cadObjectId": _cad_id(self.contract["contractRevisionId"], "system-title-block", requirement["layoutName"], requirement_id),
                    "cadObjectType": requirement["cadType"],
                    "objectClass": self.contract["provenancePolicy"]["systemObjectClass"],
                    "layoutName": requirement["layoutName"],
                    "category": "titleBlocks",
                    "requirementId": requirement_id,
                    "sourceRefs": requirement["sourceRefs"],
                    "semanticPayload": requirement,
                    "xdata": {"applicationId": self.contract["provenancePolicy"]["xdataApplicationId"], "requirementId": requirement_id, "sourceRefs": requirement["sourceRefs"]},
                }
            )
        return sorted(result, key=lambda item: (item.get("viewId", item.get("layoutName")), item["requirementId"]))

    def build(self) -> dict:
        manifest = self._load_manifest()
        views = self._load_views()
        entities = {entity["entityId"]: entity for entity in manifest["entities"]}
        view_stages: list[dict] = []
        structural_count = 0
        crop_limit_count = 0
        material_count = 0
        sidecar_rows: list[dict] = []

        for view_id in sorted(views):
            view = views[view_id]
            source_lines = [*view.get("cutLines", []), *view.get("projectionLines", [])]
            structural_lines = [self._line_record(view_id, source, entities[source["sourceEntityId"]], True) for source in source_lines]
            crop_limit_lines = [self._line_record(view_id, source, entities[source["sourceEntityId"]], False) for source in view.get("cropLimitLines", [])]
            by_source_line_id = {item["sourceLineId"]: item["cadObjectId"] for item in structural_lines}
            if len(by_source_line_id) != len(structural_lines):
                raise DrawingIRError(f"{view_id} contains duplicate source line ids")
            materials = self._material_records(view_id, view, by_source_line_id, entities)
            structural_count += len(structural_lines)
            crop_limit_count += len(crop_limit_lines)
            material_count += len(materials)
            for item in [*structural_lines, *crop_limit_lines, *materials]:
                sidecar_rows.append({"cadObjectId": item["cadObjectId"], "objectClass": item["objectClass"], "provenance": item["xdata"]})
            view_stages.append(
                {
                    **self.stages[view_id],
                    "sourceViewGeometrySha256": self.bindings[view_id]["viewGeometrySha256"],
                    "structuralLines": sorted(structural_lines, key=lambda item: (item["sourceLineId"], item["cadObjectId"])),
                    "cropLimitLines": sorted(crop_limit_lines, key=lambda item: (item["sourceLineId"], item["cadObjectId"])),
                    "materialRegions": materials,
                }
            )

        annotations = self._annotation_records()
        sidecar_rows.extend({"cadObjectId": item["cadObjectId"], "objectClass": item["objectClass"], "provenance": item["xdata"]} for item in annotations)
        payload = {
            "schemaVersion": "t0b-v2-drawing-package-ir-1",
            "status": "generated-not-qualified",
            "L1": False,
            "useBoundary": ["demo-only", "not-for-formal-signoff"],
            "generatedAt": self.contract["determinismPolicy"]["fixedTimestamp"],
            "drawingPackageContractSignature": self.contract["contractSignature"],
            "drawingPackageContractRevisionId": self.contract["contractRevisionId"],
            "geometryRevisionId": self.contract["geometryRevisionId"],
            "viewContractRevisionId": self.contract["viewContractRevisionId"],
            "manifestSha256": self.contract["manifestBinding"]["sha256"],
            "producerType": "demo",
            "modelSpace": {
                "unit": "mm",
                "insunits": 4,
                "scale": "1:1",
                "viewStages": view_stages,
            },
            "paperSpace": {"layouts": self.contract["layouts"]},
            "annotations": annotations,
            "detailGates": self.contract["detailGates"],
            "layerPolicy": self.contract["layerPolicy"],
            "nativeCadPolicy": self.contract["nativeCadPolicy"],
            "materialPolicy": self.contract["materialPolicy"],
            "fontPolicy": self.contract["fontPolicy"],
            "provenancePolicy": self.contract["provenancePolicy"],
            "provenanceSidecarRows": sorted(sidecar_rows, key=lambda item: item["cadObjectId"]),
            "futureOutputMatrix": self.contract["outputMatrix"],
            "compatibilityMatrix": self.contract["compatibilityMatrix"],
            "qualificationBoundary": self.contract["qualificationBoundary"],
            "determinismPolicy": self.contract["determinismPolicy"],
            "statistics": {
                "viewCount": len(view_stages),
                "layoutCount": len(self.contract["layouts"]),
                "structuralLineCount": structural_count,
                "cropLimitLineCount": crop_limit_count,
                "materialRegionCount": material_count,
                "annotationRequirementCount": len(annotations),
                "provenanceSidecarRowCount": len(sidecar_rows),
            },
        }
        payload["drawingPackageIrSha256"] = _canonical_hash(payload)
        return payload


def build_drawing_package_ir(contract_path: Path, output_dir: Path) -> dict:
    contract = load_drawing_package_contract(contract_path)
    generation_input = prepare_drawing_generation_input(contract)
    builder = DrawingPackageIRBuilder(generation_input, contract_path.parent)
    ir = builder.build()
    raw = (json.dumps(ir, ensure_ascii=False, sort_keys=True, separators=(",", ":")) + "\n").encode("utf-8")
    compressed = gzip.compress(raw, compresslevel=9, mtime=int(contract["determinismPolicy"]["gzipMtime"]))
    staging = output_dir.parent / f".{output_dir.name}.staging-{uuid4().hex}"
    staging.mkdir(parents=True, exist_ok=False)
    try:
        ir_name = "drawing-package.ir.json.gz"
        (staging / ir_name).write_bytes(compressed)
        record = {
            "schemaVersion": "t0b-v2-drawing-package-ir-build-1",
            "status": "generated-not-qualified",
            "L1": False,
            "generatedAt": contract["determinismPolicy"]["fixedTimestamp"],
            "drawingPackageContractRevisionId": contract["contractRevisionId"],
            "inputs": {
                "contract": {"path": contract_path.name, "sha256": _file_hash(contract_path), "contractSignature": contract["contractSignature"]},
                "manifest": contract["manifestBinding"],
                "viewGeometry": [{"viewId": item["viewId"], "fileSha256": item["fileSha256"], "viewGeometrySha256": item["viewGeometrySha256"]} for item in contract["viewGeometryBindings"]],
            },
            "output": {"path": ir_name, "sha256": _hash_bytes(compressed), "drawingPackageIrSha256": ir["drawingPackageIrSha256"], "statistics": ir["statistics"]},
            "outputsNotGenerated": ["DXF", "SVG", "PDF", "PNG"],
        }
        (staging / "drawing-package-ir-build-record.json").write_text(json.dumps(record, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
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
    parser = argparse.ArgumentParser(description="Build DrawingPackageIR without producing drawing files.")
    parser.add_argument("--contract", type=Path, required=True)
    parser.add_argument("--output-dir", type=Path, required=True)
    args = parser.parse_args()
    record = build_drawing_package_ir(args.contract, args.output_dir)
    print(json.dumps(record, ensure_ascii=False, indent=2))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
