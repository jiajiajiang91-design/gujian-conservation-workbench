from __future__ import annotations

import argparse
import importlib.metadata
import json
import platform
import sys
from pathlib import Path

import cadquery as cq
import ifcopenshell


def probe() -> dict[str, object]:
    base = cq.Workplane("XY").box(1200, 900, 240)
    opening = cq.Workplane("XY").circle(120).extrude(240)
    cut = base.cut(opening)
    return {
        "schemaVersion": "1.0",
        "status": "passed-windows-geometry-environment",
        "platform": platform.platform(),
        "python": sys.version.split()[0],
        "packages": {
            "cadquery": importlib.metadata.version("cadquery"),
            "cadquery-ocp": importlib.metadata.version("cadquery-ocp"),
            "ifcopenshell": importlib.metadata.version("ifcopenshell"),
        },
        "checks": {
            "solidValid": bool(base.val().isValid()),
            "booleanCutValid": bool(cut.val().isValid()),
            "booleanCutReducedVolume": bool(cut.val().Volume() < base.val().Volume()),
            "ifcSchemaAvailable": ifcopenshell.file(schema="IFC4").schema == "IFC4",
        },
    }


def main() -> int:
    parser = argparse.ArgumentParser(description="Probe the frozen Windows CAD worker environment.")
    parser.add_argument("--report", type=Path)
    args = parser.parse_args()
    report = probe()
    encoded = json.dumps(report, ensure_ascii=False, indent=2, sort_keys=True) + "\n"
    if args.report:
        args.report.parent.mkdir(parents=True, exist_ok=True)
        args.report.write_text(encoded, encoding="utf-8")
    print(encoded, end="")
    return 0 if all(report["checks"].values()) else 1


if __name__ == "__main__":
    raise SystemExit(main())
