from __future__ import annotations

import argparse
from hashlib import sha256
import json
from pathlib import Path
import sys
import xml.etree.ElementTree as ET

import ezdxf
import ifcopenshell
import ifcopenshell.geom
import numpy as np
import trimesh

from t0_model import build_objects, load_spec, spec_hash


REQUIRED_FILES = (
    "geometry.json",
    "t0-minimal-hall.ifc",
    "t0-minimal-hall.glb",
    "t0-multiview-sheet.dxf",
    "t0-multiview-sheet.svg",
    "t0-multiview-sheet.pdf",
)


def _hash_file(path: Path) -> str:
    digest = sha256()
    with path.open("rb") as stream:
        for chunk in iter(lambda: stream.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


class Checks:
    def __init__(self) -> None:
        self.items: list[dict] = []

    def add(self, name: str, passed: bool, evidence: object) -> None:
        self.items.append({"name": name, "passed": bool(passed), "evidence": evidence})

    def require(self, name: str, condition: bool, evidence: object) -> None:
        self.add(name, condition, evidence)
        if not condition:
            raise AssertionError(f"{name}: {evidence}")


def verify(spec_path: Path, output: Path, compare_manifest: Path | None = None) -> dict:
    spec = load_spec(spec_path)
    objects = build_objects(spec)
    expected_ids = {item.entity_id for item in objects}
    checks = Checks()

    manifest_path = output / "manifest.json"
    checks.require("manifest exists", manifest_path.is_file(), str(manifest_path))
    manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
    checks.require("spec hash matches", manifest["specHash"] == spec_hash(spec), manifest["specHash"])
    checks.require("demo provenance retained", manifest["producerType"] == "demo", manifest["producerType"])
    checks.require(
        "L0 technical-only classification retained",
        manifest.get("gate") == "T0-A"
        and manifest.get("qualityLevel") == "L0"
        and manifest.get("professionalQualityEligible") is False,
        {
            "gate": manifest.get("gate"),
            "qualityLevel": manifest.get("qualityLevel"),
            "professionalQualityEligible": manifest.get("professionalQualityEligible"),
        },
    )
    checks.require("object count matches", manifest["objectCount"] == len(objects), manifest["objectCount"])
    checks.require("all output files exist", all((output / name).is_file() for name in REQUIRED_FILES), list(REQUIRED_FILES))

    artifact_results = []
    for artifact in manifest["artifacts"]:
        path = output / artifact["path"]
        actual_hash = _hash_file(path)
        artifact_results.append({"path": artifact["path"], "expected": artifact["sha256"], "actual": actual_hash})
        checks.require(f"artifact hash {artifact['path']}", actual_hash == artifact["sha256"], artifact_results[-1])

    ifc_path = output / "t0-minimal-hall.ifc"
    model = ifcopenshell.open(str(ifc_path))
    products = [product for product in model.by_type("IfcElement") if product.Representation]
    ifc_ids = {product.Tag for product in products}
    ifc_guids = [product.GlobalId for product in products]
    checks.require("IFC stable entity IDs", ifc_ids == expected_ids, {"expected": len(expected_ids), "actual": len(ifc_ids)})
    checks.require("IFC GUIDs unique", len(ifc_guids) == len(set(ifc_guids)), len(ifc_guids))
    checks.require("IFC source property sets", len(model.by_type("IfcPropertySet")) == len(objects), len(model.by_type("IfcPropertySet")))
    settings = ifcopenshell.geom.settings()
    settings.set(settings.USE_WORLD_COORDS, True)
    ifc_vertices = 0
    ifc_faces = 0
    for product in products:
        shape = ifcopenshell.geom.create_shape(settings, product)
        ifc_vertices += len(shape.geometry.verts) // 3
        ifc_faces += len(shape.geometry.faces) // 3
    checks.require("IfcOpenShell geometry created", ifc_vertices > 0 and ifc_faces > 0, {"vertices": ifc_vertices, "faces": ifc_faces})

    glb = trimesh.load(output / "t0-minimal-hall.glb", force="scene")
    glb_bounds = np.asarray(glb.bounds, dtype=float)
    checks.require("GLB geometry count", len(glb.geometry) == len(objects), len(glb.geometry))
    checks.require("GLB finite bounds", glb_bounds.shape == (2, 3) and np.isfinite(glb_bounds).all(), glb_bounds.tolist())
    checks.require("GLB building dimensions", glb_bounds[1, 0] - glb_bounds[0, 0] > 11.0 and glb_bounds[1, 2] > 6.0, glb_bounds.tolist())

    dxf = ezdxf.readfile(output / "t0-multiview-sheet.dxf")
    auditor = dxf.audit()
    checks.require("DXF audit clean", len(auditor.errors) == 0, [str(error) for error in auditor.errors])
    required_layers = {"A-WALL", "A-COLS", "A-BEAM", "A-OPEN", "A-ROOF", "A-GRID", "A-DIMS", "A-TEXT", "A-TITLE"}
    actual_layers = {layer.dxf.name for layer in dxf.layers}
    checks.require("DXF professional layers", required_layers <= actual_layers, sorted(required_layers - actual_layers))
    msp = dxf.modelspace()
    dimensions = len(msp.query("DIMENSION"))
    checks.require("DXF dimensions", dimensions >= len(spec["bays"]) + 3, dimensions)
    checks.require("DXF A1 layout", "A1-T0" in dxf.layouts.names(), dxf.layouts.names())
    viewport_count = len(dxf.layouts.get("A1-T0").query("VIEWPORT"))
    checks.require("DXF plan elevation section viewports", viewport_count >= 3, viewport_count)
    xdata_count = 0
    xdata_ids: set[str] = set()
    for entity in msp:
        if entity.has_xdata("GUJIAN"):
            xdata_count += 1
            tags = entity.get_xdata("GUJIAN")
            if tags:
                xdata_ids.add(str(tags[0].value))
    checks.require("DXF source references", xdata_ids == expected_ids, {"entities": xdata_count, "uniqueIds": len(xdata_ids), "missing": sorted(expected_ids - xdata_ids)})

    svg_root = ET.parse(output / "t0-multiview-sheet.svg").getroot()
    svg_ns = {"svg": "http://www.w3.org/2000/svg"}
    svg_geometry_count = sum(len(svg_root.findall(f".//svg:{name}", svg_ns)) for name in ("line", "rect", "polyline"))
    svg_text = " ".join(element.text or "" for element in svg_root.findall(".//svg:text", svg_ns))
    checks.require("SVG vector geometry", svg_geometry_count >= 40, svg_geometry_count)
    checks.require("SVG Chinese labels", "首层平面" in svg_text and "南立面" in svg_text and "剖面" in svg_text, svg_text)

    pdf_bytes = (output / "t0-multiview-sheet.pdf").read_bytes()
    checks.require("PDF header and EOF", pdf_bytes.startswith(b"%PDF-") and b"%%EOF" in pdf_bytes[-2048:], len(pdf_bytes))
    checks.require("PDF nontrivial size", len(pdf_bytes) > 10_000, len(pdf_bytes))

    if compare_manifest:
        comparison = json.loads(compare_manifest.read_text(encoding="utf-8"))
        checks.require("stable entity map across runs", comparison["entityMap"] == manifest["entityMap"], len(manifest["entityMap"]))

    return {
        "schemaVersion": "t0-verification-1",
        "status": "passed",
        "gate": "T0-A",
        "qualityLevel": "L0",
        "professionalQualityEligible": False,
        "specHash": spec_hash(spec),
        "summary": {
            "checks": len(checks.items),
            "objects": len(objects),
            "ifcVertices": ifc_vertices,
            "ifcFaces": ifc_faces,
            "dxfDimensions": dimensions,
            "dxfSourceReferences": xdata_count,
        },
        "checks": checks.items,
    }


def main() -> int:
    parser = argparse.ArgumentParser(description="Verify all T0 CAD artifacts")
    parser.add_argument("--spec", type=Path, required=True)
    parser.add_argument("--output", type=Path, required=True)
    parser.add_argument("--compare-manifest", type=Path)
    parser.add_argument("--report", type=Path)
    args = parser.parse_args()
    try:
        result = verify(args.spec, args.output, args.compare_manifest)
        if args.report:
            args.report.parent.mkdir(parents=True, exist_ok=True)
            args.report.write_text(json.dumps(result, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
        print(json.dumps({"status": result["status"], **result["summary"]}, ensure_ascii=False))
        return 0
    except Exception as exc:
        print(json.dumps({"status": "failed", "type": exc.__class__.__name__, "reason": str(exc)}, ensure_ascii=False), file=sys.stderr)
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
