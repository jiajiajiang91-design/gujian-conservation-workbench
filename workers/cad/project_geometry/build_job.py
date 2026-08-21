from __future__ import annotations

import argparse
import json
from pathlib import Path

from .contracts import load_geometry_spec
from .kernel import build_geometry_package


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--input", required=True, type=Path)
    parser.add_argument("--output", required=True, type=Path)
    arguments = parser.parse_args()
    spec = load_geometry_spec(arguments.input)
    result = build_geometry_package(spec, arguments.output)
    print(json.dumps({
        "status": "succeeded", "geometryRevisionId": result["geometryRevisionId"],
        "geometrySignature": result["geometrySignature"],
        "manifestHash": next(item["sha256"] for item in result["assets"] if item["kind"] == "manifest"),
    }, ensure_ascii=False))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
