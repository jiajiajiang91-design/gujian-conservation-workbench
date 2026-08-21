from __future__ import annotations

import argparse
import base64
from collections import Counter
from copy import deepcopy
from dataclasses import dataclass
import gzip
from hashlib import sha256
from io import BytesIO
import json
import math
from pathlib import Path
import re
from typing import Callable
from uuid import UUID, uuid5

import ezdxf
from fontTools.ttLib import TTFont
from fontTools.varLib.instancer import instantiateVariableFont
from lxml import etree
from PIL import Image, ImageFont
from pypdf import PdfReader
from pypdf.generic import ContentStream


VERIFIER_VERSION = "1.0.0"
CONTRACT_REVISION_NAMESPACE = UUID("e145714a-5f3c-58d8-bcc7-b34965cc5f8b")
PAGE_MM = (841.0, 594.0)
PNG_SIZE = (9933, 7016)
PT_PER_MM = 72.0 / 25.4
TOLERANCE_MM = 0.001
SVG_NS = {"s": "http://www.w3.org/2000/svg"}
SOURCE_COMMIT = "038b637da7b3fd956a4ed93ffc607c3d5e4ce172"
SOURCE_FONT_SHA = "a3041811a78c361b1de50f953c805e0244951c21c5bd412f7232ef0d899af0da"
SOURCE_LICENSE_SHA = "1c05c68c34f9708415aada51f17e1b0092d2cea709bf4a94cd38114f9e73d7d9"
SOURCE_METADATA_SHA = "c6c4bdb785793b2de1da177caeeffcd0c90d7680bdab2de8f88ab45007bc59bc"
DERIVED_FONT_SHA = "4de4210cdf50d50bd27549cd56a5287c918378015de0773ca18f53022b75cef7"
EXPECTED_LAYOUT_VIEWS = {
    "T0B-01": ["floorPlan", "roofPlan", "southElevation", "transverseSection", "axonometric"],
    "T0B-02": ["longitudinalSection", "eaveDetail", "bracketDetail", "columnBaseDetail", "doorWindowDetail"],
}
RAW_VIEW_IDS = set(sum(EXPECTED_LAYOUT_VIEWS.values(), []))
FORBIDDEN_MARKERS = (
    "c:/users/",
    "c:\\users\\",
    "d:/downloads/",
    "d:\\downloads\\",
    ".dwg",
    "xref",
    "underlay",
    "externalreference",
    "寺庙古建筑设计方案图",
    "一套完整的古建施工图",
)


class SheetOutputVerificationError(RuntimeError):
    pass


def _require(condition: bool, message: str) -> None:
    if not condition:
        raise SheetOutputVerificationError(message)


def _file_hash(path: Path) -> str:
    digest = sha256()
    with path.open("rb") as stream:
        for chunk in iter(lambda: stream.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def _canonical_hash(value: object) -> str:
    raw = json.dumps(value, ensure_ascii=False, sort_keys=True, separators=(",", ":")).encode("utf-8")
    return sha256(raw).hexdigest()


def _close(first: float, second: float, tolerance: float = TOLERANCE_MM) -> bool:
    return math.isclose(float(first), float(second), abs_tol=tolerance)


def _point_error(first: list[float] | tuple[float, ...], second: list[float] | tuple[float, ...]) -> float:
    return max(abs(float(a) - float(b)) for a, b in zip(first, second))


@dataclass
class SheetBundle:
    root: Path
    contract_path: Path
    ir_path: Path
    dxf_path: Path
    artifact_dir: Path
    fixture_path: Path
    font_dir: Path
    contract: dict
    ir: dict
    fixture: dict
    font_manifest: dict
    font_config: dict
    build_record: dict


def default_paths(root: Path) -> dict[str, Path]:
    contract = next(root.rglob("t0b-v2-drawing-package-contract.json"))
    output = contract.parent / "t0b-v2-outputs"
    return {
        "contract": contract,
        "ir": output / "drawing-package-ir" / "drawing-package.ir.json.gz",
        "dxf": output / "native-dxf" / "T0B.dxf",
        "artifact_dir": output / "drawing-package-artifacts",
        "fixture": contract.parent / "t0b-v2-resolved-local-assembly.json",
        "font_dir": root / "workers" / "cad" / "t0b_v2" / "assets" / "fonts" / "noto-sans-sc",
        "font_config": root / "workers" / "cad" / "t0b_v2" / "logical_font_config.json",
    }


def load_bundle(root: Path) -> SheetBundle:
    paths = default_paths(root)
    return SheetBundle(
        root=root,
        contract_path=paths["contract"],
        ir_path=paths["ir"],
        dxf_path=paths["dxf"],
        artifact_dir=paths["artifact_dir"],
        fixture_path=paths["fixture"],
        font_dir=paths["font_dir"],
        contract=json.loads(paths["contract"].read_text(encoding="utf-8")),
        ir=json.loads(gzip.decompress(paths["ir"].read_bytes()).decode("utf-8")),
        fixture=json.loads(paths["fixture"].read_text(encoding="utf-8")),
        font_manifest=json.loads((paths["font_dir"] / "font-manifest.json").read_text(encoding="utf-8")),
        font_config=json.loads(paths["font_config"].read_text(encoding="utf-8")),
        build_record=json.loads((paths["artifact_dir"] / "T0B-sheet-output-build-record.json").read_text(encoding="utf-8")),
    )


def _name_values(font: TTFont, name_id: int) -> set[str]:
    return {record.toUnicode() for record in font["name"].names if record.nameID == name_id}


def _glyph_geometry_signature(font: TTFont) -> str:
    glyph_set = font.getGlyphSet()
    hmtx = font["hmtx"].metrics
    digest = sha256()
    for name in font.getGlyphOrder():
        glyph = glyph_set[name]
        digest.update(name.encode("utf-8"))
        digest.update(repr(hmtx[name]).encode("ascii"))
        if hasattr(glyph, "_glyph"):
            source = glyph._glyph
            coordinates, end_points, flags = source.getCoordinates(font["glyf"])
            digest.update(repr((list(coordinates), list(end_points), list(flags))).encode("ascii"))
    return digest.hexdigest()


def verify_font_closure(bundle: SheetBundle) -> dict:
    source_path = bundle.font_dir / "NotoSansSC[wght].ttf"
    license_path = bundle.font_dir / "OFL.txt"
    metadata_path = bundle.font_dir / "METADATA.pb"
    derived_path = bundle.font_dir / "GujianSansSC-Regular.ttf"
    corpus_path = bundle.font_dir / "font-corpus.txt"
    manifest_path = bundle.font_dir / "font-manifest.json"
    _require(_file_hash(source_path) == SOURCE_FONT_SHA, "official source font hash differs")
    _require(_file_hash(license_path) == SOURCE_LICENSE_SHA, "OFL hash differs")
    _require(_file_hash(metadata_path) == SOURCE_METADATA_SHA, "Google Fonts metadata hash differs")
    _require(_file_hash(derived_path) == DERIVED_FONT_SHA, "derived wght=400 font hash differs")
    _require(_file_hash(manifest_path) == bundle.font_config["fontManifestSha256"], "font manifest file hash differs from the logical binding")
    manifest = bundle.font_manifest
    payload = deepcopy(manifest)
    stored_payload_hash = payload.pop("manifestPayloadSha256", None)
    _require(stored_payload_hash == _canonical_hash(payload), "font manifest canonical payload hash differs")
    source = manifest["source"]
    expected_base = f"https://raw.githubusercontent.com/google/fonts/{SOURCE_COMMIT}/ofl/notosanssc"
    _require(source["repository"] == "google/fonts" and source["commit"] == SOURCE_COMMIT, "official font repository or pinned commit differs")
    _require(source["fontUrl"] == f"{expected_base}/NotoSansSC%5Bwght%5D.ttf", "official font URL differs")
    _require(source["licenseUrl"] == f"{expected_base}/OFL.txt" and source["metadataUrl"] == f"{expected_base}/METADATA.pb", "official license or metadata URL differs")
    _require(source["sourceFontSha256"] == SOURCE_FONT_SHA and source["metadataSha256"] == SOURCE_METADATA_SHA, "font manifest upstream hashes differ")
    _require(manifest["licenseSpdx"] == "OFL-1.1" and manifest["licenseFileSha256"] == SOURCE_LICENSE_SHA, "font license declaration differs")
    _require(manifest["redistributionAllowed"] is True and manifest["pdfEmbeddingAllowed"] is True, "font redistribution or embedding permission differs")
    _require("Reserved Font Name 'Source'" in license_path.read_text(encoding="utf-8"), "OFL reserved name evidence is missing")

    source_font = TTFont(source_path, recalcTimestamp=False, lazy=False)
    derived_font = TTFont(derived_path, recalcTimestamp=False, lazy=False)
    _require("fvar" in source_font and [(axis.axisTag, axis.minValue, axis.defaultValue, axis.maxValue) for axis in source_font["fvar"].axes] == [("wght", 100.0, 100.0, 900.0)], "source variable axis differs")
    _require("fvar" not in derived_font and derived_font["OS/2"].usWeightClass == 400 and derived_font["OS/2"].fsType == 0, "derived font is not a static embeddable weight-400 instance")
    _require(_name_values(derived_font, 1) == {"Gujian Sans SC"} and _name_values(derived_font, 4) == {"Gujian Sans SC Regular"} and _name_values(derived_font, 6) == {"GujianSansSC-Regular"}, "derived font names differ")
    independent_instance = instantiateVariableFont(source_font, {"wght": 400}, inplace=False, optimize=True)
    _require(_glyph_geometry_signature(independent_instance) == _glyph_geometry_signature(derived_font), "derived font glyphs or metrics differ from an independent wght=400 instance")

    corpus = corpus_path.read_text(encoding="utf-8")
    required = sorted({ord(char) for char in corpus if not char.isspace()})
    cmap = derived_font.getBestCmap() or {}
    missing = [f"U+{codepoint:04X}" for codepoint in required if codepoint not in cmap]
    declared_coverage = manifest["glyphCoverage"]
    _require(
        not missing
        and declared_coverage["corpusSha256"] == _file_hash(corpus_path)
        and declared_coverage["requiredCodepointCount"] == len(required)
        and declared_coverage["coveredCodepointCount"] == len(required),
        "font corpus glyph closure differs",
    )
    return {
        "sourceCommit": SOURCE_COMMIT,
        "sourceFontSha256": SOURCE_FONT_SHA,
        "licenseSha256": SOURCE_LICENSE_SHA,
        "metadataSha256": SOURCE_METADATA_SHA,
        "derivedFontSha256": DERIVED_FONT_SHA,
        "derivedFamily": "Gujian Sans SC",
        "weight": 400,
        "fsType": 0,
        "requiredCodepoints": len(required),
        "missingCodepoints": missing,
        "independentGlyphGeometryMatch": True,
    }


def verify_contract_ir_output_binding(bundle: SheetBundle) -> dict:
    contract_payload = {key: value for key, value in bundle.contract.items() if key not in {"contractSignature", "contractRevisionId"}}
    signature = _canonical_hash(contract_payload)
    _require(signature == bundle.contract["contractSignature"], "DrawingPackageContract signature differs")
    revision = str(uuid5(CONTRACT_REVISION_NAMESPACE, signature))
    _require(revision == bundle.contract["contractRevisionId"], "DrawingPackageContract revision differs")
    ir_payload = dict(bundle.ir)
    ir_hash = ir_payload.pop("drawingPackageIrSha256", None)
    _require(ir_hash == _canonical_hash(ir_payload), "DrawingPackageIR canonical hash differs")
    _require(bundle.ir["drawingPackageContractSignature"] == signature and bundle.ir["drawingPackageContractRevisionId"] == revision, "IR contract binding differs")
    _require(bundle.ir["fontPolicy"] == bundle.contract["fontPolicy"], "IR font policy differs from the contract")
    record = bundle.build_record
    _require(record["inputs"]["drawingPackageContract"] == {"revisionId": revision, "signature": signature}, "sheet build record contract binding differs")
    _require(record["inputs"]["drawingPackageIr"]["drawingPackageIrSha256"] == ir_hash, "sheet build record IR binding differs")
    _require(record["inputs"]["font"]["sha256"] == DERIVED_FONT_SHA and record["inputs"]["font"]["instanceWeight"] == 400, "sheet build record font binding differs")
    _require(record["status"] == "generated-not-qualified" and record["L1"] is False and record["qualification"]["generatorMaySetEligible"] is False, "sheet build record elevated qualification")
    blockers = set(record["qualification"]["requiredBlockers"])
    _require({"BRACKET_DETAIL_SIMPLIFIED_GEOMETRY", "QCAD_LOSSLESS_ROUNDTRIP_UNSUPPORTED", "PROFESSIONAL_REVIEW_PENDING"}.issubset(blockers), "required L1 blockers are missing")
    _require("FONT_ASSET_NOT_BOUND" not in blockers and "DRAWING_OUTPUTS_NOT_BUILT" not in blockers, "closed font or output blocker remains")
    expected_files = {"T0B-01.svg", "T0B-02.svg", "T0B.pdf", "T0B-01-300dpi.png", "T0B-02-300dpi.png"}
    _require(expected_files.issubset({path.name for path in bundle.artifact_dir.iterdir() if path.is_file()}), "cross-format output set is incomplete")
    for group in (record["outputs"]["svg"], record["outputs"]["reviewPng"]):
        for item in group:
            _require(_file_hash(bundle.artifact_dir / item["name"]) == item["sha256"], f"{item['name']} hash differs from the build record")
    _require(_file_hash(bundle.artifact_dir / record["outputs"]["pdf"]["name"]) == record["outputs"]["pdf"]["sha256"], "PDF hash differs from the build record")
    return {"contractSignature": signature, "contractRevisionId": revision, "drawingPackageIrSha256": ir_hash, "outputs": sorted(expected_files), "L1": False, "remainingBlockers": sorted(blockers)}


def _view_transform(stage: dict, viewport: dict, point: list[float]) -> tuple[float, float]:
    x, y, width, height = [float(value) for value in viewport["paperRectMm"]]
    sx1, sy1, sx2, sy2 = [float(value) for value in stage["stagedBoundsMm"]]
    center_model = ((sx1 + sx2) / 2.0, (sy1 + sy2) / 2.0)
    center_paper = (x + width / 2.0, y + height / 2.0)
    scale = float(viewport["paperScale"])
    return center_paper[0] + (float(point[0]) - center_model[0]) * scale, center_paper[1] + (float(point[1]) - center_model[1]) * scale


def _parse_points(value: str) -> list[tuple[float, float]]:
    return [tuple(float(part) for part in token.split(",")) for token in value.split()]


def _parse_svg_path(value: str) -> list[list[tuple[float, float]]]:
    tokens = re.findall(r"[MLZ]|-?(?:\d+(?:\.\d*)?|\.\d+)(?:[Ee][+-]?\d+)?", value)
    rings: list[list[tuple[float, float]]] = []
    index = 0
    current: list[tuple[float, float]] | None = None
    while index < len(tokens):
        command = tokens[index]
        index += 1
        if command in {"M", "L"}:
            _require(index + 1 < len(tokens), "SVG path coordinate is incomplete")
            point = (float(tokens[index]), float(tokens[index + 1]))
            index += 2
            if command == "M":
                current = [point]
                rings.append(current)
            else:
                _require(current is not None, "SVG path starts without M")
                current.append(point)
        elif command == "Z":
            current = None
        else:
            raise SheetOutputVerificationError(f"unsupported SVG path token: {command}")
    return rings


def _region_model_rings(stage: dict, region: dict) -> list[list[list[float]]]:
    if region["sourceKind"] == "ViewGeometry.cutRegion":
        by_id = {line["cadObjectId"]: line for line in stage["structuralLines"]}
        return [by_id[cad_id]["modelSpacePointsMm"] for cad_id in region["boundaryCadObjectIds"]]
    return [region["modelSpaceOuterMm"], *region["modelSpaceHolesMm"]]


def _svg_document(path: Path):
    return etree.parse(str(path), etree.XMLParser(huge_tree=True, resolve_entities=False, no_network=True))


def _svg_pages(bundle: SheetBundle) -> list[dict]:
    stages = {stage["viewId"]: stage for stage in bundle.ir["modelSpace"]["viewStages"]}
    layout_by_name = {layout["layoutName"]: layout for layout in bundle.ir["paperSpace"]["layouts"]}
    expected_annotations = {item["requirementId"]: item for item in bundle.ir["annotations"]}
    pages: list[dict] = []
    for layout_name in ("T0B-01", "T0B-02"):
        path = bundle.artifact_dir / f"{layout_name}.svg"
        tree = _svg_document(path)
        root = tree.getroot()
        _require(root.get("width") == "841mm" and root.get("height") == "594mm" and root.get("viewBox") == "0 0 841 594", f"{path.name} A1 geometry differs")
        metadata = json.loads(tree.xpath("string(/s:svg/s:metadata)", namespaces=SVG_NS))
        _require(metadata == {"L1": False, "drawingPackageIrSha256": bundle.ir["drawingPackageIrSha256"], "layoutName": layout_name, "status": "generated-not-qualified"}, f"{path.name} metadata binding differs")
        _require(not tree.xpath("//s:image|//s:script|//s:foreignObject", namespaces=SVG_NS), f"{path.name} contains a raster image or executable/external object")
        for element in tree.xpath("//*[@href or @*[local-name()='href']]", namespaces=SVG_NS):
            hrefs = [value for key, value in element.attrib.items() if key.endswith("href")]
            _require(all(value.startswith("#") for value in hrefs), f"{path.name} contains an external href")
        style = tree.xpath("string(/s:svg/s:defs/s:style)", namespaces=SVG_NS)
        match = re.search(r"data:font/ttf;base64,([A-Za-z0-9+/=]+)", style)
        _require(match is not None and sha256(base64.b64decode(match.group(1))).hexdigest() == DERIVED_FONT_SHA, f"{path.name} embedded font differs")
        _require('font-family:"Gujian Sans SC"' in style and "font-weight:400" in style, f"{path.name} font family or weight differs")

        layout = layout_by_name[layout_name]
        viewport_by_view = {item["viewId"]: item for item in layout["viewports"]}
        groups = tree.xpath("//s:g[starts-with(@id,'view-')]", namespaces=SVG_NS)
        _require([group.get("data-view-id") for group in groups] == EXPECTED_LAYOUT_VIEWS[layout_name], f"{path.name} view group order differs")
        structural_points: list[list[tuple[float, float]]] = []
        material_count = 0
        annotation_ids: set[str] = set()
        texts: list[dict] = []
        clips: dict[str, tuple[float, float, float, float]] = {}
        for clip in tree.xpath("//s:clipPath", namespaces=SVG_NS):
            rect = clip.find("{http://www.w3.org/2000/svg}rect")
            clips[clip.get("id").removeprefix("clip-")] = tuple(float(rect.get(key)) for key in ("x", "y", "width", "height"))
        for group in groups:
            view_id = group.get("data-view-id")
            stage = stages[view_id]
            viewport = viewport_by_view[view_id]
            expected_lines = stage["structuralLines"]
            actual_lines = group.xpath("./s:polyline[@data-object-class='structural']", namespaces=SVG_NS)
            _require(len(actual_lines) == len(expected_lines), f"{path.name}/{view_id} structural line count differs")
            for expected, actual in zip(expected_lines, actual_lines):
                _require(actual.get("data-cad-object-id") == expected["cadObjectId"] and actual.get("data-layer") == expected["layer"], f"{path.name}/{view_id} structural identity differs")
                points = _parse_points(actual.get("points"))
                expected_points = []
                for point in expected["modelSpacePointsMm"]:
                    x, y = _view_transform(stage, viewport, point)
                    expected_points.append((x, PAGE_MM[1] - y))
                _require(len(points) == len(expected_points) and max(_point_error(first, second) for first, second in zip(points, expected_points)) <= TOLERANCE_MM, f"{path.name}/{view_id}/{expected['cadObjectId']} structural coordinates differ")
                structural_points.append(points)
            expected_regions = stage["materialRegions"]
            actual_regions = group.xpath("./s:path[@data-object-class='material-region']", namespaces=SVG_NS)
            _require(len(actual_regions) == len(expected_regions), f"{path.name}/{view_id} material region count differs")
            for expected, actual in zip(expected_regions, actual_regions):
                _require(actual.get("data-cad-object-id") == expected["cadObjectId"], f"{path.name}/{view_id} material identity differs")
                actual_rings = _parse_svg_path(actual.get("d"))
                expected_rings = []
                for ring in _region_model_rings(stage, expected):
                    transformed = []
                    for point in ring:
                        x, y = _view_transform(stage, viewport, point)
                        transformed.append((x, PAGE_MM[1] - y))
                    expected_rings.append(transformed)
                _require(len(actual_rings) == len(expected_rings), f"{path.name}/{view_id} material ring count differs")
                for actual_ring, expected_ring in zip(actual_rings, expected_rings):
                    _require(len(actual_ring) == len(expected_ring) and max(_point_error(first, second) for first, second in zip(actual_ring, expected_ring)) <= TOLERANCE_MM, f"{path.name}/{view_id} material boundary differs")
            material_count += len(actual_regions)
            for element in group.xpath(".//*[@data-requirement-id]", namespaces=SVG_NS):
                annotation_ids.add(element.get("data-requirement-id"))
            for element in group.xpath(".//s:text", namespaces=SVG_NS):
                _require(float(element.get("font-size")) >= 2.5, f"{path.name} contains text below 2.5 mm")
                texts.append({"value": "".join(element.itertext()), "x": float(element.get("x")), "y": float(element.get("y")), "size": float(element.get("font-size")), "anchor": element.get("text-anchor", "start"), "requirementId": element.get("data-requirement-id"), "viewId": view_id})
        title_group = tree.xpath("//s:g[@data-object-class='system-title-block']", namespaces=SVG_NS)
        _require(len(title_group) == 1, f"{path.name} title block count differs")
        annotation_ids.add(title_group[0].get("data-requirement-id"))
        for element in title_group[0].xpath(".//s:text", namespaces=SVG_NS):
            texts.append({"value": "".join(element.itertext()), "x": float(element.get("x")), "y": float(element.get("y")), "size": float(element.get("font-size")), "anchor": element.get("text-anchor", "start"), "requirementId": None, "viewId": None})
        expected_ids = {item["requirementId"] for item in expected_annotations.values() if item.get("viewId") in EXPECTED_LAYOUT_VIEWS[layout_name] or item.get("layoutName") == layout_name}
        _require(annotation_ids == expected_ids, f"{path.name} annotation requirement closure differs")
        _require(not any("\ufffd" in item["value"] or "?" in item["value"] for item in texts), f"{path.name} contains a replacement glyph or question-mark placeholder")
        pages.append({"layoutName": layout_name, "path": path, "tree": tree, "texts": texts, "structuralPoints": structural_points, "materialCount": material_count, "clips": clips, "viewports": viewport_by_view})
    return pages


def verify_svg_geometry_text(bundle: SheetBundle) -> dict:
    pages = _svg_pages(bundle)
    return {"sheets": len(pages), "views": sum(len(EXPECTED_LAYOUT_VIEWS[page["layoutName"]]) for page in pages), "structuralObjects": sum(len(page["structuralPoints"]) for page in pages), "materialRegions": sum(page["materialCount"] for page in pages), "textObjects": sum(len(page["texts"]) for page in pages), "embeddedFontSha256": DERIVED_FONT_SHA, "externalObjects": 0}


def _pdf_structural_paths(reader: PdfReader, page_index: int) -> tuple[list[list[tuple[float, float]]], int]:
    operations = ContentStream(reader.pages[page_index].get_contents(), reader).operations
    stroke_color: tuple[float, ...] | None = None
    current: list[tuple[float, float]] = []
    paths: list[list[tuple[float, float]]] = []
    clip_count = 0
    for operands, operator in operations:
        if operator == b"RG":
            stroke_color = tuple(float(value) for value in operands)
        elif operator == b"m":
            current = [(float(operands[0]) / PT_PER_MM, float(operands[1]) / PT_PER_MM)]
        elif operator == b"l" and current:
            current.append((float(operands[0]) / PT_PER_MM, float(operands[1]) / PT_PER_MM))
        elif operator == b"W*":
            clip_count += 1
        elif operator == b"S":
            if stroke_color == (0.09, 0.09, 0.09) and len(current) >= 2:
                paths.append(current)
            current = []
    return paths, clip_count


def verify_pdf_geometry_text(bundle: SheetBundle) -> dict:
    svg_pages = _svg_pages(bundle)
    pdf_path = bundle.artifact_dir / "T0B.pdf"
    reader = PdfReader(str(pdf_path))
    _require(len(reader.pages) == 2, "PDF page count differs")
    _require(not reader.attachments, "PDF contains embedded attachments")
    subset_hashes = []
    text_counts = []
    structural_counts = []
    material_counts = []
    for index, (page, svg_page) in enumerate(zip(reader.pages, svg_pages)):
        width = float(page.mediabox.width) / PT_PER_MM
        height = float(page.mediabox.height) / PT_PER_MM
        _require(_close(width, PAGE_MM[0], 0.01) and _close(height, PAGE_MM[1], 0.01), f"PDF page {index + 1} is not A1 landscape")
        resources = page["/Resources"]
        xobjects = resources.get("/XObject", {})
        _require(not any(item.get_object().get("/Subtype") == "/Image" for item in xobjects.values()), f"PDF page {index + 1} contains a raster image")
        fonts = resources["/Font"]
        _require(len(fonts) == 1, f"PDF page {index + 1} contains a substituted or extra font")
        font = next(iter(fonts.values())).get_object()
        descriptor = font["/FontDescriptor"].get_object()
        _require("GujianSansSC-Regular" in str(font["/BaseFont"]) and "/ToUnicode" in font and "/FontFile2" in descriptor, f"PDF page {index + 1} font embedding or ToUnicode differs")
        embedded = descriptor["/FontFile2"].get_object().get_data()
        subset_hashes.append(sha256(embedded).hexdigest())
        subset = TTFont(BytesIO(embedded), recalcTimestamp=False, lazy=False)
        _require("fvar" not in subset and subset["OS/2"].usWeightClass == 400 and subset["OS/2"].fsType == 0, f"PDF page {index + 1} embedded subset is not static weight 400")
        _require(_name_values(subset, 6) == {"GujianSansSC-Regular"}, f"PDF page {index + 1} embedded subset PostScript name differs")
        svg_text = [item["value"] for item in svg_page["texts"]]
        pdf_text = (page.extract_text() or "").splitlines()
        _require(pdf_text == svg_text, f"PDF page {index + 1} searchable text differs from SVG")
        text_counts.append(len(pdf_text))
        pdf_paths, clip_count = _pdf_structural_paths(reader, index)
        expected_paths = [[(x, PAGE_MM[1] - y) for x, y in path] for path in svg_page["structuralPoints"]]
        _require(len(pdf_paths) == len(expected_paths), f"PDF page {index + 1} structural path count differs")
        for pdf_points, expected_points in zip(pdf_paths, expected_paths):
            _require(len(pdf_points) == len(expected_points) and max(_point_error(first, second) for first, second in zip(pdf_points, expected_points)) <= TOLERANCE_MM, f"PDF page {index + 1} structural coordinates differ from SVG/IR")
        _require(clip_count - 5 == svg_page["materialCount"], f"PDF page {index + 1} material clip closure differs")
        structural_counts.append(len(pdf_paths))
        material_counts.append(clip_count - 5)
    return {"pages": 2, "pageMm": [841, 594], "embeddedFontSubsets": subset_hashes, "fontWeight": 400, "ToUnicode": True, "searchableTextObjects": text_counts, "structuralObjects": structural_counts, "materialRegions": material_counts, "rasterImages": 0, "attachments": 0}


def _ink_near(image: Image.Image, x: int, y: int, radius: int = 3) -> bool:
    left, top = max(0, x - radius), max(0, y - radius)
    right, bottom = min(image.width, x + radius + 1), min(image.height, y + radius + 1)
    extrema = image.crop((left, top, right, bottom)).convert("L").getextrema()
    return extrema[0] < 245


def verify_png_geometry(bundle: SheetBundle) -> dict:
    svg_pages = _svg_pages(bundle)
    page_results = []
    for index, svg_page in enumerate(svg_pages, 1):
        path = bundle.artifact_dir / f"T0B-{index:02d}-300dpi.png"
        image = Image.open(path)
        _require(image.size == PNG_SIZE and image.mode == "RGB", f"{path.name} pixel size or mode differs")
        dpi = image.info.get("dpi")
        _require(dpi is not None and _close(dpi[0], 300, 0.01) and _close(dpi[1], 300, 0.01), f"{path.name} DPI metadata differs")
        samples = 0
        hits = 0
        for points in svg_page["structuralPoints"]:
            for first, second in zip(points, points[1:]):
                x = (first[0] + second[0]) / 2.0
                y = (first[1] + second[1]) / 2.0
                px = round(x / PAGE_MM[0] * PNG_SIZE[0])
                py = round(y / PAGE_MM[1] * PNG_SIZE[1])
                samples += 1
                hits += int(_ink_near(image, px, py))
        coverage = hits / samples if samples else 0.0
        _require(coverage >= 0.985, f"{path.name} does not rasterize enough of the SVG/IR structural geometry")
        _require(_ink_near(image, round(5 / PAGE_MM[0] * PNG_SIZE[0]), round(5 / PAGE_MM[1] * PNG_SIZE[1]), 4), f"{path.name} paper frame is absent")
        page_results.append({"name": path.name, "sha256": _file_hash(path), "pixelSize": list(image.size), "dpi": [round(dpi[0], 4), round(dpi[1], 4)], "structuralMidpointCoverage": round(coverage, 6), "samples": samples})
    return {"pages": page_results}


def verify_text_and_external_isolation(bundle: SheetBundle) -> dict:
    svg_pages = _svg_pages(bundle)
    visible = [item["value"] for page in svg_pages for item in page["texts"]]
    text = "\n".join(visible)
    _require("\ufffd" not in text and "?" not in text, "visible output contains replacement characters or question-mark placeholders")
    font = TTFont(bundle.font_dir / "GujianSansSC-Regular.ttf", recalcTimestamp=False, lazy=False)
    cmap = font.getBestCmap() or {}
    visible_codepoints = sorted({ord(char) for char in text if char not in "\r\n\t"})
    missing = [f"U+{codepoint:04X}" for codepoint in visible_codepoints if codepoint not in cmap]
    _require(not missing, "visible output uses characters missing from the bound font")
    files = [
        bundle.contract_path,
        bundle.ir_path,
        bundle.dxf_path,
        bundle.artifact_dir / "T0B-sheet-output-build-record.json",
    ]
    for path in files:
        raw = path.read_bytes()
        lowered = raw.lower()
        for marker in FORBIDDEN_MARKERS:
            if path in {bundle.contract_path, bundle.ir_path} and marker in {"xref", "underlay", "externalreference"}:
                # These words name explicitly forbidden policy kinds in the
                # contract/IR; they are not embedded external references.
                continue
            _require(marker.encode("utf-8").lower() not in lowered, f"{path.name} contains an external DWG/path marker")
    # External hrefs are checked structurally in _svg_pages. Raw namespace
    # declarations contain the W3C HTTP URI and are not remote dependencies.
    return {"visibleTextObjects": len(visible), "uniqueVisibleCodepoints": len(visible_codepoints), "missingGlyphs": missing, "replacementCharacters": 0, "questionMarkPlaceholders": 0, "externalDwgMarkers": 0, "absolutePaths": 0, "remoteSvgDependencies": 0}


def _text_bbox(item: dict, font_path: Path) -> tuple[float, float, float, float]:
    scale = 100
    font = ImageFont.truetype(str(font_path), size=round(item["size"] * scale))
    width = float(font.getlength(item["value"])) / scale
    height = item["size"] * 0.9
    x = item["x"]
    if item["anchor"] == "middle":
        left = x - width / 2.0
    elif item["anchor"] == "end":
        left = x - width
    else:
        left = x
    return left, item["y"] - height * 0.85, left + width, item["y"] + height * 0.15


def _overlap_area(first: tuple[float, ...], second: tuple[float, ...]) -> float:
    width = max(0.0, min(first[2], second[2]) - max(first[0], second[0]))
    height = max(0.0, min(first[3], second[3]) - max(first[1], second[1]))
    return width * height


def professional_findings(bundle: SheetBundle) -> dict[str, list[dict]]:
    pages = _svg_pages(bundle)
    font_path = bundle.font_dir / "GujianSansSC-Regular.ttf"
    all_text = [item for page in pages for item in page["texts"]]
    raw_targets = sorted({item["value"] for item in all_text if item["value"] in RAW_VIEW_IDS})
    collisions = []
    clipped = []
    safe_violations = []
    fixture_views = {item["id"]: item for item in bundle.fixture["views"]}
    for page in pages:
        view_items = [item for item in page["texts"] if item["viewId"]]
        boxes = [(item, _text_bbox(item, font_path)) for item in view_items]
        for index, (first_item, first_box) in enumerate(boxes):
            view_id = first_item["viewId"]
            clip = page["clips"][view_id]
            clip_bounds = (clip[0], clip[1], clip[0] + clip[2], clip[1] + clip[3])
            if first_box[0] < clip_bounds[0] or first_box[1] < clip_bounds[1] or first_box[2] > clip_bounds[2] or first_box[3] > clip_bounds[3]:
                clipped.append({"layout": page["layoutName"], "viewId": view_id, "text": first_item["value"], "bboxSvgMm": [round(value, 3) for value in first_box], "clipSvgMm": [round(value, 3) for value in clip_bounds]})
            safe = fixture_views[view_id]["paperPlacement"]["annotationSafeRectMm"]
            paper_box = (first_box[0], PAGE_MM[1] - first_box[3], first_box[2], PAGE_MM[1] - first_box[1])
            safe_bounds = (safe[0], safe[1], safe[0] + safe[2], safe[1] + safe[3])
            if paper_box[0] < safe_bounds[0] or paper_box[1] < safe_bounds[1] or paper_box[2] > safe_bounds[2] or paper_box[3] > safe_bounds[3]:
                safe_violations.append({"layout": page["layoutName"], "viewId": view_id, "text": first_item["value"], "paperBBoxMm": [round(value, 3) for value in paper_box], "safeRectMm": [round(value, 3) for value in safe_bounds]})
            for second_item, second_box in boxes[index + 1 :]:
                if first_item["viewId"] != second_item["viewId"]:
                    continue
                area = _overlap_area(first_box, second_box)
                if area > 0.05:
                    collisions.append({"layout": page["layoutName"], "viewId": view_id, "first": first_item["value"], "second": second_item["value"], "overlapAreaMm2": round(area, 3), "requirements": [first_item["requirementId"], second_item["requirementId"]]})

    dxf = ezdxf.readfile(bundle.dxf_path)
    dxf_visible_texts = []
    condition_layer_objects = 0
    title_values = []
    for entity in dxf.entitydb.values():
        if entity.dxftype() in {"TEXT", "ATTRIB", "ATTDEF"}:
            dxf_visible_texts.append(entity.dxf.text)
        elif entity.dxftype() == "MTEXT":
            dxf_visible_texts.append(entity.plain_text())
        if entity.dxf.hasattr("layer") and entity.dxf.layer == "GJ-CONDITION":
            condition_layer_objects += 1
        if entity.dxftype() == "INSERT" and entity.dxf.name == "GJ_TITLEBLOCK":
            title_values.append({attribute.dxf.tag: attribute.dxf.text for attribute in entity.attribs})
    raw_targets_dxf = sorted({value for value in dxf_visible_texts if value in RAW_VIEW_IDS})
    issue_dates = sorted({item.get("DATE") for item in title_values})
    statuses = sorted({item.get("STATUS") for item in title_values})
    revisions = sorted({item.get("REVISION") for item in title_values})
    condition = bundle.fixture["conditionRecord"]
    condition_present = any(condition["description"] in value for value in [*dxf_visible_texts, *(item["value"] for item in all_text)])
    contract_categories = {item["category"] for item in bundle.ir["annotations"]}

    p0 = []
    if raw_targets or raw_targets_dxf:
        p0.append({"id": "P0-RAW-VIEW-ID-IN-INDEX-SYMBOL", "summary": "Section/detail symbols expose stable English view IDs instead of short drawing references.", "evidence": {"svgPdfPngValues": raw_targets, "dxfAttribValues": raw_targets_dxf}, "requiredAction": "Keep targetViewId in provenance only; freeze a short displayLabel and sheetRef for every section/detail reference and regenerate all formats."})
    if collisions:
        p0.append({"id": "P0-ANNOTATION-COLLISION", "summary": "The grouped sheets contain visible annotation collisions.", "evidence": {"count": len(collisions), "collisions": collisions}, "requiredAction": "Resolve every collision with symbol-size-aware label placement and rerun the zero-overlap gate."})
    if clipped or safe_violations:
        p0.append({"id": "P0-ANNOTATION-CLIP-OR-SAFE-RECT", "summary": "One or more annotations leave the clip or frozen annotation-safe rectangle.", "evidence": {"clipped": clipped, "safeRectViolations": safe_violations}, "requiredAction": "Place titles, dimensions, levels and references inside each frozen safe rectangle and verify their full glyph bounds."})
    if issue_dates == ["2000-01-01"]:
        p0.append({"id": "P0-FALSE-ISSUE-DATE", "summary": "The deterministic build timestamp is printed as the drawing issue date.", "evidence": {"visibleDates": issue_dates, "buildTimestamp": bundle.ir["generatedAt"]}, "requiredAction": "Freeze an explicit business issueDate or an unissued label; never derive a visible issue date from deterministic build metadata."})
    if not condition_present or condition_layer_objects == 0 or not {"condition", "protectionNote"}.intersection(contract_categories):
        p0.append({"id": "P0-CONDITION-PROTECTION-NOTE-MISSING", "summary": "The frozen demo condition record is not represented by an object-linked condition or protection note.", "evidence": {"conditionRecordId": condition["id"], "conditionDescriptionPresent": condition_present, "conditionLayerObjects": condition_layer_objects, "annotationCategories": sorted(contract_categories)}, "requiredAction": "Add at least one object-linked demo condition/protection annotation and a non-empty GJ-CONDITION output with source and status provenance."})
    blockers = set(bundle.build_record["qualification"]["requiredBlockers"])
    if "BRACKET_DETAIL_SIMPLIFIED_GEOMETRY" in blockers:
        p0.append({"id": "P0-BRACKET-DETAIL-SIMPLIFIED", "summary": "The bracket/support detail remains explicitly simplified and cannot qualify as the required resolved L1 node.", "evidence": {"blocker": "BRACKET_DETAIL_SIMPLIFIED_GEOMETRY"}, "requiredAction": "Replace the simplified support geometry with a resolved, source-traceable node before any L1 review."})
    if "QCAD_LOSSLESS_ROUNDTRIP_UNSUPPORTED" in blockers:
        p0.append({"id": "P0-SECOND-CAD-ROUNDTRIP-UNSUPPORTED", "summary": "The required second-CAD lossless roundtrip remains unsupported.", "evidence": {"blocker": "QCAD_LOSSLESS_ROUNDTRIP_UNSUPPORTED"}, "requiredAction": "Retain this blocker until a revised package passes the independent second-CAD workflow."})

    p1 = [
        {"id": "P1-TITLEBLOCK-INTERNAL-VALUES", "summary": "The title block exposes the full contract UUID and the raw English status enum.", "evidence": {"statuses": statuses, "revisions": revisions}, "requiredAction": "Use a short drawing revision and a concise Chinese user-facing status; retain UUID/status keys in manifest and XDATA."},
        {"id": "P1-TEXT-HIERARCHY", "summary": "Every visible SVG text object uses the minimum 2.5 mm height, so view titles, notes and title-block fields have no hierarchy.", "evidence": {"fontSizesMm": sorted({item["size"] for item in all_text})}, "requiredAction": "Freeze separate printed heights for view titles, general notes, dimensions and title-block fields."},
        {"id": "P1-SHEET-COMPOSITION", "summary": "Both sheets use large unstructured whitespace; the second sheet also has uneven detail density.", "evidence": {"layouts": ["T0B-01", "T0B-02"], "humanReview": True}, "requiredAction": "Rebalance view scales and placements as grouped A1 sheets after annotation content is complete."},
        {"id": "P1-DETAIL-INFORMATION-DEPTH", "summary": "Eave, column-base and door/window details lack the component specifications, material labels and construction/protection notes expected in the quality baseline.", "evidence": {"views": ["eaveDetail", "columnBaseDetail", "doorWindowDetail"], "doorWindowLabels": ["frame", "leaf", "lattice"]}, "requiredAction": "Add source-linked Chinese component names, key member sizes, material/specification labels and necessary construction or protection notes."},
        {"id": "P1-INTERNAL-ENGLISH-DISPLAY-LABELS", "summary": "Door/window callouts expose English implementation labels as user-visible drawing text.", "evidence": {"labels": ["frame", "leaf", "lattice"], "otherEnglishAnnotationValues": []}, "requiredAction": "Use reviewed Chinese display labels (for example 门框、门扇、格心) while preserving stable English keys only in structured data."},
        {"id": "P1-NORTH-AND-REFERENCE-SEMANTICS", "summary": "The floor plan has no frozen north arrow and section/detail references have no professional sheet-reference semantics.", "evidence": {"floorPlanNorthArrow": False}, "requiredAction": "Freeze north/reference semantics in the DrawingRequirement rather than adding free text during rendering."},
    ]
    p2 = []
    return {"P0": p0, "P1": p1, "P2": p2, "diagnostics": {"rawTargets": raw_targets, "collisions": collisions, "clipped": clipped, "safeRectViolations": safe_violations, "titleBlock": {"dates": issue_dates, "statuses": statuses, "revisions": revisions}}}


CHECKS: list[tuple[str, str, Callable[[SheetBundle], dict]]] = [
    ("SHEET-001", "Official font snapshot, license, static weight-400 instance and glyph closure", verify_font_closure),
    ("SHEET-002", "Contract, IR, font and artifact hash/revision binding", verify_contract_ir_output_binding),
    ("SHEET-003", "Two A1 SVG sheets reverse-match 5+5 IR geometry, materials and annotations", verify_svg_geometry_text),
    ("SHEET-004", "Two-page PDF reverse-matches SVG/IR vectors and searchable embedded-font text", verify_pdf_geometry_text),
    ("SHEET-005", "Two 9933x7016 300dpi PNG sheets rasterize the bound structural geometry", verify_png_geometry),
    ("SHEET-006", "Visible text/glyph and external DWG/path isolation", verify_text_and_external_isolation),
]


def build_report(bundle: SheetBundle, verifier_path: Path) -> dict:
    checks = []
    for check_id, name, function in CHECKS:
        try:
            checks.append({"id": check_id, "name": name, "passed": True, "evidence": function(bundle)})
        except Exception as error:
            checks.append({"id": check_id, "name": name, "passed": False, "error": str(error)})
    findings = professional_findings(bundle)
    failed = [item for item in checks if not item["passed"]]
    rejected = bool(failed or findings["P0"])
    test_evidence_path = bundle.artifact_dir / "sheet-output-verifier-tests.json"
    test_evidence = json.loads(test_evidence_path.read_text(encoding="utf-8")) if test_evidence_path.exists() else None
    review_record_path = bundle.artifact_dir / "independent-review" / "sheet-output-review-record.json"
    review_record = json.loads(review_record_path.read_text(encoding="utf-8")) if review_record_path.exists() else None
    return {
        "schemaVersion": "t0b-v2-sheet-output-verification-1",
        "status": "rejected-cross-format-professional-review" if rejected else "passed-cross-format-professional-review",
        "L1": False,
        "localProfessionalSampleEligible": False,
        "verifier": {"version": VERIFIER_VERSION, "path": verifier_path.name, "sha256": _file_hash(verifier_path), "independent": True, "forbiddenImports": ["generate_sheet_outputs", "drawing_contract", "drawing_ir", "generate_dxf", "font_assets", "view_geometry", "detail_oracle"]},
        "source": {
            "contract": {"sha256": _file_hash(bundle.contract_path), "revisionId": bundle.contract["contractRevisionId"], "signature": bundle.contract["contractSignature"]},
            "ir": {"sha256": _file_hash(bundle.ir_path), "drawingPackageIrSha256": bundle.ir["drawingPackageIrSha256"]},
            "fontManifest": {"sha256": _file_hash(bundle.font_dir / "font-manifest.json"), "sourceCommit": bundle.font_manifest["source"]["commit"], "derivedFontSha256": bundle.font_manifest["sha256"]},
            "artifacts": {path.name: _file_hash(path) for path in sorted(bundle.artifact_dir.iterdir()) if path.is_file() and path.name.startswith("T0B")},
        },
        "summary": {"checks": len(checks), "failedTechnicalChecks": len(failed), "P0": len(findings["P0"]), "P1": len(findings["P1"]), "P2": len(findings["P2"]), "views": 10, "sheets": 2},
        "checks": checks,
        "findings": {"P0": findings["P0"], "P1": findings["P1"], "P2": findings["P2"]},
        "diagnostics": findings["diagnostics"],
        "compatibilityEvidence": {"AutoCAD": "not-rerun-after-contract-p0", "QCAD": "not-rerun-after-contract-p0", "retainedBlocker": "QCAD_LOSSLESS_ROUNDTRIP_UNSUPPORTED"},
        "determinismEvidence": {"status": "not-rerun-after-contract-p0", "canonicalBuildRecordDeterministicClaim": bundle.build_record.get("generatedAt") == "2000-01-01T00:00:00Z"},
        "negativeTestEvidence": ({"path": test_evidence_path.name, "sha256": _file_hash(test_evidence_path), **test_evidence} if test_evidence else {"status": "missing"}),
        "visualReviewEvidence": ({"path": str(review_record_path.relative_to(bundle.artifact_dir)).replace("\\", "/"), "sha256": _file_hash(review_record_path), "status": review_record["status"], "previews": len(review_record["outputs"])} if review_record else {"status": "missing"}),
        "submissionDecision": "reject-and-revise-contract-layout-annotations" if rejected else "accept-cross-format-output-task-only",
        "qualificationBoundary": {"status": "generated-not-qualified", "L1": False, "useBoundary": ["demo-only", "not-for-formal-signoff"], "generatorMaySetEligible": False, "remainingBlockers": bundle.build_record["qualification"]["requiredBlockers"]},
    }


def main() -> int:
    parser = argparse.ArgumentParser(description="Independently verify grouped T0-B SVG/PDF/PNG sheet outputs without importing their generators.")
    parser.add_argument("--root", type=Path, default=Path(__file__).resolve().parents[3])
    parser.add_argument("--report", type=Path)
    args = parser.parse_args()
    root = args.root.resolve()
    bundle = load_bundle(root)
    report = build_report(bundle, Path(__file__).resolve())
    report_path = args.report.resolve() if args.report else bundle.artifact_dir / "sheet-output-verification.json"
    report_path.write_text(json.dumps(report, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    print(json.dumps(report, ensure_ascii=False, indent=2))
    return 0 if report["summary"]["failedTechnicalChecks"] == 0 and not report["findings"]["P0"] else 1


if __name__ == "__main__":
    raise SystemExit(main())
