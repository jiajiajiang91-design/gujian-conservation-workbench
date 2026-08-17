import { readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

// 07 界面视觉规范第 8 节自检清单里可自动化的条目。
// 目的是防回归：色值、字号与圆角一旦绕过令牌，测试立即失败。

const SOURCE_ROOT = import.meta.dirname;
const read = (name: string) => readFileSync(join(SOURCE_ROOT, name), "utf8");

const TOKENS = read("tokens.css");
const COMPONENTS = read("components.css");
const PAGES = read("styles.css");

describe("界面视觉规范自检（07 第 8 节）", () => {
  it("令牌覆盖第 2 节色板与第 6 节布局尺寸", () => {
    const required = [
      "--bg-page", "--bg-panel", "--bg-subtle",
      "--text-primary", "--text-secondary", "--text-muted",
      "--border", "--border-strong",
      "--accent", "--success", "--warning", "--danger",
      "--src-measured", "--src-model", "--src-rule", "--src-human", "--src-demo",
      "--topbar-height", "--left-column", "--center-min", "--right-column",
    ];
    for (const token of required) expect(TOKENS, `缺令牌 ${token}`).toContain(`${token}:`);
  });

  it("页面与组件样式不写字面色值", () => {
    for (const [name, css] of [["components.css", COMPONENTS], ["styles.css", PAGES]] as const) {
      const literals = [...new Set([...css.matchAll(/#[0-9a-fA-F]{3,8}\b/g)].map((match) => match[0]))];
      expect(literals, `${name} 出现规范外色值，应改用第 2 节令牌`).toEqual([]);
    }
  });

  it("不使用 12px 以下字号", () => {
    for (const [name, css] of [["components.css", COMPONENTS], ["styles.css", PAGES]] as const) {
      const sizes = [...css.matchAll(/font(?:-size)?:[^;{}]*?\b(\d+)px/g)].map((match) => Number(match[1]));
      const tooSmall = [...new Set(sizes.filter((size) => size < 12))];
      expect(tooSmall, `${name} 出现 12px 以下字号`).toEqual([]);
    }
  });

  it("基础组件齐备，页面不另写一套", () => {
    // 第 5 节六类：按钮、表格、卡片、标签、输入表单、空态
    for (const component of [".gj-btn", ".gj-table", ".gj-card", ".gj-tag", ".gj-field", ".gj-empty"]) {
      expect(COMPONENTS, `缺基础组件 ${component}`).toContain(component);
    }
    // 按钮四类与五状态
    for (const variant of ["--primary", "--secondary", "--text", "--danger"]) {
      expect(COMPONENTS, `按钮缺 ${variant}`).toContain(`.gj-btn${variant}`);
    }
    for (const state of [":hover", ":active", ":disabled", "aria-busy", ":focus-visible"]) {
      expect(COMPONENTS, `按钮缺状态 ${state}`).toContain(state);
    }
  });

  it("来源标记不只靠颜色区分", () => {
    // 第 2 节表 3 与第 7 节：五类来源各有形状差异
    const shapes = COMPONENTS.match(/\.gj-source--\w+::before \{[^}]*\}/g) ?? [];
    expect(shapes.length).toBe(5);
    expect(shapes.filter((rule) => rule.includes("border-radius")).length).toBeGreaterThan(1);
    expect(shapes.some((rule) => rule.includes("repeating-linear-gradient"))).toBe(true);
    expect(shapes.some((rule) => rule.includes("border:"))).toBe(true);
  });

  it("布局按第 6 节取值，焦点样式不移除", () => {
    expect(PAGES).toContain("var(--topbar-height)");
    expect(PAGES).toContain("var(--left-column)");
    expect(PAGES).toContain("var(--center-min)");
    expect(PAGES).toContain("var(--right-column)");
    expect(PAGES).toMatch(/:focus-visible[^{]*\{[^}]*outline:\s*2px solid var\(--accent\)/);
  });
});
