from __future__ import annotations

import argparse
import gzip
from hashlib import sha256
import json
from pathlib import Path

import numpy as np
import trimesh

from .contracts import load_fixture
from .geometry import build_geometry, export_glb
from .verify_geometry import verify_geometry


def _file_hash(path: Path) -> str:
    digest = sha256()
    with path.open("rb") as stream:
        for chunk in iter(lambda: stream.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def _export_mesh_hash(mesh: trimesh.Trimesh) -> str:
    vertices = np.round(np.asarray(mesh.vertices, dtype=float), 9)
    vertex_records = sorted(tuple(float(value) for value in vertex) for vertex in vertices)
    triangle_records = []
    for face in np.asarray(mesh.faces, dtype=int):
        triangle_records.append(sorted(tuple(float(value) for value in vertices[index]) for index in face))
    payload = {"vertices": vertex_records, "triangles": sorted(triangle_records)}
    return sha256(json.dumps(payload, sort_keys=True, separators=(",", ":")).encode("utf-8")).hexdigest()


def _attach_export_hashes(manifest: dict, glb_path: Path) -> None:
    scene = trimesh.load(glb_path, force="scene")
    hashes = {entity_id: _export_mesh_hash(mesh) for entity_id, mesh in scene.geometry.items()}
    for entity in manifest["entities"]:
        entity["exportMeshHash"] = hashes[entity["entityId"]]
    payload = sorted((entity["entityId"], entity["exportMeshHash"]) for entity in manifest["entities"])
    manifest["exportClosureHash"] = sha256(json.dumps(payload, separators=(",", ":")).encode("utf-8")).hexdigest()


def _write_source_meshes(model, path: Path) -> None:
    lines = [
        json.dumps(
            {
                "recordType": "header",
                "schemaVersion": "t0b-v2-source-meshes-1",
                "unit": model.unit,
                "coordinateSystem": {"x": "east", "y": "north", "z": "up"},
                "geometryRevisionId": model.geometry_revision_id,
            },
            sort_keys=True,
            separators=(",", ":"),
        )
    ]
    for entity in sorted(model.entities, key=lambda item: item.entity_id):
        record = {
            "recordType": "mesh",
            "entityId": entity.entity_id,
            "vertices": np.asarray(entity.mesh.vertices, dtype=float).tolist(),
            "faces": np.asarray(entity.mesh.faces, dtype=int).tolist(),
        }
        lines.append(json.dumps(record, sort_keys=True, separators=(",", ":")))
    payload = ("\n".join(lines) + "\n").encode("utf-8")
    with path.open("wb") as stream:
        with gzip.GzipFile(filename="", mode="wb", fileobj=stream, mtime=0) as archive:
            archive.write(payload)


def _stable_fixture_path(path: Path) -> str:
    resolved = path.resolve()
    try:
        return resolved.relative_to(Path.cwd().resolve()).as_posix()
    except ValueError:
        return path.name


def build_outputs(fixture_path: Path, output_dir: Path) -> dict:
    fixture = load_fixture(fixture_path)
    model = build_geometry(fixture)
    manifest = model.manifest()
    if manifest["geometrySignature"] != fixture["knownAnswers"]["geometrySignature"]:
        raise ValueError("geometry signature differs from the frozen regression answer")
    output_dir.mkdir(parents=True, exist_ok=True)

    manifest_path = output_dir / "geometry-manifest.json"
    source_meshes_path = output_dir / "source-meshes.ndjson.gz"
    glb_path = output_dir / "resolved-local-assembly.glb"
    verification_path = output_dir / "geometry-verification.json"
    _write_source_meshes(model, source_meshes_path)
    if _file_hash(source_meshes_path) != fixture["knownAnswers"]["sourceMeshBundleSha256"]:
        raise ValueError("source mesh bundle differs from the frozen oriented topology hash")
    export_glb(model, glb_path)
    _attach_export_hashes(manifest, glb_path)
    manifest_path.write_text(json.dumps(manifest, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    verification = verify_geometry(fixture_path, manifest_path, source_meshes_path, glb_path)
    verification_path.write_text(json.dumps(verification, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")

    record = {
        "schemaVersion": "t0b-v2-geometry-build-1",
        "status": "generated-not-qualified",
        "fixturePath": _stable_fixture_path(fixture_path),
        "fixtureSha256": _file_hash(fixture_path),
        "geometryRevisionId": model.geometry_revision_id,
        "geometrySignature": manifest["geometrySignature"],
        "verificationStatus": verification["status"],
        "outputs": [
            {"path": manifest_path.name, "sha256": _file_hash(manifest_path)},
            {"path": source_meshes_path.name, "sha256": _file_hash(source_meshes_path)},
            {"path": glb_path.name, "sha256": _file_hash(glb_path)},
            {"path": verification_path.name, "sha256": _file_hash(verification_path)},
        ],
    }
    record_path = output_dir / "build-record.json"
    record_path.write_text(json.dumps(record, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    return record


def main() -> int:
    parser = argparse.ArgumentParser(description="Build the T0-B v2 semantic geometry proof.")
    parser.add_argument("--fixture", type=Path, required=True)
    parser.add_argument("--output-dir", type=Path, required=True)
    args = parser.parse_args()
    print(json.dumps(build_outputs(args.fixture, args.output_dir), ensure_ascii=False, indent=2))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
