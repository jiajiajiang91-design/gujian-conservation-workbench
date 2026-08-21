import { readFile } from "node:fs/promises";
import { resolve } from "node:path";

import { describe, expect, it } from "vitest";

import { parseEvidenceFile, type UploadFile } from "./evidence-ingestion-service.js";

// 任务书、历史记录、修缮档案都是 PDF，用户旅程第一步用户拖进来的就是任务书。
// PDF 取不到正文时，前面所有依赖文字的环节都停在这里。

const ROOT = resolve(import.meta.dirname, "..", "..", "..");
const HABS_PDF = resolve(ROOT, "文档/05_验证证据/03_公开实测样本/Dai_Loy_HABS/06_Dai_Loy历史与建筑说明.pdf");

function upload(bytes: Uint8Array, name: string, type: string): UploadFile {
  return Object.assign(new Blob([bytes as unknown as BlobPart], { type }), { name }) as UploadFile;
}

describe("资料解析", () => {
  it("从真实 HABS 记录取出文字层并读到主体尺寸", async () => {
    const bytes = new Uint8Array(await readFile(HABS_PDF));
    const parsed = await parseEvidenceFile(upload(bytes, "06_Dai_Loy历史与建筑说明.pdf", "application/pdf"));
    expect(parsed.parser).toBe("pdf-text");
    expect(parsed.status).toBe("parsed");
    expect(parsed.extractedText!.length).toBeGreaterThan(5_000);
    // OCR 原文带噪声：twenty ^f our feet'、threes-bay。正则取不出来，模型能读。
    expect(parsed.extractedText).toContain("feet");
    expect(parsed.extractedText).toContain("Overall");
  });

  // 扫描件的文字层由 OCR 生成，引用前必须核对原件，这一点要随解析结果一起交代
  it("PDF 解析结果附带 OCR 可能有错的提示", async () => {
    const bytes = new Uint8Array(await readFile(HABS_PDF));
    const parsed = await parseEvidenceFile(upload(bytes, "记录.pdf", "application/pdf"));
    expect(parsed.warnings.some((item) => item.includes("核对原件"))).toBe(true);
  });

  it("坏文件只记失败，不抛异常打断上传", async () => {
    const parsed = await parseEvidenceFile(upload(new TextEncoder().encode("不是 PDF"), "坏文件.pdf", "application/pdf"));
    expect(parsed.status).toBe("failed");
    expect(parsed.extractedText).toBeNull();
    expect(parsed.warnings[0]).toContain("PDF 读取失败");
  });

  it("文本文件仍走原来的通路", async () => {
    const parsed = await parseEvidenceFile(upload(new TextEncoder().encode("现场记录：明间面阔 3600 mm"), "记录.txt", "text/plain"));
    expect(parsed.parser).toBe("utf8-text");
    expect(parsed.status).toBe("parsed");
    expect(parsed.extractedText).toContain("3600");
  });

  it("图像与未支持格式保持只登记，不冒充已解析", async () => {
    for (const [name, type] of [["图.jpg", "image/jpeg"], ["图.dwg", "application/octet-stream"]] as const) {
      const parsed = await parseEvidenceFile(upload(new Uint8Array([1, 2, 3]), name, type));
      expect(parsed.extractedText, name).toBeNull();
      expect(parsed.status, name).not.toBe("parsed");
    }
  });
});
