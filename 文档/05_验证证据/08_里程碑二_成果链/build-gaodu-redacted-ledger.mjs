import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, "..", "..");
const sha256 = (value) => createHash("sha256").update(value).digest("hex");
const canonical = (value) => Array.isArray(value)
  ? value.map(canonical)
  : value && typeof value === "object"
    ? Object.fromEntries(Object.entries(value).sort(([a], [b]) => a.localeCompare(b)).map(([key, item]) => [key, canonical(item)]))
    : value;
const canonicalHash = (value) => sha256(JSON.stringify(canonical(value)));

const sourceDirectory = join(root, "验证材料", "02_PoC工作流验证", "盲测素材");
const sourceFiles = [
  "高都玉皇庙_01.jpg",
  "高都玉皇庙_02.jpg",
  "高都玉皇庙_04.jpg",
  "高都玉皇庙_05.jpg",
];

const assets = sourceFiles.map((fileName) => {
  const fullPath = join(sourceDirectory, fileName);
  const bytes = readFileSync(fullPath);
  const contentHash = sha256(bytes);
  return {
    redactedAssetId: `asset-${contentHash.slice(0, 16)}`,
    contentHash,
    byteLength: bytes.byteLength,
    mimeType: "image/jpeg",
    sourceScope: "gaodu-only",
    relativeSource: relative(root, fullPath).replaceAll("\\", "/"),
  };
});

const evidences = assets.map((asset, index) => {
  const row = {
    redactedEvidenceId: `evidence-${index + 1}`,
    assetHash: asset.contentHash,
    evidenceType: index === 1 ? "designation-stele-photo" : "building-photo",
    dataStatus: "available",
    producerType: "human-catalogue",
    sourceScope: "gaodu-only",
    supportedFields: ["visual-observation", "asset-identity"],
    explicitlyDoesNotSupport: ["overallWidthMm", "bayWidthsMm", "measurementMetadata"],
  };
  return { ...row, recordHash: canonicalHash(row) };
});

const facts = [
  {
    redactedFactId: "candidate-overall-width",
    field: "historicalDemoCandidate.overallWidthMm",
    value: 15800,
    unit: "mm",
    evidenceRefs: [],
    producerType: "demo",
    dataStatus: "unverified",
    sourceStatus: "original-registration-record-unavailable",
    blocksProxyOutcome: true,
    blocksFormalEligibility: true,
  },
  {
    redactedFactId: "candidate-bay-chain",
    field: "historicalDemoCandidate.bayWidthsMm",
    value: [4200, 3600, 3600],
    unit: "mm",
    evidenceRefs: [],
    producerType: "demo",
    dataStatus: "unverified",
    sourceStatus: "original-registration-record-unavailable",
    blocksProxyOutcome: true,
    blocksFormalEligibility: true,
  },
].map((row) => ({ ...row, recordHash: canonicalHash(row) }));

const rule = {
  redactedRuleRunId: "rule-demo-dimension-chain",
  ruleId: "historical-demo-dimension-chain-conflict",
  inputs: facts.map((item) => item.redactedFactId),
  calculation: { candidateTotalMm: 15800, candidateSegmentSumMm: 11400, differenceMm: 4400 },
  outcome: "demonstration-only",
  producerType: "rule",
  qualificationBoundary: "输入均为未核验 demo 候选；4400 mm 仅用于展示规则和阻断流程，不是现场事实结论。",
};
const ruleWithHash = { ...rule, recordHash: canonicalHash(rule) };

const delivery = {
  redactedDeliveryEvaluationId: "delivery-gaodu-blocked",
  outcome: "blocked",
  blockerCodes: [
    "UNVERIFIED_DIMENSION_CANDIDATES",
    "MEASUREMENT_METADATA_MISSING",
    "GEOMETRY_EVIDENCE_FACTS_MISSING",
  ],
  artifactRefs: [],
  formalEligibility: false,
  l1Eligible: false,
  producerType: "rule",
};
const deliveryWithHash = { ...delivery, recordHash: canonicalHash(delivery) };

const scanPayload = JSON.stringify({ assets, evidences, facts, rule: ruleWithHash, delivery: deliveryWithHash });
const prohibited = ["HABS", "Badin", "Dai Loy", "东呈", "南禅寺", "team-demo-geometry", "t0b_v3", "gaodu.proxy-input"];
const contaminationMatches = prohibited.filter((token) => scanPayload.includes(token));

const ledger = {
  schemaVersion: "2.0",
  qualification: "blocked-source-boundary-evidence",
  sourceScope: "gaodu-only",
  assets,
  evidences,
  facts,
  ruleRuns: [ruleWithHash],
  deliveryEvaluations: [deliveryWithHash],
  factualBoundary: {
    photoSupportedExactDimensions: 0,
    verifiedMeasurementFacts: 0,
    historicalDemoCandidates: 2,
    geometryRevisionCount: 0,
    completeArtifactCount: 0,
  },
  crossContaminationScan: {
    prohibitedTokens: prohibited,
    matches: contaminationMatches,
    passed: contaminationMatches.length === 0,
    scannedRecordHash: sha256(scanPayload),
  },
};

writeFileSync(join(here, "gaodu-redacted-ledger.json"), `${JSON.stringify(ledger, null, 2)}\n`, "utf8");
console.log(JSON.stringify({
  assets: assets.length,
  evidences: evidences.length,
  verifiedFacts: 0,
  demoCandidates: facts.length,
  scanPassed: contaminationMatches.length === 0,
}, null, 2));
