from __future__ import annotations

import argparse
import gzip
from hashlib import sha256
import json
import os
from pathlib import Path
import shutil
from uuid import uuid4

import numpy as np

from .contracts import load_fixture, prepare_view_generation_input
from .view_geometry import SectionViewGenerator, ViewGeometryError, load_source_meshes


SECTION_VIEW_IDS = ("floorPlan", "transverseSection", "longitudinalSection")


def _hash_bytes(payload: bytes) -> str:
    return sha256(payload).hexdigest()


def _file_hash(path: Path) -> str:
    digest = sha256()
    with path.open("rb") as stream:
        for chunk in iter(lambda: stream.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def _canonical_mesh_hash(mesh, precision: int = 3) -> str:
    vertices = np.round(np.asarray(mesh.vertices, dtype=float), precision)
    vertex_records = sorted(tuple(float(value) for value in vertex) for vertex in vertices)
    triangles = sorted(
        sorted(tuple(float(value) for value in vertices[index]) for index in face)
        for face in np.asarray(mesh.faces, dtype=int)
    )
    payload = {"vertices": vertex_records, "triangles": triangles}
    return sha256(json.dumps(payload, sort_keys=True, separators=(",", ":")).encode("utf-8")).hexdigest()


def _validate_source_closure(fixture: dict, manifest: dict, source_header: dict, meshes: dict) -> None:
    expected_header = {
        "recordType": "header",
        "schemaVersion": "t0b-v2-source-meshes-1",
        "unit": fixture["unit"],
        "coordinateSystem": fixture["coordinateSystem"],
        "geometryRevisionId": fixture["geometryRevisionId"],
    }
    if source_header != expected_header:
        raise ViewGeometryError("source mesh header does not match the frozen fixture")
    expected_manifest_identity = {
        "schemaVersion": "t0b-v2-geometry-1",
        "projectId": fixture["projectId"],
        "fixtureId": fixture["fixtureId"],
        "geometryRevisionId": fixture["geometryRevisionId"],
        "unit": fixture["unit"],
        "producerType": fixture["producerType"],
        "sourceRefs": fixture["sourceRefs"],
    }
    if any(manifest.get(key) != value for key, value in expected_manifest_identity.items()):
        raise ViewGeometryError("manifest identity differs from the frozen fixture")
    entities = manifest.get("entities", [])
    entity_ids = [entity.get("entityId") for entity in entities]
    if len(entity_ids) != len(set(entity_ids)) or set(entity_ids) != set(meshes):
        raise ViewGeometryError("manifest and source mesh entity closures differ")
    for entity in entities:
        entity_id = entity["entityId"]
        mesh = meshes[entity_id]
        if entity.get("meshHashPrecisionMm") != 0.001 or _canonical_mesh_hash(mesh) != entity.get("meshHash"):
            raise ViewGeometryError(f"source mesh hash differs from the manifest for {entity_id}")
        if int(entity.get("vertices", -1)) != len(mesh.vertices) or int(entity.get("faces", -1)) != len(mesh.faces):
            raise ViewGeometryError(f"source mesh topology differs from the manifest for {entity_id}")
    closure_payload = sorted((entity["entityId"], entity.get("exportMeshHash")) for entity in entities)
    closure_hash = sha256(json.dumps(closure_payload, separators=(",", ":")).encode("utf-8")).hexdigest()
    if closure_hash != manifest.get("exportClosureHash"):
        raise ViewGeometryError("manifest export closure hash is invalid")
    signature_entities = []
    for entity in sorted(entities, key=lambda item: item["entityId"]):
        record = dict(entity)
        record.pop("exportMeshHash", None)
        signature_entities.append(record)
    signature_relations = sorted(
        manifest.get("relations", []),
        key=lambda item: (item.get("fromEntityId"), item.get("relation"), item.get("toEntityId")),
    )
    geometry_signature = sha256(
        json.dumps(
            {"entities": signature_entities, "relations": signature_relations},
            sort_keys=True,
            separators=(",", ":"),
        ).encode("utf-8")
    ).hexdigest()
    if geometry_signature != manifest.get("geometrySignature") or geometry_signature != fixture["knownAnswers"]["geometrySignature"]:
        raise ViewGeometryError("manifest semantic geometry signature is invalid")


def build_sections(fixture_path: Path, manifest_path: Path, source_meshes_path: Path, output_dir: Path) -> dict:
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

    generator = SectionViewGenerator(generation_contract, manifest, meshes)
    staging = output_dir.parent / f".{output_dir.name}.staging-{uuid4().hex}"
    staging.mkdir(parents=True, exist_ok=False)
    outputs: list[dict] = []
    try:
        for view_id in SECTION_VIEW_IDS:
            result = generator.generate(view_id)
            raw = (json.dumps(result, ensure_ascii=False, sort_keys=True, separators=(",", ":")) + "\n").encode("utf-8")
            compressed = gzip.compress(raw, compresslevel=9, mtime=0)
            filename = f"{view_id}.view-geometry.json.gz"
            path = staging / filename
            path.write_bytes(compressed)
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
            "schemaVersion": "t0b-v2-section-build-1",
            "status": "generated-not-qualified",
            "qualification": "not-drawing-output",
            "geometryRevisionId": generation_contract["geometryRevisionId"],
            "viewContractRevisionId": generation_contract["viewContractRevisionId"],
            "inputs": {
                "fixture": {"path": fixture_path.name, "sha256": _file_hash(fixture_path)},
                "manifest": {"path": manifest_path.name, "sha256": _file_hash(manifest_path)},
                "sourceMeshes": {"path": source_meshes_path.name, "sha256": _file_hash(source_meshes_path)},
            },
            "outputs": outputs,
        }
        (staging / "section-build-record.json").write_text(
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
    parser = argparse.ArgumentParser(description="Generate true section ViewGeometry without producing drawings.")
    parser.add_argument("--fixture", type=Path, required=True)
    parser.add_argument("--manifest", type=Path, required=True)
    parser.add_argument("--source-meshes", type=Path, required=True)
    parser.add_argument("--output-dir", type=Path, required=True)
    args = parser.parse_args()
    record = build_sections(args.fixture, args.manifest, args.source_meshes, args.output_dir)
    print(json.dumps(record, ensure_ascii=False, indent=2))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
