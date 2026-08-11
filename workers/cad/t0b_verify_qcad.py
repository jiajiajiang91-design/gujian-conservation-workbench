from __future__ import annotations

import argparse
from collections import Counter
from hashlib import sha256
import json
from pathlib import Path
import re
import sys

import ezdxf
import numpy as np
from PIL import Image


REQUIRED_LAYERS = {
    "A-AXIS",
    "A-CUT",
    "A-OUTLINE",
    "A-PROJ",
    "A-DIM",
    "A-TEXT",
    "A-HATCH",
    "A-EXIST",
    "A-DAMAGE",
    "A-REPAIR",
    "A-ROOF",
    "A-TIMBER",
    "A-OPEN",
}
VALIDATION_START = (-7777.0, -7777.0)
VALIDATION_END = (-7666.0, -7666.0)


def _hash_file(path: Path) -> str:
    digest = sha256()
    with path.open("rb") as stream:
        for chunk in iter(lambda: stream.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def _text(entity) -> str:
    if entity.dxftype() == "MTEXT":
        return entity.plain_text()
    return entity.dxf.text


def _xdata_signatures(modelspace) -> list[tuple]:
    signatures = []
    for entity in modelspace:
        if not entity.has_xdata("GUJIAN_SOURCE"):
            continue
        tags = entity.get_xdata("GUJIAN_SOURCE")
        signatures.append(tuple((tag.code, str(tag.value)) for tag in tags))
    return sorted(signatures)


def _point_matches(point, expected: tuple[float, float]) -> bool:
    return abs(float(point.x) - expected[0]) < 1e-6 and abs(float(point.y) - expected[1]) < 1e-6


class Checks:
    def __init__(self) -> None:
        self.items: list[dict] = []

    def require(self, name: str, condition: bool, evidence) -> None:
        self.items.append({"name": name, "passed": bool(condition), "evidence": evidence})
        if not condition:
            raise AssertionError(f"{name}: {evidence}")


def verify(source: Path, roundtrip: Path, pdf: Path, render: Path, autocad_log: Path) -> dict:
    checks = Checks()
    checks.require("source DXF exists", source.is_file(), str(source))
    checks.require("QCAD roundtrip DXF exists", roundtrip.is_file(), str(roundtrip))
    checks.require("QCAD PDF exists", pdf.is_file(), str(pdf))
    checks.require("QCAD PDF render exists", render.is_file(), str(render))
    checks.require("AutoCAD cross-audit log exists", autocad_log.is_file(), str(autocad_log))

    source_doc = ezdxf.readfile(source)
    output_doc = ezdxf.readfile(roundtrip)
    source_audit = source_doc.audit()
    checks.require(
        "source DXF audit clean",
        not source_audit.errors and not source_audit.fixes,
        {"errors": len(source_audit.errors), "fixes": len(source_audit.fixes)},
    )

    source_msp = source_doc.modelspace()
    output_msp = output_doc.modelspace()
    source_types = Counter(entity.dxftype() for entity in source_msp)
    output_types = Counter(entity.dxftype() for entity in output_msp)
    expected_types = source_types.copy()
    expected_types["LINE"] += 1
    checks.require(
        "entity types retained plus one validation line",
        output_types == expected_types,
        {"source": dict(source_types), "roundtrip": dict(output_types)},
    )

    validation_lines = [
        entity
        for entity in output_msp.query("LINE")
        if (
            _point_matches(entity.dxf.start, VALIDATION_START)
            and _point_matches(entity.dxf.end, VALIDATION_END)
        )
        or (
            _point_matches(entity.dxf.end, VALIDATION_START)
            and _point_matches(entity.dxf.start, VALIDATION_END)
        )
    ]
    checks.require("QCAD edit persisted", len(validation_lines) == 1, len(validation_lines))

    source_layers = {layer.dxf.name for layer in source_doc.layers}
    output_layers = {layer.dxf.name for layer in output_doc.layers}
    checks.require("professional layers retained", REQUIRED_LAYERS <= output_layers, sorted(output_layers))
    checks.require("source layers retained", source_layers <= output_layers, sorted(output_layers - source_layers))

    source_texts = Counter(_text(entity) for entity in source_msp.query("TEXT MTEXT"))
    output_texts = Counter(_text(entity) for entity in output_msp.query("TEXT MTEXT"))
    chinese_texts = [text for text in source_texts if any(ord(character) > 127 for character in text)]
    checks.require("all CAD text retained", source_texts == output_texts, {"source": sum(source_texts.values()), "roundtrip": sum(output_texts.values())})
    checks.require("Chinese labels retained", len(chinese_texts) >= 15 and all(text in output_texts for text in chinese_texts), len(chinese_texts))

    source_dimensions = Counter((entity.dxf.text, entity.dxf.layer, entity.dxf.dimtype) for entity in source_msp.query("DIMENSION"))
    output_dimensions = Counter((entity.dxf.text, entity.dxf.layer, entity.dxf.dimtype) for entity in output_msp.query("DIMENSION"))
    checks.require(
        "editable dimensions retained",
        source_dimensions == output_dimensions and sum(output_dimensions.values()) >= 9,
        [
            {"text": key[0], "layer": key[1], "dimtype": key[2], "count": count}
            for key, count in sorted(output_dimensions.items())
        ],
    )
    checks.require("hatches retained", len(output_msp.query("HATCH")) == len(source_msp.query("HATCH")) >= 4, len(output_msp.query("HATCH")))
    checks.require("block inserts retained", len(output_msp.query("INSERT")) == len(source_msp.query("INSERT")) >= 10, len(output_msp.query("INSERT")))
    checks.require("reusable bracket block retained", "BRACKET" in output_doc.blocks, [block.name for block in output_doc.blocks])

    checks.require(
        "source XDATA retained",
        _xdata_signatures(source_msp) == _xdata_signatures(output_msp),
        {"source": len(_xdata_signatures(source_msp)), "roundtrip": len(_xdata_signatures(output_msp))},
    )
    checks.require("layout names retained", set(source_doc.layouts.names()) == set(output_doc.layouts.names()), output_doc.layouts.names())
    checks.require("A1 viewport layout retained", len(output_doc.layouts.get("A1-T0B").query("VIEWPORT")) >= 5, len(output_doc.layouts.get("A1-T0B").query("VIEWPORT")))

    dimension_cache_count = sum(bool(entity.dxf.geometry) for entity in output_msp.query("DIMENSION"))
    checks.require(
        "QCAD dimensions are directly renderable",
        len(output_msp.query("DIMENSION")) >= 9,
        {"dimensions": len(output_msp.query("DIMENSION")), "cachedGeometryBlocks": dimension_cache_count},
    )
    autocad_text = autocad_log.read_text(encoding="utf-8")
    audit_zero = "共发现 0 个错误" in autocad_text or "Total errors found 0" in autocad_text
    deleted_zero = "已删除 0 个对象" in autocad_text or "0 objects erased" in autocad_text
    substitutions = re.findall(r"^.*(?:替换|Substituting).*$", autocad_text, flags=re.MULTILINE)
    checks.require(
        "AutoCAD cross-audit reports zero errors",
        audit_zero and deleted_zero,
        {"auditZero": audit_zero, "deletedZero": deleted_zero, "fontSubstitutions": substitutions},
    )

    pdf_bytes = pdf.read_bytes()
    checks.require("QCAD PDF structure", pdf_bytes.startswith(b"%PDF-") and pdf_bytes.rstrip().endswith(b"%%EOF"), len(pdf_bytes))
    checks.require("QCAD PDF nontrivial size", len(pdf_bytes) > 100_000, len(pdf_bytes))
    pixels = np.asarray(Image.open(render).convert("L"), dtype=np.uint8)
    dark_fraction = float((pixels < 245).mean())
    contrast = float(pixels.std())
    checks.require("QCAD PDF render is nonblank", dark_fraction > 0.03 and contrast > 25, {"darkFraction": dark_fraction, "contrast": contrast, "shape": list(pixels.shape)})

    return {
        "schemaVersion": "t0b-qcad-verification-1",
        "status": "passed",
        "gate": "T0-B",
        "qualityLevel": "L1",
        "tool": {
            "name": "QCAD Professional Trial",
            "version": "3.32.9",
            "usage": "external compatibility validation only",
            "productionDependency": False,
        },
        "limitations": [
            "This validates L1 import, edit, export, printing, Unicode and CAD semantics; it is not an L2 professional deliverable review.",
            "The trial binary is not committed and is not licensed as a production runtime dependency.",
            "QCAD omits cached DXF dimension graphics on save. QCAD and AutoCAD regenerate them, but the QCAD-saved copy is validation evidence, not a canonical delivery artifact.",
            "AutoCAD substitutes QCAD auxiliary text styles in the validation copy. The canonical generator DXF remains the delivery candidate and passes AutoCAD without font substitution.",
        ],
        "summary": {
            "checks": len(checks.items),
            "entities": sum(output_types.values()),
            "dimensions": len(output_msp.query("DIMENSION")),
            "hatches": len(output_msp.query("HATCH")),
            "blockInserts": len(output_msp.query("INSERT")),
            "sourceReferences": len(_xdata_signatures(output_msp)),
            "chineseLabels": len(chinese_texts),
            "pdfDarkFraction": dark_fraction,
            "cachedDimensionBlocks": dimension_cache_count,
            "crossAuditFontSubstitutions": len(substitutions),
        },
        "artifacts": {
            "sourceDxf": {"path": source.name, "sha256": _hash_file(source)},
            "roundtripDxf": {"path": roundtrip.name, "sha256": _hash_file(roundtrip), "canonicalArtifact": False},
            "printedPdf": {"path": pdf.name, "sha256": _hash_file(pdf)},
            "render": {"path": render.name, "sha256": _hash_file(render)},
            "autocadCrossAudit": {"path": autocad_log.name, "sha256": _hash_file(autocad_log)},
        },
        "checks": checks.items,
    }


def main() -> int:
    parser = argparse.ArgumentParser(description="Verify QCAD roundtrip compatibility for the T0-B sample")
    parser.add_argument("--source", type=Path, required=True)
    parser.add_argument("--roundtrip", type=Path, required=True)
    parser.add_argument("--pdf", type=Path, required=True)
    parser.add_argument("--render", type=Path, required=True)
    parser.add_argument("--autocad-log", type=Path, required=True)
    parser.add_argument("--report", type=Path)
    args = parser.parse_args()
    try:
        result = verify(
            args.source.resolve(),
            args.roundtrip.resolve(),
            args.pdf.resolve(),
            args.render.resolve(),
            args.autocad_log.resolve(),
        )
        if args.report:
            args.report.write_text(json.dumps(result, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
        print(json.dumps({"status": result["status"], **result["summary"]}, ensure_ascii=False))
        return 0
    except Exception as exc:
        print(json.dumps({"status": "failed", "type": exc.__class__.__name__, "reason": str(exc)}, ensure_ascii=False), file=sys.stderr)
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
