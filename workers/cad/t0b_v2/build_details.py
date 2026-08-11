from __future__ import annotations

import argparse
import gzip
from hashlib import sha256
import json
import os
from pathlib import Path
import shutil
from uuid import uuid4, uuid5

from .build_sections import _canonical_mesh_hash, _file_hash, _hash_bytes
from .contracts import GEOMETRY_REVISION_NAMESPACE
from .view_geometry import DetailViewGenerator, ViewGeometryError, _guard_detail_generation_contract, load_source_meshes


DETAIL_VIEW_IDS = ("eaveDetail", "bracketDetail", "columnBaseDetail", "doorWindowDetail")


def _canonical_hash(value: dict) -> str:
    raw = json.dumps(value, ensure_ascii=False, sort_keys=True, separators=(",", ":")).encode("utf-8")
    return sha256(raw).hexdigest()


def _validate_source_closure(generation_contract: dict, manifest: dict, source_header: dict, meshes: dict) -> None:
    expected_header = {
        "recordType": "header",
        "schemaVersion": "t0b-v2-source-meshes-1",
        "unit": "mm",
        "coordinateSystem": {"x": "east", "y": "north", "z": "up"},
        "geometryRevisionId": generation_contract["geometryRevisionId"],
    }
    if source_header != expected_header:
        raise ViewGeometryError("source mesh header does not match the detail generation contract")
    if manifest.get("geometryRevisionId") != generation_contract["geometryRevisionId"]:
        raise ViewGeometryError("manifest geometry revision does not match the detail generation contract")
    if manifest.get("unit") != "mm" or manifest.get("producerType") != "demo":
        raise ViewGeometryError("manifest identity is outside the frozen demo boundary")
    sources = manifest.get("sourceRefs", [])
    if not sources or not all(isinstance(item, str) and item.startswith("demo:") for item in sources):
        raise ViewGeometryError("manifest source scheme is outside the frozen demo boundary")
    if any(".dwg" in item.lower() or "downloads" in item.lower() for item in sources):
        raise ViewGeometryError("external CAD references cannot enter detail generation")

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
    if geometry_signature != manifest.get("geometrySignature"):
        raise ViewGeometryError("manifest semantic geometry signature is invalid")
    if str(uuid5(GEOMETRY_REVISION_NAMESPACE, geometry_signature)) != generation_contract["geometryRevisionId"]:
        raise ViewGeometryError("manifest signature does not derive the frozen geometry revision")


def build_details(
    generation_contract: dict,
    manifest_path: Path,
    source_meshes_path: Path,
    output_dir: Path,
) -> dict:
    _guard_detail_generation_contract(generation_contract)
    manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
    source_header, meshes = load_source_meshes(source_meshes_path)
    _validate_source_closure(generation_contract, manifest, source_header, meshes)
    generator = DetailViewGenerator(generation_contract, manifest, meshes)
    staging = output_dir.parent / f".{output_dir.name}.staging-{uuid4().hex}"
    staging.mkdir(parents=True, exist_ok=False)
    outputs: list[dict] = []
    try:
        for view_id in DETAIL_VIEW_IDS:
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
            "schemaVersion": "t0b-v2-detail-build-1",
            "status": "generated-not-qualified",
            "qualification": "not-drawing-output",
            "L1": False,
            "geometryRevisionId": generation_contract["geometryRevisionId"],
            "viewContractRevisionId": generation_contract["viewContractRevisionId"],
            "inputs": {
                "generationContract": {"sha256": _canonical_hash(generation_contract)},
                "manifest": {"path": manifest_path.name, "sha256": _file_hash(manifest_path)},
                "sourceMeshes": {"path": source_meshes_path.name, "sha256": _file_hash(source_meshes_path)},
            },
            "outputs": outputs,
        }
        (staging / "detail-build-record.json").write_text(
            json.dumps(record, ensure_ascii=False, indent=2) + "\n", encoding="utf-8"
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
    parser = argparse.ArgumentParser(description="Generate detail ViewGeometry without reading frozen answers or producing drawings.")
    parser.add_argument("--generation-contract", type=Path, required=True)
    parser.add_argument("--manifest", type=Path, required=True)
    parser.add_argument("--source-meshes", type=Path, required=True)
    parser.add_argument("--output-dir", type=Path, required=True)
    args = parser.parse_args()
    generation_contract = json.loads(args.generation_contract.read_text(encoding="utf-8"))
    record = build_details(generation_contract, args.manifest, args.source_meshes, args.output_dir)
    print(json.dumps(record, ensure_ascii=False, indent=2))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
