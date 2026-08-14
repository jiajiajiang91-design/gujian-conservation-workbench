from __future__ import annotations

import hashlib
import json
import tempfile
import unittest
from pathlib import Path

import trimesh

from .kernel import build_geometry_package
from .test_project_geometry import spec_a
from .verify_job import verify_geometry_package


class ProjectGeometryVerifierTests(unittest.TestCase):
    def test_independent_verifier_accepts_complete_package(self) -> None:
        with tempfile.TemporaryDirectory() as temp:
            output = Path(temp) / "output"
            source = spec_a()
            build_geometry_package(source, output)
            report = verify_geometry_package(source, output)
            self.assertEqual(report["failedChecks"], 0)
            self.assertFalse(report["l1Eligible"])

    def test_verifier_rejects_glb_source_and_qualification_tampering(self) -> None:
        with tempfile.TemporaryDirectory() as temp:
            source = spec_a()
            for mutation in ("glb", "glb-geometry", "brep", "source", "qualification"):
                output = Path(temp) / mutation
                build_geometry_package(source, output)
                if mutation == "glb":
                    path = output / "model.glb"
                    path.write_bytes(path.read_bytes() + b"forged")
                elif mutation == "glb-geometry":
                    path = output / "model.glb"
                    scene = trimesh.load(path, force="scene", process=False)
                    mesh = scene.geometry[sorted(scene.geometry)[0]]
                    mesh.vertices[0, 0] += 0.01
                    path.write_bytes(scene.export(file_type="glb"))
                    manifest_path = output / "manifest.json"
                    manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
                    asset = next(item for item in manifest["assets"] if item["kind"] == "glb")
                    asset["sha256"] = hashlib.sha256(path.read_bytes()).hexdigest()
                    asset["byteLength"] = path.stat().st_size
                    manifest_path.write_text(json.dumps(manifest, ensure_ascii=False, sort_keys=True), encoding="utf-8")
                elif mutation == "brep":
                    path = output / "model-brep.zip"
                    path.write_bytes(path.read_bytes() + b"forged")
                elif mutation == "source":
                    path = output / "source-map.ndjson"
                    records = path.read_text(encoding="utf-8").splitlines()
                    value = json.loads(records[0])
                    value["meshHash"] = "0" * 64
                    records[0] = json.dumps(value, ensure_ascii=False, sort_keys=True)
                    path.write_text("\n".join(records) + "\n", encoding="utf-8")
                else:
                    path = output / "geometry-report.json"
                    value = json.loads(path.read_text(encoding="utf-8"))
                    value["l1Eligible"] = True
                    path.write_text(json.dumps(value), encoding="utf-8")
                self.assertGreater(verify_geometry_package(source, output)["failedChecks"], 0, mutation)


if __name__ == "__main__":
    unittest.main()
