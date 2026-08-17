import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, "..", "..");
const readJson = (path) => JSON.parse(readFileSync(path, "utf8").replace(/^\uFEFF/, ""));
const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex");
const fileHash = (path) => sha256(readFileSync(path));
const writeJson = (path, value) => writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`, "utf8");

const commitIds = {
  milestoneOne: "83465c2c16bd5fba9323975c60f827c78bd7e510",
  t8a: "0b1c65df634ffd3cbc78d8c6556a258946c3a7ca",
  t8b: "0227ef3bae33162a2e863da26682917aa82284d1",
  t9: "54515ee27523aed57be179f3177c59dec4d6d904",
  t9a: "1acda7f8dcfb28e5484db57bc64b15a31c1d8a75",
  t10Baseline: "f3759600e2e082c11d623fb2c3fa81d1c6d8ea89",
  p0GeometryAndDelivery: "0e81be00ca1572c2350e8271fbda7f32fcfcffcf",
  p0MatrixAndCadAudit: "0fa42f2d89ec2bc4262e1b94e31c78c9678fe82b",
};

const resolveCommit = (commit) => execFileSync("git", ["rev-parse", `${commit}^{commit}`], {
  cwd: root,
  encoding: "utf8",
}).trim();

const commitRegistry = Object.fromEntries(Object.entries(commitIds).map(([key, commit]) => {
  const actual = resolveCommit(commit);
  if (actual !== commit) throw new Error(`COMMIT_MISMATCH:${key}:${actual}`);
  const subject = execFileSync("git", ["show", "-s", "--format=%s", commit], {
    cwd: root,
    encoding: "utf8",
  }).trim();
  return [key, { commit, subject }];
}));

const sourceTablePath = join(root, "验证材料", "07_里程碑一工作台验证", "t0b-81项资产迁移对应表.json");
const sourceTable = readJson(sourceTablePath);
const commonCommits = [
  commitIds.milestoneOne,
  commitIds.t8a,
  commitIds.t8b,
  commitIds.t9,
  commitIds.t9a,
  commitIds.t10Baseline,
  commitIds.p0GeometryAndDelivery,
  commitIds.p0MatrixAndCadAudit,
];

const groupMigration = {
  "root-domain-infrastructure": {
    reviewConclusion: "里程碑一已迁移，里程碑二在同一命令与项目库中扩展成果链。",
    newModule: "packages/domain、packages/application、packages/infrastructure、apps/workbench",
    modificationReason: "沿用唯一命令写入口和 IndexedDB，新增几何、制图、检查、交付及成果要求矩阵持久化。",
    tests: ["pnpm run check", "JSON/ZIP 空库回导", "回导后继续生成新版本"],
  },
  "v2-font": {
    reviewConclusion: "许可、上游元数据、派生字体和字形验证已复用；旧副本继续受 T0b 保护。",
    newModule: "workers/cad/project_drawings/assets/fonts/noto-sans-sc",
    modificationReason: "复用字体许可与字形闭包，生成端不读取系统字体或外部 DWG 字体。",
    tests: ["字体许可与哈希闭包", "PDF/SVG 中文反向检查", "AutoCAD 隔离字体检查"],
  },
  "v2-code-tests": {
    reviewConclusion: "Drawing IR、原生 DXF、跨格式和攻击验证通用能力已迁移；固定样例逻辑未进入新运行时。",
    newModule: "workers/cad/project_drawings",
    modificationReason: "改为由 ArtifactRequirementMatrix 与当前 GeometryRevision 驱动。",
    tests: ["两种成果矩阵", "真实剖切与遮挡", "原生 CAD 对象", "攻击负例"],
  },
  "v3-source-fixture": {
    reviewConclusion: "T8a 保全 demo，T8b 只抽取稳定 ID、界面、几何与验证能力；demo 仍为 L1=false。",
    newModule: "workers/cad/project_geometry、packages/domain/src/geometry.ts",
    modificationReason: "修复单位、未知项和资格越权，运行时改由 GeometrySpec 驱动。",
    tests: ["T8a demo 重验", "两套 GeometrySpec", "接触、搭接、剖切及哈希攻击负例"],
  },
  "v2-ir-contract": {
    reviewConclusion: "旧固定 IR 作为历史证据保留，通用 IR 能力已在 T9 迁移。",
    newModule: "packages/domain/src/drawings.ts、workers/cad/project_drawings",
    modificationReason: "新 IR 由当前任务要求和 GeometryRevision 生成，不覆盖旧失败报告。",
    tests: ["动态目录与布局", "结构线来源闭包", "跨格式哈希闭包"],
  },
  "v2-sheet-artifacts": {
    reviewConclusion: "旧跨格式成果继续作为失败证据；新成果从当前项目与修订重新生成。",
    newModule: "apps/server/.data/acceptance/milestone-two/habs-final-drawings",
    modificationReason: "只迁移已验证生成能力，当前成果独立记录哈希与资格限制。",
    tests: ["动态成组图纸", "来源与资格说明", "跨格式验证"],
  },
  "v2-native-dxf": {
    reviewConclusion: "旧 DXF/QCAD 失败记录保留；当前规范 DXF 已重新生成和复核。",
    newModule: "workers/cad/project_drawings/dxf_writer.py",
    modificationReason: "复用原生对象和来源追踪，按当前 GeometryRevision 重建。",
    tests: ["ezdxf audit", "AutoCAD 2024 AUDIT", "QCAD 仅打开、查看和打印"],
  },
  "v3-generated-outputs": {
    reviewConclusion: "旧 881/24 输出标为 superseded，过期 prefreeze 报告标为 invalidated；新输出使用独立目录。",
    newModule: "T8a 历史证据、apps/server/.data/acceptance/milestone-two/habs-current-geometry",
    modificationReason: "保留原哈希和失败原因，新 GeometryRevision 不覆盖旧文件。",
    tests: ["旧报告失效扫描", "新几何闭包", "大型成果 SHA-256 清单"],
  },
};

const assets = sourceTable.assets.map((asset) => {
  const migration = groupMigration[asset.source.group];
  if (!migration) throw new Error(`UNMAPPED_GROUP:${asset.source.group}`);
  return {
    ...asset,
    milestoneTwo: {
      ...migration,
      commits: commonCommits,
      sourceMigrationCommits: asset.migration.evidenceCommits.map(resolveCommit),
      currentQualification: asset.source.qualificationBoundary,
      t0bRecoveryProtected: true,
      originalHashRetained: true,
    },
  };
});
if (assets.length !== 81) throw new Error(`ASSET_COUNT:${assets.length}`);

writeJson(join(here, "t0b-81项资产里程碑二迁移对应表.json"), {
  schemaVersion: "2.0",
  generatedAt: "2026-08-14T00:00:00.000Z",
  commitRegistry,
  sourceTable: {
    path: relative(root, sourceTablePath).replaceAll("\\", "/"),
    sha256: fileHash(sourceTablePath),
    assetCount: assets.length,
  },
  protections: {
    recoverySnapshot: "归档/recovery/2026-08-13-pre-t0b",
    recoverySnapshotDeleted: false,
    rawDirtyAssetsDeleted: false,
    historicalFailureEvidenceDeleted: false,
    externalDwgGenerationDependency: false,
  },
  assets,
});

const acceptanceRoot = join(root, "apps", "server", ".data", "acceptance", "milestone-two");
const acceptedArtifactRoots = ["habs-current-geometry", "habs-final-drawings"];
const artifactRows = [];
const collectArtifacts = (directory) => {
  for (const entry of readdirSync(directory, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
    const fullPath = join(directory, entry.name);
    if (entry.isDirectory()) collectArtifacts(fullPath);
    else artifactRows.push({
      path: relative(acceptanceRoot, fullPath).replaceAll("\\", "/"),
      sha256: fileHash(fullPath),
      byteLength: statSync(fullPath).size,
    });
  }
};
for (const artifactRoot of acceptedArtifactRoots) {
  const fullPath = join(acceptanceRoot, artifactRoot);
  if (!existsSync(fullPath)) throw new Error(`MISSING_ACCEPTANCE_ROOT:${artifactRoot}`);
  collectArtifacts(fullPath);
}

writeJson(join(here, "artifact-sha256-manifest.json"), {
  schemaVersion: "2.0",
  status: "passed-engineering-proxy-chain-with-professional-limitations",
  qualification: "generated-not-qualified",
  l1Eligible: false,
  formalEligibility: false,
  sourceProjectId: "ab103b54-3fd2-4124-8fd0-72f478d6ead0",
  geometryRevisionId: "7fb78654-d45c-57f2-aeb5-cdb27d893fdb",
  acceptedArtifactRoots,
  largeArtifactsTrackedInGit: false,
  p0FixCommits: [commitIds.p0GeometryAndDelivery, commitIds.p0MatrixAndCadAudit],
  files: artifactRows,
});

const run = readJson(join(here, "habs-kimi-real-run.json"));
writeJson(join(here, "habs-end-to-end-record.json"), {
  schemaVersion: "2.0",
  status: "passed-engineering-proxy-chain-with-professional-limitations",
  qualification: "generated-not-qualified",
  l1Eligible: false,
  formalEligibility: false,
  projectId: run.run.project_id,
  realModelRun: {
    runId: run.run.run_id,
    projectRevisionId: run.run.project_revision_id,
    inputHash: run.run.input_hash,
    provider: run.run.provider,
    model: run.run.model,
    status: run.run.status,
    attempt: 1,
    outputHash: run.run.output_hash,
    usage: JSON.parse(run.run.usage_json),
    eventCount: run.eventCount,
    eventTypeCounts: run.eventTypeCounts,
  },
  browserEvidence: {
    currentGeometryRevisionId: "7fb78654-d45c-57f2-aeb5-cdb27d893fdb",
    currentGeometryEvidence: "screenshots-p0/01_HABS证据绑定三维模型.png",
    currentDrawingsEvidence: "screenshots-p0/02_HABS动态成组图纸.png",
    deliveryEvidence: "screenshots-p0/03_HABS代理交付_限制传播.png",
    jsonZipRoundtripEvidence: "screenshots-p0/04_HABS_JSON_ZIP空库回导.png",
    continuedAfterImportEvidence: "screenshots-p0/05_HABS回导后新版本与交付.png",
    gaoduBlockedEvidence: "screenshots-p0/06_高都4400冲突与交付阻断.png",
    sourceFilesImported: 23,
    currentGeneratedArtifactFiles: artifactRows.length,
  },
  validityBoundary: {
    modelRun: "valid",
    sourceAndLicenseRecords: "valid",
    jsonZipStructuralRoundtrip: "valid",
    geometryRevision: "technical-verification-passed-generated-not-qualified",
    drawings: "technical-verification-passed-generated-not-qualified",
    deliveryDraft: "proxy-only-with-open-blockers",
    professionalQualification: "not-granted",
    historicalFailedGeometryAndDrawings: "retained-as-invalidated-evidence",
  },
  roundtrip: {
    json: "空库恢复结构化记录；未携带的二进制明确标记为 missing。",
    zip: "空库恢复真实文件、运行、决定、GeometryRevision、成果要求矩阵、成果、检查、交付与审计关系。",
    continuedAfterImport: "回导后生成新的 GeometryRevision、成果要求矩阵、图纸、检查和代理交付草案。",
  },
  blockers: [
    "PROFESSIONAL_REVIEW_REQUIRED",
    "FORMAL_SIGNOFF_UNAVAILABLE",
    "FIELD_NOTES_NOT_DIGITIZED",
    "L1_ELIGIBILITY_FALSE",
  ],
  verificationRefs: {
    geometry: "habs-current-geometry-verification.json",
    drawings: "habs-current-drawing-verification.json",
    autocad: "habs-current-autocad-audit-summary.json",
    qcad: "habs-current-qcad-compatibility-summary.json",
    gaoduBoundary: "gaodu-redacted-ledger.json",
    technicalAudit: "独立技术审查.md",
    heritageAudit: "独立古建专业审查.md",
  },
});

console.log(JSON.stringify({
  assetCount: assets.length,
  artifactCount: artifactRows.length,
  artifactBytes: artifactRows.reduce((total, row) => total + row.byteLength, 0),
  output: here,
}, null, 2));
