import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

// 技术架构 8.1：项目名称、固定 UUID、固定开间不得进入生成逻辑。
// 演示数据只能经项目包导入，前端源码不得内置任何具体项目的标识或名称。
// 测试文件本身需要构造固件，不在扫描范围内。

const SOURCE_ROOT = import.meta.dirname;
const SCANNED_EXTENSIONS = [".ts", ".tsx"];
const SKIPPED_DIRECTORIES = new Set(["test"]);

// 验收样本与演示项目的名称，出现在前端源码即为硬编码
const SAMPLE_NAMES = ["高都", "东呈", "南禅寺", "HABS", "Badin-Roque", "Dai Loy"];
const UUID_PATTERN = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i;

interface Violation {
  readonly file: string;
  readonly line: number;
  readonly matched: string;
}

function sourceFiles(directory: string, relative = ""): string[] {
  const collected: string[] = [];
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const relativePath = relative ? `${relative}/${entry.name}` : entry.name;
    if (entry.isDirectory()) {
      if (SKIPPED_DIRECTORIES.has(entry.name)) continue;
      collected.push(...sourceFiles(join(directory, entry.name), relativePath));
      continue;
    }
    if (/\.test\.tsx?$/.test(entry.name)) continue;
    if (!SCANNED_EXTENSIONS.some((extension) => entry.name.endsWith(extension))) continue;
    collected.push(relativePath);
  }
  return collected;
}

function scan(check: (line: string) => string | null): Violation[] {
  const violations: Violation[] = [];
  for (const file of sourceFiles(SOURCE_ROOT)) {
    const lines = readFileSync(join(SOURCE_ROOT, file), "utf8").split("\n");
    lines.forEach((line, index) => {
      const matched = check(line);
      if (matched) violations.push({ file, line: index + 1, matched });
    });
  }
  return violations;
}

function describeViolations(violations: readonly Violation[]): string {
  return violations.map((item) => `${item.file}:${item.line} → ${item.matched}`).join("\n");
}

describe("前端源码不得硬编码项目数据（技术架构 8.1）", () => {
  it("扫描范围覆盖工作台源码", () => {
    const files = sourceFiles(SOURCE_ROOT);
    expect(files.length).toBeGreaterThan(10);
    expect(files).toContain("App.tsx");
    expect(files.some((file) => file.endsWith(".test.ts") || file.endsWith(".test.tsx"))).toBe(false);
  });

  it("不出现 UUID 字面量", () => {
    const violations = scan((line) => UUID_PATTERN.exec(line)?.[0] ?? null);
    expect(violations, `前端源码出现固定 UUID，项目标识必须来自运行时数据：\n${describeViolations(violations)}`).toEqual([]);
  });

  it("不出现验收样本与演示项目名称", () => {
    const violations = scan((line) => SAMPLE_NAMES.find((name) => line.includes(name)) ?? null);
    expect(violations, `前端源码出现具体项目名称，演示数据只能经项目包导入：\n${describeViolations(violations)}`).toEqual([]);
  });
});
