import { createHash } from "node:crypto";
import { existsSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, "..", "..");
const readJson = (path) => JSON.parse(readFileSync(path, "utf8").replace(/^\uFEFF/, ""));
const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex");
const fileHash = (path) => sha256(readFileSync(path));
const writeJson = (path, value) => writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`, "utf8");

const sourceTablePath = join(root, "验证材料", "07_里程碑一工作台验证", "t0b-81项资产迁移对应表.json");
const sourceTable = readJson(sourceTablePath);
const groupMigration = {
  "root-domain-infrastructure": {
    currentQualification: "里程碑一已迁移；里程碑二扩展后通过回归",
    newModule: "packages/domain、packages/application、packages/infrastructure、apps/workbench",
    modificationReason: "沿用唯一命令写入口、IndexedDB v3 和项目包，在同一真源增加几何、成果、检查与交付记录",
    tests: ["pnpm run check", "项目 JSON/ZIP 空库回导", "回导后继续生成新版本"],
    commits: ["83465c2", "T10 待提交"],
  },
  "v2-font": {
    currentQualification: "通用字体资产已在 T9 复用；旧工作区副本仍受 T0b 保护",
    newModule: "workers/cad/project_drawings/assets/fonts/noto-sans-sc",
    modificationReason: "复用许可、语料、派生字体和哈希闭包，生成端不读取外部 DWG 字体",
    tests: ["T9 字体覆盖测试", "PDF/SVG 中文反向检查", "AutoCAD 隔离字体检查"],
    commits: ["54515ee"],
  },
  "v2-code-tests": {
    currentQualification: "已审查后抽取通用能力；旧固定合同与失败代码保留为迁移参照",
    newModule: "workers/cad/project_drawings",
    modificationReason: "迁移原生 DXF、Drawing IR、跨格式、来源映射和攻击验证，移除固定项目、视图、布局、标题和日期",
    tests: ["两种成果矩阵契约测试", "动态布局", "跨格式与原生对象测试", "T10 AutoCAD/QCAD 检查"],
    commits: ["54515ee", "T10 待提交"],
  },
  "v3-source-fixture": {
    currentQualification: "T8a 技术重验并由 T8b 抽取通用几何能力；demo 仍 L1=false",
    newModule: "workers/cad/project_geometry、packages/domain/src/geometry.ts",
    modificationReason: "保留稳定 ID、接口与验证思想；修复单位、未知项、资格越权和固定数量，运行时改由 GeometrySpec 驱动",
    tests: ["T8a demo 重验", "T8b 两套 GeometrySpec", "接触/搭接/剖切/哈希攻击负例"],
    commits: ["0b1c65d", "0227ef3"],
  },
  "v2-ir-contract": {
    currentQualification: "旧固定 IR 失败证据保留；通用 IR 能力在 T9 重新实现并用于 T10 当前成果",
    newModule: "packages/domain/src/drawings.ts、workers/cad/project_drawings",
    modificationReason: "不覆盖旧报告；新 IR 由当前任务要求和当前 GeometryRevision 生成",
    tests: ["T9 两种目录/布局", "T10 当前 GeometryRevision 来源闭包"],
    commits: ["54515ee", "T10 待提交"],
  },
  "v2-sheet-artifacts": {
    currentQualification: "历史拒绝证据原样保留；不作为新成果，T10 另生成新的代理图纸",
    newModule: "历史证据：T0b 快照；新成果：apps/server/.data/acceptance/milestone-two/t10-habs",
    modificationReason: "旧成果含专业 P0，不能改名冒充；新成果只复用已审查的生成能力并绑定当前 GeometryRevision",
    tests: ["旧哈希与失败原因保留", "T10 跨格式清单和浏览器预览"],
    commits: ["54515ee", "T10 待提交"],
  },
  "v2-native-dxf": {
    currentQualification: "历史 DXF/QCAD 失败证据保留；T10 规范 DXF 为新文件且仍是代理成果",
    newModule: "workers/cad/project_drawings/dxf_writer.py",
    modificationReason: "复用原生对象与来源追踪；当前 DXF 重新生成并重新执行 AutoCAD、QCAD 检查",
    tests: ["ezdxf audit 0/0", "AutoCAD 2024 Core Console 0 错误/0 修复/0 删除", "QCAD 仅打开/查看/打印"],
    commits: ["54515ee", "T10 待提交"],
  },
  "v3-generated-outputs": {
    currentQualification: "历史 881/24 为 superseded；过期 prefreeze 报告为 invalidated；新成果不覆盖旧文件",
    newModule: "历史证据：T0b 快照；新输出：T8a 受控验收目录与 T10 项目成果目录",
    modificationReason: "只保留失败与失效证据的原版本和哈希；新 GeometryRevision 独立生成",
    tests: ["T8a 当前哈希链", "旧报告失效扫描", "T10 成果哈希清单"],
    commits: ["0b1c65d", "T10 待提交"],
  },
};

const assets = sourceTable.assets.map((asset) => {
  const migration = groupMigration[asset.source.group];
  if (!migration) throw new Error(`UNMAPPED_GROUP:${asset.source.group}`);
  return {
    ...asset,
    milestoneTwo: {
      reviewConclusion: migration.currentQualification,
      newModule: migration.newModule,
      modificationReason: migration.modificationReason,
      tests: migration.tests,
      commits: migration.commits,
      currentQualification: asset.source.qualificationBoundary,
      t0bRecoveryProtected: true,
      originalHashRetained: true,
    },
  };
});
if (assets.length !== 81) throw new Error(`ASSET_COUNT:${assets.length}`);

writeJson(join(here, "t0b-81项资产里程碑二迁移对应表.json"), {
  schemaVersion: "2.0",
  generatedAt: new Date().toISOString(),
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

const acceptanceRoot = join(root, "apps", "server", ".data", "acceptance", "milestone-two", "t10-habs");
const artifactRows = [];
const collectArtifacts = (directory) => {
  for (const entry of readdirSync(directory, { withFileTypes: true }).sort((left, right) => left.name.localeCompare(right.name))) {
    const fullPath = join(directory, entry.name);
    if (entry.isDirectory()) collectArtifacts(fullPath);
    else if (entry.name !== "artifact-sha256-manifest.json") artifactRows.push({
      path: relative(acceptanceRoot, fullPath).replaceAll("\\", "/"),
      sha256: fileHash(fullPath),
      byteLength: statSync(fullPath).size,
    });
  }
};
collectArtifacts(acceptanceRoot);
const artifactManifest = {
  schemaVersion: "2.0",
  qualification: "generated-not-qualified",
  l1Eligible: false,
  formalEligibility: false,
  sourceProjectId: "ab103b54-3fd2-4124-8fd0-72f478d6ead0",
  includesSourceAndPostRoundtripVersions: true,
  files: artifactRows,
};
writeJson(join(acceptanceRoot, "artifact-sha256-manifest.json"), artifactManifest);
writeJson(join(here, "artifact-sha256-manifest.json"), artifactManifest);

const run = readJson(join(here, "habs-kimi-real-run.json"));
writeJson(join(here, "habs-end-to-end-record.json"), {
  schemaVersion: "1.0",
  status: "completed-proxy-path",
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
    sourceGeometryVersion: "geometry-source-version",
    postRoundtripGeometryVersion: "geometry-post-roundtrip-version",
    postRoundtripCurrentDrawings: "drawings-post-roundtrip-current",
    latestProjectRevisionPrefix: "657c2a4e",
    latestDeliveryDraftPrefix: "a7e1ce78",
    sourceFilesImported: 23,
    currentArtifactFiles: 32,
  },
  roundtrip: {
    json: "空库恢复结构化记录，二进制明确为 missing",
    zip: "空库恢复真实文件、运行、决定、GeometryRevision、成果、检查、交付与审计关系",
    continuedAfterImport: "已生成新的 GeometryRevision、成组图纸和代理交付草案",
  },
  blockers: ["PROFESSIONAL_REVIEW_REQUIRED", "FORMAL_SIGNOFF_UNAVAILABLE", "L1_ELIGIBILITY_FALSE"],
});

console.log(JSON.stringify({ assetCount: assets.length, output: here, acceptanceRootExists: existsSync(acceptanceRoot) }, null, 2));
