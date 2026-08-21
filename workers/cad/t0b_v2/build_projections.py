from __future__ import annotations

import argparse
import gzip
from hashlib import sha256
import json
import os
from pathlib import Path
import shutil
from uuid import uuid4

from .build_sections import _file_hash, _hash_bytes, _validate_source_closure
from .contracts import load_fixture, prepare_view_generation_input
from .view_geometry import ProjectionViewGenerator, ViewGeometryError, load_source_meshes


PROJECTION_VIEW_IDS = ("roofPlan", "southElevation", "axonometric")


def _canonical_hash(value: dict) -> str:
    raw = json.dumps(value, ensure_ascii=False, sort_keys=True, separators=(",", ":")).encode("utf-8")
    return sha256(raw).hexdigest()


def build_projections(fixture_path: Path, manifest_path: Path, source_meshes_path: Path, output_dir: Path) -> dict:
    fixture = load_fixture(fixture_path)
    if _file_hash(source_meshes_path) != fixture["knownAnswers"]["sourceMeshBundleSha256"]:
        raise ViewGeometryError("source mesh bundle differs from the frozen oriented topology hash")
    generation_contract = prepare_view_generation_input(fixture)
    manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
    source_header, meshes = load_source_meshes(source_meshes_path)
    if manifest.get("geometryRevisionId") != generation_contract["geometryRevisionId"]:
        raise ViewGeometryError("manifest geometry revision does not match the view contract")
    if source_header.get("geometryRevisionId") != generation_contract["geometryRevisionId"]:
        raise ViewGeometryError("source mesh geometry revision does not match the view contract")
    _validate_source_closure(fixture, manifest, source_header, meshes)

    generator = ProjectionViewGenerator(generation_contract, manifest, meshes)
    staging = output_dir.parent / f".{output_dir.name}.staging-{uuid4().hex}"
    staging.mkdir(parents=True, exist_ok=False)
    outputs: list[dict] = []
    try:
        for view_id in PROJECTION_VIEW_IDS:
            result = generator.generate(view_id)
            raw = (json.dumps(result, ensure_ascii=False, sort_keys=True, separators=(",", ":")) + "\n").encode("utf-8")
            compressed = gzip.compress(raw, compresslevel=9, mtime=0)
            filename = f"{view_id}.view-geometry.json.gz"
            (staging / filename).write_bytes(compressed)
            outputs.append(
                {
                    "viewId": view_id,
                    "path": filename,
                    "sha256": _hash_bytes(compressed),
                    "viewGeometrySha256": result["viewGeometrySha256"],
                    "statistics": result["statistics"],
                }
            )
        record = {
            "schemaVersion": "t0b-v2-projection-build-1",
            "status": "generated-not-qualified",
            "qualification": "not-drawing-output",
            "geometryRevisionId": generation_contract["geometryRevisionId"],
            "viewContractRevisionId": generation_contract["viewContractRevisionId"],
            "inputs": {
                "fixture": {"path": fixture_path.name, "sha256": _file_hash(fixture_path)},
                "generationContract": {"sha256": _canonical_hash(generation_contract)},
                "manifest": {"path": manifest_path.name, "sha256": _file_hash(manifest_path)},
                "sourceMeshes": {"path": source_meshes_path.name, "sha256": _file_hash(source_meshes_path)},
            },
            "outputs": outputs,
        }
        (staging / "projection-build-record.json").write_text(
            json.dumps(record, ensure_ascii=False, indent=2) + "\n",
            encoding="utf-8",
        )
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
    parser = argparse.ArgumentParser(description="Generate visible-line projection ViewGeometry without producing drawings.")
    parser.add_argument("--fixture", type=Path, required=True)
    parser.add_argument("--manifest", type=Path, required=True)
    parser.add_argument("--source-meshes", type=Path, required=True)
    parser.add_argument("--output-dir", type=Path, required=True)
    args = parser.parse_args()
    record = build_projections(args.fixture, args.manifest, args.source_meshes, args.output_dir)
    print(json.dumps(record, ensure_ascii=False, indent=2))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
