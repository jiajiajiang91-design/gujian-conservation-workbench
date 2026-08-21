import { ProjectCommandService } from "@gujian/application";
import {
  AuditEventSchema,
  AssetRecordSchema,
  ProjectRevisionSchema,
  ProjectSnapshotSchema,
  ModelRunSchema,
  RuleRunSchema,
  DecisionSchema,
  CadJobSchema,
  ArtifactRecordSchema,
  ArtifactRequirementMatrixSchema,
  CheckRunSchema,
  DeliveryEvaluationSchema,
  DeliveryDraftSchema,
  ConceptEntrySchema,
  Sha256Schema,
  UuidSchema,
  type AuditEvent,
} from "@gujian/domain";
import { strFromU8, strToU8, unzipSync, zipSync } from "fflate";
import { z } from "zod";

import { canonicalJson, recordHash, sha256Hex } from "./hash.js";
import { IndexedDbProjectRepository, LocalAuthorization } from "./indexeddb-project-repository.js";
import { resolveVocabulary } from "./vocabulary-resolver.js";

// Large evidence packages can contain high-resolution image masters. Keep
// per-entry and expanded-size limits strict while preserving complete sources.
// The evidence-bound HABS benchmark contains a native DXF above 120 MiB and
// preserves earlier generated revisions for audit. Limits therefore cover the
// largest verified project while still bounding every entry and expansion.
const MAX_ARCHIVE_BYTES = 640 * 1024 * 1024;
const MAX_ENTRY_BYTES = 192 * 1024 * 1024;
const MAX_TOTAL_BYTES = 1024 * 1024 * 1024;
const MAX_ENTRY_COUNT = 1_000;

const ProjectDataSchema = z.object({
  format: z.literal("gujian-project-package"),
  packageVersion: z.literal(1),
  sourceRevision: ProjectRevisionSchema,
  auditHeadHash: Sha256Schema,
  snapshot: ProjectSnapshotSchema,
  auditEvents: z.array(AuditEventSchema).max(100_000),
  modelRuns: z.array(ModelRunSchema).max(100_000).default([]),
  ruleRuns: z.array(RuleRunSchema).max(100_000).default([]),
  decisions: z.array(DecisionSchema).max(100_000).default([]),
  cadJobs: z.array(CadJobSchema).max(100_000).default([]),
  artifactRequirementMatrices: z.array(ArtifactRequirementMatrixSchema).max(100_000).default([]),
  artifacts: z.array(ArtifactRecordSchema).max(100_000).default([]),
  checkRuns: z.array(CheckRunSchema).max(100_000).default([]),
  deliveryEvaluations: z.array(DeliveryEvaluationSchema).max(100_000).default([]),
  deliveries: z.array(DeliveryDraftSchema).max(100_000).default([]),
  // v1.4：项目引用的词表条目快照；旧包缺省为空按原格式兼容导入
  conceptEntries: z.array(ConceptEntrySchema).max(2_000).default([]),
  assets: z.array(AssetRecordSchema.extend({
    path: z.string().min(1).max(500),
  }).strict()).max(MAX_ENTRY_COUNT),
}).strict();

const ManifestSchema = z.object({
  format: z.literal("gujian-project-package"),
  packageVersion: z.literal(1),
  projectId: UuidSchema,
  sourceRevisionId: UuidSchema,
  files: z.array(z.object({
    path: z.string().min(1).max(500),
    sha256: Sha256Schema,
    size: z.number().int().nonnegative(),
    mimeType: z.string().min(1).max(200),
  }).strict()).min(2).max(MAX_ENTRY_COUNT),
}).strict();

export type ProjectData = z.infer<typeof ProjectDataSchema>;

function safePath(path: string): boolean {
  if (!path || path.includes("\\") || path.startsWith("/") || /^[A-Za-z]:/.test(path)) return false;
  const segments = path.split("/");
  return segments.every((segment) => segment && segment !== "." && segment !== ".." && !/[\0-\x1f]/.test(segment));
}

function validateAudit(events: readonly AuditEvent[], headHash: string): void {
  let previous: string | null = null;
  for (const event of events) {
    if (event.previousEventHash !== previous) throw new Error("AUDIT_CHAIN_BROKEN");
    const { eventHash, recordHash: _recordHash, ...base } = event;
    if (recordHash(base) !== eventHash) throw new Error("AUDIT_EVENT_HASH_MISMATCH");
    previous = eventHash;
  }
  if (previous !== headHash) throw new Error("AUDIT_HEAD_MISMATCH");
}

function parseProjectData(bytes: Uint8Array): ProjectData {
  if (bytes.byteLength > MAX_TOTAL_BYTES) throw new Error("PROJECT_JSON_TOO_LARGE");
  const parsed = ProjectDataSchema.parse(JSON.parse(strFromU8(bytes)));
  validateAudit(parsed.auditEvents, parsed.auditHeadHash);
  if (parsed.snapshot.project.id !== parsed.sourceRevision.projectId) throw new Error("PROJECT_REVISION_MISMATCH");
  return parsed;
}

export class ProjectPackageService {
  readonly #repository: IndexedDbProjectRepository;
  readonly #commands: ProjectCommandService;

  constructor(repository: IndexedDbProjectRepository) {
    this.#repository = repository;
    this.#commands = new ProjectCommandService({ repository, authorization: new LocalAuthorization() });
  }

  async #buildProjectData(projectId: string, includeBinary: boolean): Promise<ProjectData> {
    const closure = await this.#repository.exportProjectClosure(projectId);
    const assets = await this.#repository.getProjectAssets(projectId);
    const modelRuns = await this.#repository.getProjectModelRuns(projectId);
    const ruleRuns = await this.#repository.getProjectRuleRuns(projectId);
    const decisions = await this.#repository.getProjectDecisions(projectId);
    const cadJobs = await this.#repository.getProjectCadJobs(projectId);
    const artifactRequirementMatrices = await this.#repository.getProjectArtifactRequirementMatrices(projectId);
    const artifacts = await this.#repository.getProjectArtifacts(projectId);
    const checkRuns = await this.#repository.getProjectCheckRuns(projectId);
    const deliveryEvaluations = await this.#repository.getProjectDeliveryEvaluations(projectId);
    const deliveries = await this.#repository.getProjectDeliveries(projectId);
    // 项目引用的词表条目随包携带快照（v1.4 §6.3）：按几何对象引用过滤当前词表
    const vocabulary = resolveVocabulary(await this.#repository.getConceptEntries());
    const referencedConcepts = new Set(closure.head.snapshot.geometrySpecs.flatMap((spec) =>
      spec.objects.map((object) => object.conceptRef ?? object.componentType)));
    const conceptEntries = vocabulary.filter((entry) =>
      referencedConcepts.has(entry.conceptId) || entry.altLabels.some((label) => referencedConcepts.has(label)));
    const artifactByAsset = new Map(artifacts.map((item) => [item.assetId, item]));
    return ProjectDataSchema.parse({
      format: "gujian-project-package",
      packageVersion: 1,
      sourceRevision: closure.revision,
      auditHeadHash: closure.auditEvents.at(-1)?.eventHash,
      snapshot: closure.head.snapshot,
      auditEvents: closure.auditEvents,
      modelRuns,
      ruleRuns,
      decisions,
      cadJobs,
      artifactRequirementMatrices,
      artifacts,
      checkRuns,
      deliveryEvaluations,
      deliveries,
      conceptEntries,
      assets: assets.map(({ record, content }) => ({
        ...record,
        // 登记时就标为缺失的资料不能因为占位内容存在而被改成可用。
        // 有些资料确实拿不到原件，这个状态必须原样带过导出与导入。
        contentStatus: includeBinary && content !== null && record.contentStatus === "available"
          ? "available"
          : "missing",
        path: artifactByAsset.has(record.id)
          ? `artifacts/${artifactByAsset.get(record.id)!.kind}/${record.id}/${record.fileName.replace(/[^\p{L}\p{N}._-]+/gu, "_")}`
          : `evidence/${record.id}/${record.fileName.replace(/[^\p{L}\p{N}._-]+/gu, "_")}`,
      })),
    });
  }

  async exportJson(projectId: string): Promise<Uint8Array> {
    const data = await this.#buildProjectData(projectId, false);
    return strToU8(`${canonicalJson(data)}\n`);
  }

  async exportZip(projectId: string): Promise<Uint8Array> {
    const project = await this.#buildProjectData(projectId, true);
    const projectBytes = strToU8(`${canonicalJson(project)}\n`);
    const auditBytes = strToU8(project.auditEvents.map((event) => canonicalJson(event)).join("\n") + "\n");
    const storedAssets = await this.#repository.getProjectAssets(projectId);
    const assetContents = new Map(storedAssets.map((asset) => [asset.record.id, asset.content]));
    const files = [
      { path: "project.json", bytes: projectBytes, mimeType: "application/json" },
      { path: "audit/events.ndjson", bytes: auditBytes, mimeType: "application/x-ndjson" },
      ...project.assets.flatMap((asset) => {
        if (asset.contentStatus !== "available") return [];
        const content = assetContents.get(asset.id);
        return content ? [{ path: asset.path, bytes: new Uint8Array([]), blob: content, mimeType: asset.mimeType }] : [];
      }),
    ];
    for (const file of files) {
      if ("blob" in file && file.blob) file.bytes = new Uint8Array(await file.blob.arrayBuffer());
    }
    const manifest = ManifestSchema.parse({
      format: "gujian-project-package",
      packageVersion: 1,
      projectId: project.snapshot.project.id,
      sourceRevisionId: project.sourceRevision.id,
      files: files.map((file) => ({
        path: file.path,
        sha256: sha256Hex(file.bytes),
        size: file.bytes.byteLength,
        mimeType: file.mimeType,
      })),
    });
    return zipSync({
      "manifest.json": strToU8(`${canonicalJson(manifest)}\n`),
      ...Object.fromEntries(files.map((file) => [file.path, file.bytes])),
    }, { level: 6, mtime: new Date("2000-01-01T00:00:00Z") });
  }

  parse(bytes: Uint8Array, fileName: string): ProjectData {
    return this.parseWithContents(bytes, fileName).data;
  }

  parseWithContents(bytes: Uint8Array, fileName: string): { data: ProjectData; contents: ReadonlyMap<string, Blob> } {
    if (fileName.toLowerCase().endsWith(".json")) return { data: parseProjectData(bytes), contents: new Map() };
    if (!fileName.toLowerCase().endsWith(".zip")) throw new Error("PACKAGE_TYPE_NOT_SUPPORTED");
    if (bytes.byteLength > MAX_ARCHIVE_BYTES) throw new Error("PACKAGE_TOO_LARGE");
    let expandedBytes = 0;
    let entryCount = 0;
    const entries = unzipSync(bytes, {
      filter(file) {
        entryCount += 1;
        expandedBytes += file.originalSize;
        if (entryCount > MAX_ENTRY_COUNT || file.originalSize > MAX_ENTRY_BYTES || expandedBytes > MAX_TOTAL_BYTES) {
          throw new Error("PACKAGE_LIMIT_EXCEEDED");
        }
        return true;
      },
    });
    const names = Object.keys(entries);
    const normalized = new Set<string>();
    for (const name of names) {
      if (!safePath(name)) throw new Error("PACKAGE_PATH_INVALID");
      const key = name.normalize("NFC").toLocaleLowerCase("en-US");
      if (normalized.has(key)) throw new Error("PACKAGE_PATH_COLLISION");
      normalized.add(key);
    }
    const manifestBytes = entries["manifest.json"];
    const projectBytes = entries["project.json"];
    if (!manifestBytes || !projectBytes) throw new Error("PACKAGE_FILE_MISSING");
    const manifest = ManifestSchema.parse(JSON.parse(strFromU8(manifestBytes)));
    for (const file of manifest.files) {
      if (!safePath(file.path)) throw new Error("PACKAGE_PATH_INVALID");
      const content = entries[file.path];
      if (!content || content.byteLength !== file.size || sha256Hex(content) !== file.sha256) {
        throw new Error("PACKAGE_FILE_HASH_MISMATCH");
      }
    }
    const project = parseProjectData(projectBytes);
    if (project.snapshot.project.id !== manifest.projectId || project.sourceRevision.id !== manifest.sourceRevisionId) {
      throw new Error("PACKAGE_MANIFEST_MISMATCH");
    }
    const auditBytes = entries["audit/events.ndjson"];
    if (!auditBytes) throw new Error("PACKAGE_AUDIT_MISSING");
    const auditEvents = strFromU8(auditBytes).trim().split("\n").filter(Boolean).map((line) => AuditEventSchema.parse(JSON.parse(line)));
    if (canonicalJson(auditEvents) !== canonicalJson(project.auditEvents)) throw new Error("PACKAGE_AUDIT_MISMATCH");
    const contents = new Map<string, Blob>();
    for (const asset of project.assets) {
      if (!safePath(asset.path)) throw new Error("PACKAGE_PATH_INVALID");
      if (asset.contentStatus === "missing") continue;
      const content = entries[asset.path];
      if (!content || content.byteLength !== asset.byteLength || sha256Hex(content) !== asset.sha256) {
        throw new Error("PACKAGE_ASSET_HASH_MISMATCH");
      }
      contents.set(asset.id, new Blob([content as BlobPart], { type: asset.mimeType }));
    }
    return { data: project, contents };
  }

  async import(bytes: Uint8Array, fileName: string, actorId: string): Promise<string> {
    const parsed = this.parseWithContents(bytes, fileName);
    const data = parsed.data;
    const sessionId = parsed.contents.size ? crypto.randomUUID() : null;
    const assetRecords = data.assets.map(({ path: _path, ...asset }) => AssetRecordSchema.parse({
      ...asset,
      contentStatus: parsed.contents.has(asset.id) ? "available" : "missing",
    }));
    // 只暂存有原件的资料。包里允许有已登记但拿不到原件的资料，
    // 把这类也塞进暂存会让整批入库失败。
    const stagedRecords = assetRecords.filter((asset) => parsed.contents.has(asset.id));
    if (sessionId) await this.#repository.stageAssets(sessionId, stagedRecords, parsed.contents);
    try {
      await this.#commands.execute({
      commandType: "ImportProjectSnapshot",
      commandId: crypto.randomUUID(),
      projectId: data.snapshot.project.id,
      actorId,
      expectedRevisionId: null,
      issuedAt: new Date().toISOString(),
      payload: {
        snapshot: data.snapshot,
        sourceRevisionId: data.sourceRevision.id,
        sourceAuditHeadHash: data.auditHeadHash,
        sourceAuditEvents: data.auditEvents,
        assets: assetRecords,
        modelRuns: data.modelRuns,
        ruleRuns: data.ruleRuns,
        decisions: data.decisions,
        cadJobs: data.cadJobs,
        artifactRequirementMatrices: data.artifactRequirementMatrices,
        artifacts: data.artifacts,
        checkRuns: data.checkRuns,
        deliveryEvaluations: data.deliveryEvaluations,
        deliveries: data.deliveries,
        conceptEntries: data.conceptEntries,
        assetSessionId: sessionId,
        packageHash: sha256Hex(bytes),
      },
      });
    } catch (error) {
      if (sessionId) await this.#repository.cleanupStaging(sessionId);
      throw error;
    }
    return data.snapshot.project.id;
  }
}
