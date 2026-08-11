include("scripts/library.js");

function classifyEntity(entity) {
    if (typeof isLineEntity !== "undefined" && isLineEntity(entity)) {
        return "LINE";
    }
    if (typeof isPolylineEntity !== "undefined" && isPolylineEntity(entity)) {
        return "POLYLINE";
    }
    if (typeof isHatchEntity !== "undefined" && isHatchEntity(entity)) {
        return "HATCH";
    }
    if (typeof isDimensionEntity !== "undefined" && isDimensionEntity(entity)) {
        return "DIMENSION";
    }
    if (typeof isTextEntity !== "undefined" && isTextEntity(entity)) {
        return "TEXT";
    }
    if (typeof isBlockReferenceEntity !== "undefined" && isBlockReferenceEntity(entity)) {
        return "BLOCK_REFERENCE";
    }
    return "OTHER:" + entity.getType();
}

function countEntities(document) {
    var counts = {};
    var ids = document.queryAllEntities();
    for (var i = 0; i < ids.length; i++) {
        var entity = document.queryEntity(ids[i]);
        var kind = classifyEntity(entity);
        counts[kind] = (counts[kind] || 0) + 1;
    }
    return { total: ids.length, byQcadKind: counts };
}

function addRoundtripMarker(documentInterface, document) {
    var layerName = "GJ-QCAD-ROUNDTRIP-TEST";
    var layerOperation = new RModifyObjectsOperation();
    var layer = new RLayer(
        document,
        layerName,
        false,
        false,
        new RColor("magenta"),
        document.getLinetypeId("CONTINUOUS"),
        RLineweight.Weight025
    );
    layerOperation.addObject(layer);
    documentInterface.applyOperation(layerOperation);

    var marker = new RLineEntity(
        document,
        new RLineData(new RVector(-50000, -50000), new RVector(-49990, -50000))
    );
    marker.setLayerId(document.getLayerId(layerName));
    marker.setCustomProperty("QCAD_RT_TEST", "marker", "non-structural-roundtrip");
    var markerOperation = new RAddObjectsOperation();
    markerOperation.addObject(marker);
    documentInterface.applyOperation(markerOperation);
    return layerName;
}

function main() {
    var result = {
        schemaVersion: "t0b-v2-qcad-roundtrip-runtime-1",
        status: "failed",
        importSucceeded: false,
        exportSucceeded: false,
        xdataRequested: true,
        outputRelease: "R32 (2018) DXF"
    };
    try {
        if (args.length < 3) {
            throw new Error("input and output arguments are required");
        }
        var inputFile = args[args.length - 2];
        var outputFile = args[args.length - 1];
        var storage = new RMemoryStorage();
        var spatialIndex = new RSpatialIndexSimple();
        var document = new RDocument(storage, spatialIndex);
        var documentInterface = new RDocumentInterface(document);
        var importCode = documentInterface.importFile(inputFile);
        result.importCode = importCode;
        if (importCode !== RDocumentInterface.IoErrorNoError) {
            throw new Error("QCAD import failed with code " + importCode);
        }
        result.importSucceeded = true;
        result.documentUnit = document.getUnit();
        result.before = countEntities(document);
        result.markerLayer = addRoundtripMarker(documentInterface, document);
        result.afterMarker = countEntities(document);
        result.exportSucceeded = documentInterface.exportFile(outputFile, "R32 (2018) DXF");
        if (!result.exportSucceeded) {
            throw new Error("QCAD export failed");
        }
        result.status = "passed-runtime-only";
    }
    catch (error) {
        result.error = String(error);
    }
    print("QCAD_RESULT=" + JSON.stringify(result));
}

main();
