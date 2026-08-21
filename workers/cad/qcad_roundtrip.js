include("scripts/simple.js");
include("scripts/Tools/arguments.js");

function fail(message) {
    print(JSON.stringify({status: "failed", reason: message}));
}

function main() {
    if (args.length < 3) {
        fail("missing input file");
        return;
    }

    var inFile = args[args.length - 1];
    var outFile = getArgument(args, "-o", "-outfile");
    if (outFile === undefined) {
        fail("missing output file");
        return;
    }
    inFile = getAbsolutePathForArg(inFile);
    outFile = getAbsolutePathForArg(outFile);

    var doc = new RDocument(new RMemoryStorage(), new RSpatialIndexNavel());
    var di = new RDocumentInterface(doc);
    var ioError = di.importFile(inFile);
    if (ioError !== RDocumentInterface.IoErrorNoError) {
        fail("cannot import input: " + ioError);
        return;
    }

    startTransaction(di);
    addLine(-7777, -7777, -7666, -7666);
    endTransaction();

    var regenOperation = new RModifyObjectsOperation();
    var entityIds = doc.queryAllEntities(false, false);
    var regeneratedDimensions = 0;
    for (var i = 0; i < entityIds.length; i++) {
        var entity = doc.queryEntity(entityIds[i]);
        if (!isDimensionEntity(entity)) {
            continue;
        }
        entity.getData().update();
        entity.getData().getShapes();
        regenOperation.addObject(entity, false);
        regeneratedDimensions++;
    }
    if (regeneratedDimensions > 0) {
        di.applyOperation(regenOperation);
    }

    if (!di.exportFile(outFile)) {
        fail("cannot export output");
        return;
    }

    print(JSON.stringify({
        status: "passed",
        input: inFile,
        output: outFile,
        edit: "line:-7777,-7777:-7666,-7666",
        regeneratedDimensions: regeneratedDimensions
    }));
}

if (typeof including === "undefined" || including === false) {
    main();
}
