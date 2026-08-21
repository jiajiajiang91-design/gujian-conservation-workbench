import { createHash } from "node:crypto";
import { existsSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, "..", "..");
const sourcePath = join(root, "验证材料", "07_T0b资产保全", "t0b-classified-asset-inventory.json");
const outputPath = join(here, "t0b-81项资产迁移对应表.json");
const sourceBytes = readFileSync(sourcePath);
const source = JSON.parse(sourceBytes.toString("utf8").replace(/^\uFEFF/, ""));

const mappings = {
  "root-domain-infrastructure": {
    milestone: "里程碑一（T2/T3/T4/T5/T7）",
    status: "migrated-reworked-tested",
    target: "根级 pnpm 工作区、packages/domain、packages/application、packages/infrastructure 与 IndexedDB v3",
    evidenceCommits: ["d194c2b", "fe245ca", "f27db50", "a5d9847", "37d2e94"],
    note: "没有原样提交半成品；按架构补齐源码、锁文件、命令入口、存储、迁移和测试后迁入。",
  },
  "v2-code-tests": {
    milestone: "T9",
    status: "deferred-preserved",
    target: "TaskDefinition 与 ArtifactRequirementMatrix 驱动的通用制图管线",
    evidenceCommits: [],
    note: "保留 IR、原生 DXF、跨格式、来源映射和攻击验证；后续去除固定视图、布局、标题和日期。",
  },
  "v2-font": {
    milestone: "T9",
    status: "deferred-preserved",
    target: "可复算的中文字体闭包与 Release 资产",
    evidenceCommits: ["b03ac05"],
    note: "官方 Noto Sans SC、OFL.txt、METADATA.pb 已保留；派生脚本、语料、manifest、测试后续迁移，可重建 TTF 不进入当前里程碑。",
  },
  "v2-ir-contract": {
    milestone: "T9 历史输入",
    status: "historical-failure-preserved",
    target: "失败证据与迁移参照，不作为当前成果",
    evidenceCommits: ["dca5720"],
    note: "绑定旧 v2 revision 和固定布局，保持 rejected/generated-not-qualified/L1=false。",
  },
  "v2-native-dxf": {
    milestone: "T9 历史审计",
    status: "historical-failure-preserved",
    target: "旧 DXF、AutoCAD/QCAD 失败证据与恢复快照",
    evidenceCommits: ["dca5720"],
    note: "不属于当前工作台数据链；删除状态仅由 T0b 恢复包保全，未经通知不移入回收站。",
  },
  "v2-sheet-artifacts": {
    milestone: "T9 历史审计",
    status: "historical-failure-preserved",
    target: "被专业审查拒绝的 SVG/PDF/PNG 与报告",
    evidenceCommits: ["dca5720"],
    note: "保留拒绝结论、版本和哈希，不作为合格作品或真实功能证明。",
  },
  "v3-generated-outputs": {
    milestone: "T8a 历史审计",
    status: "historical-failure-preserved",
    target: "旧 geometry 与 prefreeze 失效证据",
    evidenceCommits: ["dca5720"],
    note: "881/24 旧输出与 886/2118 过期报告分别保持 superseded/invalidated，不与后续 GeometryRevision 混用。",
  },
  "v3-source-fixture": {
    milestone: "T8a/T8b",
    status: "deferred-preserved",
    target: "保全 demo 后抽取由 GeometrySpec 驱动的无固定形制几何内核",
    evidenceCommits: [],
    note: "稳定 ID、几何原语、接口和攻击验证可复用；固定形制、计数和过度资格声明必须在 T8 修正。",
  },
};

const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex");
const assets = source.assets.map((asset, index) => {
  const mapping = mappings[asset.group];
  if (!mapping) throw new Error(`UNMAPPED_GROUP:${asset.group}`);
  const currentPath = join(root, ...asset.path.split("/"));
  const present = existsSync(currentPath) && statSync(currentPath).isFile();
  const currentSha256 = present ? sha256(readFileSync(currentPath)) : null;
  return {
    inventoryIndex: index + 1,
    source: {
      path: asset.path,
      statusAtT0b: asset.status,
      kind: asset.kind,
      sizeBytes: asset.sizeBytes,
      sha256: asset.sha256,
      headBlob: asset.headBlob,
      group: asset.group,
      category: asset.category,
      reason: asset.reason,
      qualificationBoundary: asset.qualificationBoundary,
    },
    currentEvidence: {
      fileState: present ? "present" : "absent-preserved-in-t0b-recovery-snapshot",
      sha256: currentSha256,
      matchesT0bSnapshot: currentSha256 === asset.sha256,
    },
    migration: mapping,
  };
});

if (assets.length !== 81) throw new Error(`ASSET_COUNT_MISMATCH:${assets.length}`);
if (new Set(assets.map((asset) => asset.source.path)).size !== 81) throw new Error("DUPLICATE_ASSET_PATH");

const counts = Object.fromEntries(
  Object.entries(assets.reduce((acc, asset) => {
    acc[asset.migration.status] = (acc[asset.migration.status] ?? 0) + 1;
    return acc;
  }, {})).sort(([left], [right]) => left.localeCompare(right)),
);
const output = {
  schemaVersion: 1,
  generatedAt: new Date().toISOString(),
  sourceInventory: {
    path: "验证材料/07_T0b资产保全/t0b-classified-asset-inventory.json",
    sha256: sha256(sourceBytes),
    declaredAssetCount: source.assetCount,
  },
  milestone: "里程碑一：可运行的项目与 AI 工作台",
  constraints: {
    t0bRecoverySnapshotRetained: true,
    historicalFailureEvidenceRetained: true,
    externalDwgUsedAsDependency: false,
    cadOrGeometryAssetsModifiedByMilestoneOne: false,
  },
  statusCounts: counts,
  assets,
};
writeFileSync(outputPath, `${JSON.stringify(output, null, 2)}\n`, "utf8");
console.log(JSON.stringify({ outputPath, assetCount: assets.length, statusCounts: counts }, null, 2));
