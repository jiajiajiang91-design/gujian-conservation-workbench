from __future__ import annotations

import argparse
import gzip
from hashlib import sha256
import json
from pathlib import Path
import tempfile

import numpy as np

from .contracts import load_fixture
from .geometry import GeometryModel, build_geometry, export_glb


def _canonical(value: object) -> str:
    return json.dumps(value, ensure_ascii=False, sort_keys=True, separators=(",", ":"))


def _file_hash(path: Path) -> str:
    digest = sha256()
    with path.open("rb") as stream:
        for chunk in iter(lambda: stream.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def _source_mesh_payload(model: GeometryModel, manifest: dict) -> bytes:
    lines = [
        _canonical(
            {
                "recordType": "header",
                "schemaVersion": "t0b-v3-source-meshes-2",
                "unit": "mm",
                "coordinateSystem": model.fixture["coordinateSystem"],
                "geometryRevisionId": manifest["geometryRevisionId"],
                "geometrySignature": manifest["geometrySignature"],
                "entityCount": len(model.entities),
            }
        )
    ]
    for entity in sorted(model.entities, key=lambda item: item.entity_id):
        lines.append(
            _canonical(
                {
                    "recordType": "mesh",
                    "entityId": entity.entity_id,
                    "meshHash": entity.record()["meshHash"],
                    "vertices": np.round(np.asarray(entity.mesh.vertices, dtype=float), 9).tolist(),
                    "faces": np.asarray(entity.mesh.faces, dtype=int).tolist(),
                }
            )
        )
    return ("\n".join(lines) + "\n").encode("utf-8")


def _write_deterministic_gzip(payload: bytes, path: Path) -> None:
    with path.open("wb") as stream:
        with gzip.GzipFile(filename="", mode="wb", fileobj=stream, mtime=0) as archive:
            archive.write(payload)


def candidate_answers(fixture_path: Path) -> dict:
    fixture = load_fixture(fixture_path, allow_unfrozen=True)
    model = build_geometry(fixture)
    manifest = model.manifest()
    payload = _source_mesh_payload(model, manifest)
    with tempfile.TemporaryDirectory(prefix="gujian-t0b-v3-candidate-") as directory:
        bundle = Path(directory) / "source-meshes.ndjson.gz"
        _write_deterministic_gzip(payload, bundle)
        source_hash = _file_hash(bundle)
    return {
        "geometrySignature": manifest["geometrySignature"],
        "geometryRevisionId": manifest["geometryRevisionId"],
        "sourceMeshBundleSha256": source_hash,
        "entityCount": len(model.entities),
        "interfaceCount": len(model.interfaces),
    }


def build_outputs(fixture_path: Path, output_dir: Path) -> dict:
    fixture = load_fixture(fixture_path)
    model = build_geometry(fixture)
    manifest = model.manifest()
    known = fixture["knownAnswers"]
    if manifest["geometrySignature"] != known["geometrySignature"]:
        raise ValueError("geometry signature differs from the frozen answer")

    output_dir.mkdir(parents=True, exist_ok=True)
    manifest_path = output_dir / "geometry-manifest.json"
    source_path = output_dir / "source-meshes.ndjson.gz"
    glb_path = output_dir / "local-construction-sample.glb"
    record_path = output_dir / "build-record.json"

    _write_deterministic_gzip(_source_mesh_payload(model, manifest), source_path)
    if _file_hash(source_path) != known["sourceMeshBundleSha256"]:
        raise ValueError("source mesh bundle differs from the frozen answer")
    export_glb(model, str(glb_path))
    manifest_path.write_text(json.dumps(manifest, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")

    record = {
        "schemaVersion": "t0b-v3-geometry-build-2",
        "status": "generated-not-qualified",
        "qualification": {
            "passedGenerationOnly": True,
            "independentVerificationComplete": False,
            "technicalDemoRevalidationPassed": False,
            "localProfessionalSampleEligible": False,
            "L1": False,
        },
        "fixturePath": fixture_path.name,
        "fixtureSha256": _file_hash(fixture_path),
        "geometryRevisionId": manifest["geometryRevisionId"],
        "geometrySignature": manifest["geometrySignature"],
        "entityCount": len(model.entities),
        "interfaceCount": len(model.interfaces),
        "outputs": [
            {"path": manifest_path.name, "sha256": _file_hash(manifest_path)},
            {"path": source_path.name, "sha256": _file_hash(source_path)},
            {"path": glb_path.name, "sha256": _file_hash(glb_path)},
        ],
        "blockers": [
            "INDEPENDENT_GEOMETRY_VERIFICATION_REQUIRED",
            "VIEW_AND_DRAWING_REGENERATION_REQUIRED",
            "GENERIC_GEOMETRY_KERNEL_REQUIRED",
            "QCAD_LOSSLESS_ROUNDTRIP_UNSUPPORTED",
            "PROFESSIONAL_REVIEW_REQUIRED",
        ],
    }
    record_path.write_text(json.dumps(record, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    return record


def build_prefreeze_outputs(fixture_path: Path, output_dir: Path) -> dict:
    fixture = load_fixture(fixture_path, allow_unfrozen=True)
    if fixture["knownAnswers"]["geometrySignature"] != "UNFROZEN":
        raise ValueError("prefreeze output is only valid for an unfrozen fixture")
    model = build_geometry(fixture)
    manifest = model.manifest()
    output_dir.mkdir(parents=True, exist_ok=True)
    manifest_path = output_dir / "geometry-manifest.json"
    source_path = output_dir / "source-meshes.ndjson.gz"
    glb_path = output_dir / "local-construction-sample.glb"
    record_path = output_dir / "prefreeze-build-record.json"
    _write_deterministic_gzip(_source_mesh_payload(model, manifest), source_path)
    export_glb(model, str(glb_path))
    manifest_path.write_text(json.dumps(manifest, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    record = {
        "schemaVersion": "t0b-v3-prefreeze-build-2",
        "status": "prefreeze-generated-not-qualified",
        "qualification": {
            "passedGenerationOnly": True,
            "independentVerificationComplete": False,
            "localProfessionalSampleEligible": False,
            "L1": False,
        },
        "fixturePath": fixture_path.name,
        "fixtureSha256": _file_hash(fixture_path),
        "geometryRevisionId": manifest["geometryRevisionId"],
        "geometrySignature": manifest["geometrySignature"],
        "entityCount": len(model.entities),
        "interfaceCount": len(model.interfaces),
        "outputs": [
            {"path": manifest_path.name, "sha256": _file_hash(manifest_path)},
            {"path": source_path.name, "sha256": _file_hash(source_path)},
            {"path": glb_path.name, "sha256": _file_hash(glb_path)},
        ],
        "blockers": [
            "INDEPENDENT_GEOMETRY_VERIFICATION_REQUIRED",
            "PROFESSIONAL_REVIEW_REQUIRED",
            "GEOMETRY_REVISION_NOT_FROZEN",
            "VIEW_AND_DRAWING_REGENERATION_REQUIRED",
        ],
    }
    record_path.write_text(json.dumps(record, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    return record


def main() -> int:
    parser = argparse.ArgumentParser(description="Build the T0-B v3 local construction sample.")
    parser.add_argument("--fixture", type=Path, required=True)
    parser.add_argument("--output-dir", type=Path)
    parser.add_argument("--candidate-answers", action="store_true")
    parser.add_argument("--prefreeze", action="store_true")
    args = parser.parse_args()
    if args.candidate_answers:
        print(json.dumps(candidate_answers(args.fixture), ensure_ascii=False, indent=2))
        return 0
    if args.prefreeze:
        if args.output_dir is None:
            parser.error("--output-dir is required for --prefreeze")
        print(json.dumps(build_prefreeze_outputs(args.fixture, args.output_dir), ensure_ascii=False, indent=2))
        return 0
    if args.output_dir is None:
        parser.error("--output-dir is required unless --candidate-answers is used")
    print(json.dumps(build_outputs(args.fixture, args.output_dir), ensure_ascii=False, indent=2))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
