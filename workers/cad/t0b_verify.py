from __future__ import annotations

import argparse
from hashlib import sha256
import json
from pathlib import Path
import sys

import ezdxf
import numpy as np
import trimesh

from t0_model import spec_hash
from t0b_generate import load_spec, roof_z


REQUIRED_CATEGORIES = {
    "terrace", "foundation", "column", "beam", "bracket", "purlin", "rafter",
    "roofSurface", "tiles", "ridge", "eave", "door", "latticeWindow",
}
REQUIRED_LAYERS = {
    "A-AXIS", "A-CUT", "A-OUTLINE", "A-PROJ", "A-DIM", "A-TEXT", "A-HATCH",
    "A-EXIST", "A-DAMAGE", "A-REPAIR", "A-ROOF", "A-TIMBER", "A-OPEN",
}
REQUIRED_FILES = {
    "geometry.json", "t0b-l0plus-demo-hall.glb", "t0b-l0plus-demo-sheet.dxf",
    "t0b-l0plus-demo-sheet.svg", "t0b-l0plus-demo-sheet.pdf",
}


def _hash_file(path: Path) -> str:
    digest = sha256()
    with path.open("rb") as stream:
        for chunk in iter(lambda: stream.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


class Checks:
    def __init__(self) -> None:
        self.items: list[dict] = []

    def require(self, name: str, condition: bool, evidence) -> None:
        self.items.append({"name": name, "passed": bool(condition), "evidence": evidence})
        if not condition:
            raise AssertionError(f"{name}: {evidence}")


def verify(spec_path: Path, output: Path, compare_manifest: Path | None = None) -> dict:
    spec = load_spec(spec_path)
    checks = Checks()
    manifest_path = output / "manifest.json"
    checks.require("manifest exists", manifest_path.is_file(), str(manifest_path))
    manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
    checks.require("spec hash matches", manifest["specHash"] == spec_hash(spec), manifest["specHash"])
    checks.require(
        "revoked T0-B classification retained",
        manifest.get("gate") == "T0-B"
        and manifest.get("qualityLevel") == "L0+"
        and manifest.get("localProfessionalSampleEligible") is False
        and manifest.get("t0GateEligible") is False
        and manifest.get("geometryDerivation") == "independent-3d-and-2d"
        and manifest.get("professionalDeliverableEligible") is False
        and manifest.get("formalEligibility") is False,
        {
            key: manifest.get(key)
            for key in (
                "gate",
                "qualityLevel",
                "localProfessionalSampleEligible",
                "t0GateEligible",
                "geometryDerivation",
                "professionalDeliverableEligible",
                "formalEligibility",
            )
        },
    )
    checks.require("demo provenance retained", manifest["producerType"] == "demo", manifest["producerType"])
    categories = set(manifest["glb"]["categories"])
    checks.require("declared technical categories present", REQUIRED_CATEGORIES <= categories, sorted(categories))
    checks.require("all artifacts exist", all((output / name).is_file() for name in REQUIRED_FILES), sorted(REQUIRED_FILES))

    for artifact in manifest["artifacts"]:
        path = output / artifact["path"]
        actual = _hash_file(path)
        checks.require(f"artifact hash {artifact['path']}", actual == artifact["sha256"], {"expected": artifact["sha256"], "actual": actual})

    geometry = json.loads((output / "geometry.json").read_text(encoding="utf-8"))
    checks.require("geometry object count", len(geometry["objects"]) == manifest["objectCount"], len(geometry["objects"]))
    checks.require("stable entity IDs unique", len({item["entityId"] for item in geometry["objects"]}) == len(geometry["objects"]), len(geometry["objects"]))
    checks.require("all geometry objects cite source", all(item["sourceRefs"] == spec["sourceRefs"] for item in geometry["objects"]), spec["sourceRefs"])
    checks.require("four technical views are present", set(geometry["views"]) == {"frontElevation", "transverseSection", "eaveDetail", "roofPlan"}, sorted(geometry["views"]))
    view_counts = {name: len(items) for name, items in geometry["views"].items()}
    checks.require("independent view derivation is disclosed", geometry.get("geometryDerivation") == "independent-3d-and-2d", geometry.get("geometryDerivation"))

    roof = spec["roof"]
    roof_half_y = sum(float(v) for v in spec["depthSpans"]) / 2 + float(roof["overhangY"])
    ridge = roof_z(spec, 0, 0)
    middle = roof_z(spec, 0, -roof_half_y / 2)
    eave = roof_z(spec, 0, -roof_half_y)
    curvature = middle - (ridge + eave) / 2
    checks.require("roof profile is curved, not two flat planes", curvature > 400, {"ridge": ridge, "middle": middle, "eave": eave, "deviation": curvature})

    scene = trimesh.load(output / "t0b-l0plus-demo-hall.glb", force="scene")
    bounds = np.array(scene.bounds, dtype=float)
    extents = bounds[1] - bounds[0]
    checks.require("GLB semantic mesh count", len(scene.geometry) == manifest["objectCount"], len(scene.geometry))
    checks.require("GLB finite geometry", bool(np.isfinite(bounds).all()), bounds.tolist())
    checks.require("GLB Y-up height and building extents", extents[1] > 9 and extents[0] > 14 and extents[2] > 10, extents.tolist())

    dxf = ezdxf.readfile(output / "t0b-l0plus-demo-sheet.dxf")
    auditor = dxf.audit()
    checks.require("DXF audit clean", not auditor.errors, [str(error) for error in auditor.errors])
    layers = {layer.dxf.name for layer in dxf.layers}
    checks.require("technical layer set", REQUIRED_LAYERS <= layers, sorted(layers))
    msp = dxf.modelspace()
    dimensions = len(msp.query("DIMENSION"))
    hatches = len(msp.query("HATCH"))
    inserts = [item for item in msp.query("INSERT") if not item.dxf.name.startswith("*")]
    text_count = len(msp.query("TEXT MTEXT"))
    checks.require("editable CAD dimensions", dimensions >= 9, dimensions)
    checks.require("editable CAD hatches", hatches >= 4, hatches)
    checks.require("reusable CAD blocks", len(inserts) >= 10 and "BRACKET" in dxf.blocks, {"inserts": len(inserts), "blocks": [block.name for block in dxf.blocks]})
    checks.require("CAD notes and labels", text_count >= 20, text_count)
    checks.require("A1 paper-space layout", "A1-T0B" in dxf.layouts.names() and len(dxf.layouts.get("A1-T0B").query("VIEWPORT")) >= 5, dxf.layouts.names())
    source_entities = [entity for entity in msp if entity.has_xdata("GUJIAN_SOURCE")]
    checks.require("CAD source references", len(source_entities) >= 20, len(source_entities))

    svg = (output / "t0b-l0plus-demo-sheet.svg").read_text(encoding="utf-8")
    checks.require("SVG revoked-quality labels", all(value in svg for value in ("古建语义技术样例", "横剖面", "L0+", "NOT FOR DELIVERY")), len(svg))
    pdf = (output / "t0b-l0plus-demo-sheet.pdf").read_bytes()
    checks.require("PDF structure", pdf.startswith(b"%PDF-") and pdf.rstrip().endswith(b"%%EOF"), len(pdf))

    if compare_manifest:
        comparison = json.loads(compare_manifest.read_text(encoding="utf-8"))
        checks.require("stable entity map across runs", comparison["entityMap"] == manifest["entityMap"], len(manifest["entityMap"]))

    return {
        "schemaVersion": "t0b-verification-2",
        "status": "verified",
        "gateStatus": "failed",
        "gate": "T0-B",
        "qualityLevel": "L0+",
        "localProfessionalSampleEligible": False,
        "t0GateEligible": False,
        "professionalDeliverableEligible": False,
        "formalEligibility": False,
        "summary": {
            "checks": len(checks.items), "objects": manifest["objectCount"], "categories": len(categories),
            "viewPrimitives": view_counts, "dxfDimensions": dimensions, "dxfHatches": hatches,
            "dxfBlocks": len(inserts), "dxfSourceReferences": len(source_entities),
        },
        "checks": checks.items,
    }


def main() -> int:
    parser = argparse.ArgumentParser(description="Verify the revoked T0-B L0+ technical heritage sample")
    parser.add_argument("--spec", type=Path, required=True)
    parser.add_argument("--output", type=Path, required=True)
    parser.add_argument("--compare-manifest", type=Path)
    parser.add_argument("--report", type=Path)
    args = parser.parse_args()
    try:
        result = verify(args.spec.resolve(), args.output.resolve(), args.compare_manifest.resolve() if args.compare_manifest else None)
        if args.report:
            args.report.write_text(json.dumps(result, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
        print(json.dumps({"status": result["status"], "gateStatus": result["gateStatus"], **result["summary"]}, ensure_ascii=False))
        return 0
    except Exception as exc:
        print(json.dumps({"status": "failed", "type": exc.__class__.__name__, "reason": str(exc)}, ensure_ascii=False), file=sys.stderr)
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
