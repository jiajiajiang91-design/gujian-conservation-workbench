import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { describeFailure, inputError } from "./failure-notice";

// 07 界面视觉规范 5.6：失败状态显示原因与恢复操作，不显示错误码原文。
// 代码里的错误抛的是 CODE 或 CODE:detail，本测试把这条规定钉死。

const CODE_TOKEN = /\b[A-Z][A-Z0-9]*(_[A-Z0-9]+)+\b/;

// 从全仓源码里收集实际会抛出的错误码，避免测试只覆盖手写的几个。
function collectThrownCodes(): string[] {
  const roots = [
    join(import.meta.dirname, "..", "..", "..", "packages"),
    join(import.meta.dirname, "..", "..", "..", "apps"),
  ];
  const codes = new Set<string>();
  const pattern = /new Error\(\s*[`"]([A-Z][A-Z0-9_]{3,})/g;
  const walk = (dir: string) => {
    for (const name of readdirSync(dir)) {
      if (name === "node_modules" || name === "dist" || name.startsWith(".")) continue;
      const path = join(dir, name);
      if (statSync(path).isDirectory()) { walk(path); continue; }
      if (!/\.(ts|tsx|mjs)$/.test(name) || name.includes(".test.")) continue;
      const source = readFileSync(path, "utf8");
      for (const match of source.matchAll(pattern)) codes.add(match[1]!);
    }
  };
  for (const root of roots) walk(root);
  return [...codes].sort();
}

describe("失败提示不漏错误码", () => {
  const codes = collectThrownCodes();

  it("扫到的错误码数量足以覆盖主要路径", () => {
    expect(codes.length).toBeGreaterThan(60);
  });

  it("每个实际抛出的错误码都翻成中文，不显示码本身", () => {
    const leaked: string[] = [];
    for (const code of codes) {
      const notice = describeFailure(new Error(code), "操作失败");
      const rendered = `${notice.summaryZh} ${notice.nextStepZh}`;
      if (CODE_TOKEN.test(rendered) || rendered.includes(code)) leaked.push(code);
      expect(notice.summaryZh.length, code).toBeGreaterThan(0);
      expect(notice.nextStepZh.length, code).toBeGreaterThan(0);
    }
    expect(leaked).toEqual([]);
  });

  it("码后面挂的进程输出不显示到界面", () => {
    const notice = describeFailure(new Error(`CAD_WORKER_FAILED:${"x".repeat(1_500)}`), "建模失败");
    expect(notice.summaryZh).not.toContain("x");
    expect(CODE_TOKEN.test(notice.summaryZh)).toBe(false);
  });

  it("可读引用作为细节显示，超长截断", () => {
    const notice = describeFailure(new Error("GEOMETRY_EVIDENCE_FACTS_MISSING:柱高,面阔"), "模型生成失败");
    expect(notice.summaryZh).toContain("柱高");
    const long = describeFailure(new Error(`DRAWING_ASSET_DOWNLOAD_FAILED:${"甲".repeat(300)}`), "图纸失败");
    expect(long.summaryZh.length).toBeLessThan(260);
  });

  it("未收录的码走通用说法，仍不显示码", () => {
    const notice = describeFailure(new Error("SOME_BRAND_NEW_CODE"), "现状记录写入失败");
    expect(notice.summaryZh).toContain("现状记录写入失败");
    expect(CODE_TOKEN.test(notice.summaryZh)).toBe(false);
    expect(notice.nextStepZh.length).toBeGreaterThan(0);
  });

  it("助手请求的 HTTP 码不直出", () => {
    for (const code of ["ASSISTANT_TURN_HTTP_403", "ASSISTANT_CONFIRM_HTTP_500"]) {
      const notice = describeFailure(new Error(code), "助手请求失败");
      expect(CODE_TOKEN.test(notice.summaryZh), code).toBe(false);
      expect(notice.summaryZh).not.toContain("403");
      expect(notice.summaryZh).not.toContain("500");
    }
  });

  it("英文运行时错误不直出，改用调用点的中文说法", () => {
    const notice = describeFailure(new TypeError("Failed to fetch"), "图纸作业失败");
    expect(notice.summaryZh).toContain("图纸作业失败");
    expect(notice.summaryZh).not.toContain("Failed");
    expect(/[a-zA-Z]/.test(notice.summaryZh)).toBe(false);
  });

  it("中文消息原样保留", () => {
    const notice = describeFailure(new Error("驳回候选时需要填写理由"), "操作失败");
    expect(notice.summaryZh).toBe("驳回候选时需要填写理由");
  });

  it("填写校验提示不追加下一步", () => {
    expect(inputError("请先选择一个方案再确认")).toEqual({
      summaryZh: "请先选择一个方案再确认",
      nextStepZh: "",
    });
  });
});
