from __future__ import annotations

import argparse
import hashlib
import json
from pathlib import Path
from typing import Any

import cadquery  # Import first: CadQuery and IfcOpenShell share OpenCascade on Windows.
import ifcopenshell
import numpy as np
import trimesh

from .contracts import canonical_bytes, geometry_spec_input_hash, sha256_bytes, validate_geometry_spec


def _mesh_hash(vertices: np.ndarray, faces: np.ndarray) -> str:
    rounded = np.round(vertices, 3)
    canonical_faces = []
    for face in faces.astype(np.int64):
        points = [tuple(float(value) for value in rounded[index]) for index in face]
        rotations = [points[offset:] + points[:offset] for offset in range(3)]
        canonical_faces.append(min(rotations))
    return sha256_bytes(canonical_bytes(sorted(canonical_faces)))


def verify_geometry_package(spec_value: dict[str, Any], output_dir: Path) -> dict[str, Any]:
    spec = validate_geometry_spec(spec_value)
    manifest_path = output_dir / "manifest.json"
    manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
    failures: list[str] = []
    if manifest.get("inputHash") != geometry_spec_input_hash(spec):
        failures.append("input hash mismatch")
    if manifest.get("projectRevisionId") != spec["projectRevisionId"] or manifest.get("geometrySpecId") != spec["id"]:
        failures.append("project or spec revision mismatch")
    asset_by_kind = {item["kind"]: item for item in manifest.get("assets", [])}
    for kind in ("ifc", "glb", "sourceMap", "report", "preview"):
        record = asset_by_kind.get(kind)
        if not record:
            failures.append(f"missing asset record: {kind}")
            continue
        path = output_dir / record["fileName"]
        if not path.is_file() or hashlib.sha256(path.read_bytes()).hexdigest() != record["sha256"] or path.stat().st_size != record["byteLength"]:
            failures.append(f"asset hash mismatch: {kind}")

    source_records = [json.loads(line) for line in (output_dir / "source-map.ndjson").read_text(encoding="utf-8").splitlines() if line]
    source_by_id = {item["id"]: item for item in source_records}
    object_ids = {item["id"] for item in spec["objects"]}
    if set(source_by_id) != object_ids or len(source_by_id) != len(source_records):
        failures.append("source map entity closure mismatch")

    scene = trimesh.load(output_dir / "model.glb", force="scene", process=False)
    if set(scene.geometry) != object_ids:
        failures.append("GLB entity closure mismatch")
    else:
        for entity_id, mesh in scene.geometry.items():
            glb_vertices = np.asarray(mesh.vertices)
            source_vertices = np.column_stack((glb_vertices[:, 0], -glb_vertices[:, 2], glb_vertices[:, 1])) * 1000.0
            actual = _mesh_hash(source_vertices, np.asarray(mesh.faces))
            if actual != source_by_id[entity_id]["meshHash"]:
                failures.append(f"GLB mesh mismatch: {entity_id}")

    ifc = ifcopenshell.open(output_dir / "model.ifc")
    ifc_ids = {str(item.Name) for item in ifc.by_type("IfcBuildingElementProxy")}
    if ifc_ids != object_ids:
        failures.append("IFC entity closure mismatch")
    report = json.loads((output_dir / "geometry-report.json").read_text(encoding="utf-8"))
    if report.get("geometryRevisionId") != manifest.get("geometryRevisionId") or report.get("geometrySignature") != manifest.get("geometrySignature"):
        failures.append("report revision closure mismatch")
    if report.get("qualification") != "generated-not-qualified" or report.get("l1Eligible") is not False or report.get("formalEligibility") is not False:
        failures.append("qualification boundary changed")
    if any(item.get("passed") is not True for item in manifest.get("interfaces", [])):
        failures.append("interface technical check failed")
    return {
        "schemaVersion": "1.0", "status": "passed-project-geometry-technical-only" if not failures else "failed",
        "qualification": "generated-not-qualified", "l1Eligible": False, "formalEligibility": False,
        "geometryRevisionId": manifest.get("geometryRevisionId"), "inputHash": geometry_spec_input_hash(spec),
        "entityCount": len(object_ids), "interfaceCount": len(spec["interfaces"]),
        "checks": 8, "failedChecks": len(failures), "failures": failures,
    }


def main() -> int:
    parser = argparse.ArgumentParser(description="Verify one project-driven geometry package.")
    parser.add_argument("--spec", required=True, type=Path)
    parser.add_argument("--output", required=True, type=Path)
    parser.add_argument("--report", type=Path)
    args = parser.parse_args()
    source = json.loads(args.spec.read_text(encoding="utf-8"))
    report = verify_geometry_package(source, args.output)
    encoded = json.dumps(report, ensure_ascii=False, indent=2, sort_keys=True) + "\n"
    if args.report:
        args.report.parent.mkdir(parents=True, exist_ok=True)
        args.report.write_text(encoded, encoding="utf-8")
    print(encoded, end="")
    return 0 if report["failedChecks"] == 0 else 1


if __name__ == "__main__":
    raise SystemExit(main())
