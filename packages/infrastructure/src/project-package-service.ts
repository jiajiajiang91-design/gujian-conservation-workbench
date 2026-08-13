import { ProjectCommandService } from "@gujian/application";
import {
  AuditEventSchema,
  ProjectRevisionSchema,
  ProjectSnapshotSchema,
  Sha256Schema,
  UuidSchema,
  type AuditEvent,
} from "@gujian/domain";
import { strFromU8, strToU8, unzipSync, zipSync } from "fflate";
import { z } from "zod";

import { canonicalJson, recordHash, sha256Hex } from "./hash.js";
import { IndexedDbProjectRepository, LocalAuthorization } from "./indexeddb-project-repository.js";

const MAX_ARCHIVE_BYTES = 120 * 1024 * 1024;
const MAX_ENTRY_BYTES = 80 * 1024 * 1024;
const MAX_TOTAL_BYTES = 240 * 1024 * 1024;
const MAX_ENTRY_COUNT = 1_000;

const ProjectDataSchema = z.object({
  format: z.literal("gujian-project-package"),
  packageVersion: z.literal(1),
  sourceRevision: ProjectRevisionSchema,
  auditHeadHash: Sha256Schema,
  snapshot: ProjectSnapshotSchema,
  auditEvents: z.array(AuditEventSchema).max(100_000),
  assets: z.array(z.object({
    id: UuidSchema,
    path: z.string().min(1).max(500),
    sha256: Sha256Schema,
    mimeType: z.string().min(1).max(200),
    size: z.number().int().nonnegative(),
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

  async exportJson(projectId: string): Promise<Uint8Array> {
    const closure = await this.#repository.exportProjectClosure(projectId);
    const data = ProjectDataSchema.parse({
      format: "gujian-project-package",
      packageVersion: 1,
      sourceRevision: closure.revision,
      auditHeadHash: closure.auditEvents.at(-1)?.eventHash,
      snapshot: closure.head.snapshot,
      auditEvents: closure.auditEvents,
      assets: [],
    });
    return strToU8(`${canonicalJson(data)}\n`);
  }

  async exportZip(projectId: string): Promise<Uint8Array> {
    const projectBytes = await this.exportJson(projectId);
    const project = parseProjectData(projectBytes);
    const auditBytes = strToU8(project.auditEvents.map((event) => canonicalJson(event)).join("\n") + "\n");
    const files = [
      { path: "project.json", bytes: projectBytes, mimeType: "application/json" },
      { path: "audit/events.ndjson", bytes: auditBytes, mimeType: "application/x-ndjson" },
    ];
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
    if (fileName.toLowerCase().endsWith(".json")) return parseProjectData(bytes);
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
    return project;
  }

  async import(bytes: Uint8Array, fileName: string, actorId: string): Promise<string> {
    const data = this.parse(bytes, fileName);
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
        packageHash: sha256Hex(bytes),
      },
    });
    return data.snapshot.project.id;
  }
}
