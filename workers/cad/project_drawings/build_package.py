from __future__ import annotations

import argparse
import gzip
import hashlib
import json
from pathlib import Path

from .contracts import canonical_bytes, sha256_value, validate_artifact_matrix
from .dxf_writer import NativeDxfWriter
from .sheet_writer import SheetArtifactWriter
from .view_geometry import build_drawing_ir, generate_view_geometry, load_source_meshes


def _hash(path: Path) -> str:
    return hashlib.sha256(path.read_bytes()).hexdigest()


def _write_json(path: Path, value: object) -> None:
    path.write_bytes(canonical_bytes(value) + b"\n")


def build_package(matrix_value: dict, geometry_dir: Path, font_path: Path, output_dir: Path) -> dict:
    manifest = json.loads((geometry_dir / "manifest.json").read_text(encoding="utf-8"))
    matrix = validate_artifact_matrix(matrix_value, manifest)
    output_dir.mkdir(parents=True, exist_ok=True)
    meshes = load_source_meshes(geometry_dir / "model.glb", manifest)
    views = [generate_view_geometry(view, manifest, meshes) for view in matrix["views"]]
    ir = build_drawing_ir(matrix, manifest, views)
    view_dir = output_dir / "view-geometry"
    view_dir.mkdir(exist_ok=True)
    for view in views:
        raw = canonical_bytes(view) + b"\n"
        # Transport names stay ASCII-safe; the Chinese drawing reference remains inside ViewGeometry.
        with (view_dir / f"{view['viewKey']}.json.gz").open("wb") as target:
            with gzip.GzipFile(filename="", mode="wb", fileobj=target, mtime=0) as stream:
                stream.write(raw)
    ir_path = output_dir / "drawing-ir.json"
    _write_json(ir_path, ir)
    dxf = NativeDxfWriter(ir, font_path.name).write(output_dir)
    sheets = SheetArtifactWriter(ir, font_path).write(output_dir)
    assets = [
        {"kind": "drawingIr", "fileName": ir_path.name, "mimeType": "application/json", "sha256": _hash(ir_path), "byteLength": ir_path.stat().st_size},
        {"kind": "dxf", "mimeType": "image/vnd.dxf", **dxf["dxf"]},
        {"kind": "sourceMap", "mimeType": "application/x-ndjson", **dxf["sourceMap"]},
        *sheets["assets"],
    ]
    for path in sorted(view_dir.glob("*.json.gz")):
        assets.append({"kind": "viewGeometry", "fileName": f"view-geometry/{path.name}", "mimeType": "application/gzip", "sha256": _hash(path), "byteLength": path.stat().st_size})
    record = {
        "schemaVersion": "1.0",
        "status": "generated-not-qualified",
        "qualification": "proxy-unissued",
        "l1Eligible": False,
        "formalEligibility": False,
        "projectId": matrix["projectId"],
        "projectRevisionId": matrix["projectRevisionId"],
        "geometryRevisionId": manifest["geometryRevisionId"],
        "artifactRequirementMatrixId": matrix["id"],
        "artifactRequirementMatrixSha256": sha256_value(matrix),
        "drawingIrSha256": ir["drawingIrSha256"],
        "viewCount": len(views), "sheetCount": len(matrix["sheets"]),
        "trackedCadObjectCount": dxf["trackedObjectCount"],
        "assets": sorted(assets, key=lambda item: (item["kind"], item["fileName"])),
        "blockers": ["PROFESSIONAL_REVIEW_REQUIRED", "FORMAL_SIGNOFF_UNAVAILABLE"],
    }
    record_path = output_dir / "drawing-build-record.json"
    _write_json(record_path, record)
    return record


def main() -> int:
    parser = argparse.ArgumentParser(description="Build task-driven drawings from one GeometryRevision.")
    parser.add_argument("--matrix", required=True, type=Path)
    parser.add_argument("--geometry-dir", required=True, type=Path)
    parser.add_argument("--font", required=True, type=Path)
    parser.add_argument("--output", required=True, type=Path)
    args = parser.parse_args()
    matrix = json.loads(args.matrix.read_text(encoding="utf-8"))
    record = build_package(matrix, args.geometry_dir, args.font, args.output)
    print(json.dumps({"status": "succeeded", "geometryRevisionId": record["geometryRevisionId"], "viewCount": record["viewCount"], "sheetCount": record["sheetCount"]}, ensure_ascii=False, sort_keys=True))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
