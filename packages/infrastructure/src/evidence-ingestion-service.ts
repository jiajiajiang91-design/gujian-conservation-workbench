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

export interface ParseOutcome {
  parser: string;
  status: "parsed" | "metadataOnly" | "pending" | "failed";
  extractedText: string | null;
  warnings: string[];
}

// PDF 逐页取文字层。任务书、历史记录、修缮档案都是 PDF，用户旅程第一步
// 用户拖进来的就是任务书，因此这是常规入口不是特例。
//
// 解析器按需导入：PDF 上传是低频动作，为它常驻一兆多的解析器不合算。
async function parsePdf(file: UploadFile): Promise<ParseOutcome> {
  try {
    const pdfjs = await import("pdfjs-dist/legacy/build/pdf.mjs");
    // 不允许求值、不取系统字体：解析的是不可信来源，只要文字内容
    const document = await pdfjs.getDocument({
      data: new Uint8Array(await file.arrayBuffer()),
      useSystemFonts: false,
      disableFontFace: true,
    }).promise;
    const pages: string[] = [];
    for (let page = 1; page <= document.numPages; page += 1) {
      const content = await (await document.getPage(page)).getTextContent();
      pages.push(content.items.map((item) => ("str" in item ? item.str : "")).join(" "));
    }
    const text = pages.join("\n").replace(/[ \t]+/g, " ").trim();
    if (!text) {
      // 纯扫描件没有文字层。如实说明缺什么，不返回空字符串装作解析成功。
      return {
        parser: "pdf-text",
        status: "metadataOnly",
        extractedText: null,
        warnings: [`该 PDF 共 ${document.numPages} 页但没有文字层，需要 OCR 或人工转录后才能作为文字依据；原文件已保存。`],
      };
    }
    const truncated = text.length > TEXT_LIMIT;
    return {
      parser: "pdf-text",
      status: "parsed",
      extractedText: text.slice(0, TEXT_LIMIT),
      warnings: [
        `已从 ${document.numPages} 页取出文字层。扫描件的文字层由 OCR 生成，可能有错字与断字，引用前需核对原件。`,
        ...(truncated ? [`提取文本已按 ${TEXT_LIMIT} 字符上限截断；原文件未截断。`] : []),
      ],
    };
  } catch (reason) {
    return {
      parser: "pdf-text",
      status: "failed",
      extractedText: null,
      warnings: [`PDF 读取失败：${reason instanceof Error ? reason.message : "未知原因"}；原文件仍已保存。`],
    };
  }
}

export async function parseEvidenceFile(file: UploadFile): Promise<ParseOutcome> {
  const extension = file.name.toLowerCase().split(".").at(-1) ?? "";
  if (extension === "pdf" || file.type === "application/pdf") return parsePdf(file);
  const textLike = file.type.startsWith("text/") || ["txt", "md", "json", "csv", "xml"].includes(extension);
  if (!textLike) {
    return {
      parser: "binary-metadata",
      status: ["dwg", "dxf"].includes(extension) ? "pending" : "metadataOnly",
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
    const parse = await parseEvidenceFile(file);
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
