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

  // 表 7 加载分档：三档表现各自成立，且不伪造百分比
  it("加载分档三档齐全", () => {
    // 第一档由 useDelayedIndicator 的 300 ms 门槛实现，见 LongTask.tsx
    expect(read("LongTask.tsx")).toContain("INDICATOR_DELAY_MS = 300");
    // 第二档：区域内 24 px 指示器加一行说明
    expect(COMPONENTS).toContain(".gj-loading");
    expect(COMPONENTS).toMatch(/\.gj-loading::before[\s\S]*?width: 24px/);
    // 第三档：进度条高 4 px、圆角 2 px，含不确定态
    expect(COMPONENTS).toMatch(/\.gj-task-bar \{[\s\S]*?height: 4px/);
    expect(COMPONENTS).toMatch(/\.gj-task-bar \{[\s\S]*?border-radius: 2px/);
    expect(COMPONENTS).toContain(".gj-task-bar--indeterminate");
    expect(COMPONENTS).toContain(".gj-task-bar--determinate");
  });

  it("按钮加载态为 16 px 指示器且宽度不跳动", () => {
    // 指示器槽位常驻并预留宽度，进入加载态只切换可见性，宽度不变
    expect(COMPONENTS).toMatch(/\.gj-btn--loadable::before \{[\s\S]*?width: 16px/);
    expect(COMPONENTS).toMatch(/\.gj-btn--loadable::before \{[\s\S]*?visibility: hidden/);
    expect(COMPONENTS).toMatch(/\.gj-btn\[aria-busy="true"\]::before \{[\s\S]*?width: 16px/);
    // 动画 0.8 s 匀速，不用跳动或缩放
    expect(COMPONENTS).toMatch(/animation: gj-spin \.8s linear infinite/);
  });

  it("长任务不伪造百分比也不伪造估算值", () => {
    const source = read("LongTask.tsx");
    // 没有历史数据时显示耗时未知
    expect(source).toContain("耗时未知");
    // 预计耗时不精确到秒以下
    expect(source).toContain("预计还需");
    expect(source).not.toMatch(/toFixed\(\d\)/);
  });

});
