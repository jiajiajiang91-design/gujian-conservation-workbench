import { ProjectCommandService, type ProjectHead } from "@gujian/application";
import { AssetRecordSchema, EvidenceSchema, ParseRecordSchema, type AssetRecord } from "@gujian/domain";

import { sha256Hex } from "./hash.js";
import { IndexedDbProjectRepository, LocalAuthorization } from "./indexeddb-project-repository.js";

export interface UploadFile extends Blob {
  readonly name: string;
  readonly lastModified?: number;
}

const TEXT_LIMIT = 200_000;

function evidenceType(file: UploadFile): "photo" | "document" | "drawing" | "audio" | "video" | "other" {
  const extension = file.name.toLowerCase().split(".").at(-1) ?? "";
  if (file.type.startsWith("image/")) return "photo";
  if (file.type.startsWith("audio/")) return "audio";
  if (file.type.startsWith("video/")) return "video";
  if (["dwg", "dxf", "svg"].includes(extension)) return "drawing";
  if (["pdf", "doc", "docx", "txt", "md", "json", "csv"].includes(extension) || file.type.startsWith("text/")) return "document";
  return "other";
}

async function parseFile(file: UploadFile): Promise<{
  parser: string;
  status: "parsed" | "metadataOnly" | "pending" | "failed";
  extractedText: string | null;
  warnings: string[];
}> {
  const extension = file.name.toLowerCase().split(".").at(-1) ?? "";
  const textLike = file.type.startsWith("text/") || ["txt", "md", "json", "csv", "xml"].includes(extension);
  if (!textLike) {
    return {
      parser: "binary-metadata",
      status: ["pdf", "dwg", "dxf"].includes(extension) ? "pending" : "metadataOnly",
      extractedText: null,
      warnings: ["原始文件已保存；本里程碑未对该格式提取正文。"],
    };
  }
  let decoded: string;
  try {
    decoded = new TextDecoder("utf-8", { fatal: true }).decode(await file.slice(0, TEXT_LIMIT * 4).arrayBuffer());
  } catch {
    return { parser: "utf8-text", status: "failed", extractedText: null, warnings: ["文件不是有效 UTF-8；原文件仍已保存。"] };
  }
  const truncated = decoded.length > TEXT_LIMIT;
  const text = decoded.slice(0, TEXT_LIMIT);
  if (extension === "json") {
    try { JSON.parse(text); } catch {
      return { parser: "utf8-json", status: "failed", extractedText: text, warnings: ["JSON 语法无效；原文件仍已保存。"] };
    }
  }
  return {
    parser: extension === "json" ? "utf8-json" : "utf8-text",
    status: "parsed",
    extractedText: text,
    warnings: truncated ? ["提取文本已按 200,000 字符上限截断；原文件未截断。"] : [],
  };
}

export class EvidenceIngestionService {
  readonly #repository: IndexedDbProjectRepository;
  readonly #commands: ProjectCommandService;
  readonly #maxBytes: number;

  constructor(repository: IndexedDbProjectRepository, maxBytes = 100 * 1024 * 1024) {
    this.#repository = repository;
    this.#commands = new ProjectCommandService({ repository, authorization: new LocalAuthorization() });
    this.#maxBytes = maxBytes;
  }

  async ingest(head: ProjectHead, actorId: string, file: UploadFile): Promise<ProjectHead> {
    if (!file.name.trim() || file.name.length > 300) throw new Error("FILE_NAME_INVALID");
    if (file.size === 0 || file.size > this.#maxBytes) throw new Error("FILE_SIZE_NOT_ALLOWED");
    const bytes = new Uint8Array(await file.arrayBuffer());
    const now = new Date().toISOString();
    const assetId = crypto.randomUUID();
    const evidenceId = crypto.randomUUID();
    const parse = await parseFile(file);
    const asset = AssetRecordSchema.parse({
      id: assetId,
      projectId: head.projectId,
      fileName: file.name,
      mimeType: file.type || "application/octet-stream",
      byteLength: file.size,
      sha256: sha256Hex(bytes),
      contentStatus: "available",
      createdAt: now,
    });
    const evidence = EvidenceSchema.parse({
      id: evidenceId,
      projectId: head.projectId,
      assetId,
      evidenceType: evidenceType(file),
      title: file.name,
      rightsDeclaration: null,
      intendedUse: "项目资料整理与候选提取",
      recordedAt: file.lastModified ? new Date(file.lastModified).toISOString() : null,
      relatedEntityRefs: [head.snapshot.buildings[0]?.id ?? head.projectId],
      dataStatus: "available",
    });
    const parseRecord = ParseRecordSchema.parse({
      id: crypto.randomUUID(),
      projectId: head.projectId,
      assetId,
      evidenceId,
      parser: parse.parser,
      parserVersion: "1.0.0",
      status: parse.status,
      extractedText: parse.extractedText,
      warnings: parse.warnings,
      createdAt: now,
    });
    const sessionId = crypto.randomUUID();
    await this.#repository.stageAssets(sessionId, [asset], new Map([[asset.id, file]]));
    try {
      await this.#commands.execute({
        commandType: "ImportEvidence",
        commandId: crypto.randomUUID(),
        projectId: head.projectId,
        actorId,
        expectedRevisionId: head.revisionId,
        issuedAt: now,
        payload: { evidence, asset, parseRecord, stagingSessionId: sessionId },
      });
    } catch (error) {
      await this.#repository.cleanupStaging(sessionId);
      throw error;
    }
    const updated = await this.#repository.getProjectHead(head.projectId);
    if (!updated) throw new Error("PROJECT_NOT_FOUND_AFTER_EVIDENCE_IMPORT");
    return updated;
  }
}

export type { AssetRecord };
