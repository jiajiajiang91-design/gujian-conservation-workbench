// 文档与引用的静态检查。退出码 0 表示全过，1 表示存在 issue。
// 用法：node .claude/skills/quality-check/scripts/check-docs.mjs [--all] [--verbose]
// 默认跳过 文档/99_历史归档 与 文档/05_验证证据：两者刻意保留当时状态的旧路径。
// --all 连同它们一起检查，--verbose 展开逐行的建议核对项。

import { readFileSync, readdirSync, statSync, existsSync } from "node:fs";
import { resolve, dirname, join, relative } from "node:path";

const ROOT = resolve(import.meta.dirname, "..", "..", "..", "..");
const ALL = process.argv.includes("--all");
const VERBOSE = process.argv.includes("--verbose");
const issues = [];
const warnings = [];
const add = (list, file, line, text) => list.push({ file, line, text });

// 历史目录保留当时状态的路径记录，不参与引用检查
const FROZEN = ["文档/99_历史归档", "文档/05_验证证据"];
// 规范与模板文件里的禁用字符是条文举例本身，不是违规
const RULEBOOK = /doc-guidelines|diagram-guidelines|-template\.md|prd-checklist/;
// 运行时生成或被 gitignore 的路径，引用到它们不算失效
const RUNTIME = [/\.env$/, /node_modules/, /^dist\//, /\/dist\//, /\.gujian\.zip$/];

const walk = (dir, exts, out = []) => {
  if (!existsSync(dir)) return out;
  for (const name of readdirSync(dir)) {
    if (name === "node_modules" || name === ".git" || name === "dist") continue;
    const full = join(dir, name);
    if (statSync(full).isDirectory()) walk(full, exts, out);
    else if (exts.some((e) => name.endsWith(e))) out.push(full);
  }
  return out;
};

const rel = (p) => relative(ROOT, p).replace(/\\/g, "/");
const frozen = (p) => FROZEN.some((f) => rel(p).startsWith(f));
const runtime = (p) => RUNTIME.some((r) => r.test(p));
const lineOf = (text, index) => text.slice(0, index).split("\n").length;

const docs = [
  ...walk(join(ROOT, "文档"), [".md"]).filter((p) => ALL || !frozen(p)),
  ...walk(join(ROOT, ".claude"), [".md"]),
  join(ROOT, "CLAUDE.md"),
  join(ROOT, "项目目录说明.md"),
].filter((p) => existsSync(p));

// 源码里写死的文档路径，改名会直接让构建或测试失败
const sources = ["apps", "packages", "tools", "workers"]
  .flatMap((d) => walk(join(ROOT, d), [".ts", ".tsx", ".mjs", ".js", ".py"]));

// 1 禁用字符（CLAUDE.md 与文档书写规范 2.4）
const BANNED = [["——", "破折号"], ["「", "直角引号"], ["」", "直角引号"], ["……", "省略号"], ["！", "感叹号"]];
for (const file of docs) {
  if (RULEBOOK.test(rel(file))) continue;
  readFileSync(file, "utf8").split(/\r?\n/).forEach((line, i) => {
    if (/禁用|不用|不要写|替代/.test(line)) return; // 规则陈述句里出现该字符是举例
    const bare = line.replace(/`[^`]*`/g, "");
    for (const [ch, name] of BANNED) {
      if (bare.includes(ch)) add(issues, rel(file), i + 1, `禁用字符${name}：${line.trim().slice(0, 60)}`);
    }
  });
}

// 2 中英文之间缺空格（文档书写规范 2.3）
for (const file of docs) {
  readFileSync(file, "utf8").split(/\r?\n/).forEach((line, i) => {
    const stripped = line.replace(/`[^`]*`/g, "").replace(/\]\([^)]*\)/g, "]()").replace(/[\w./-]+\.md/g, "");
    const m = stripped.match(/[一-龥][A-Za-z]|[A-Za-z][一-龥]/g);
    if (m) add(warnings, rel(file), i + 1, `中英文之间缺空格：${m.join("、")}`);
  });
}

// 3 markdown 相对链接
for (const file of docs) {
  const text = readFileSync(file, "utf8");
  for (const m of text.matchAll(/\]\(([^)]+)\)/g)) {
    const target = m[1].split("#")[0].trim();
    if (!target || /^(https?:|mailto:)/.test(target)) continue;
    if (!existsSync(resolve(dirname(file), target))) {
      add(issues, rel(file), lineOf(text, m.index), `链接失效：${target}`);
    }
  }
}

// 4 文档里用反引号写的仓库内路径
const REPO_DIR = /^(文档|apps|packages|tools|workers|交互原型|\.claude)\//;
for (const file of docs) {
  const text = readFileSync(file, "utf8");
  const lines = text.split(/\r?\n/);
  for (const m of text.matchAll(/`([^`\n]+)`/g)) {
    const p = m[1].trim().replace(/:\d+$/, "").replace(/\/$/, "");
    // 通配与占位符不是真实路径
    if (!REPO_DIR.test(p) || runtime(p) || /[*{}]/.test(p) || p.includes(" ")) continue;
    if (existsSync(join(ROOT, p))) continue;
    // 变更对照表的一行里旧路径与新路径并列，旧的失效是有意的
    const line = lines[lineOf(text, m.index) - 1] ?? "";
    const others = [...line.matchAll(/`([^`\n]+)`/g)].map((x) => x[1].trim().replace(/:\d+$/, "").replace(/\/$/, ""));
    const pairedWithLive = others.some((o) => o !== p && REPO_DIR.test(o) && existsSync(join(ROOT, o)));
    add(pairedWithLive ? warnings : issues, rel(file), lineOf(text, m.index),
      pairedWithLive ? `变更对照里的旧路径：${p}` : `路径不存在：${p}`);
  }
}

// 5 源码引用的文档路径
for (const file of sources) {
  readFileSync(file, "utf8").split(/\r?\n/).forEach((line, i) => {
    for (const m of line.matchAll(/文档\/[^"'`\s)（）,]+/g)) {
      const p = m[0].replace(/[.。，、]$/, "");
      if (!runtime(p) && !existsSync(join(ROOT, p))) {
        add(issues, rel(file), i + 1, `源码引用的文档路径不存在：${p}`);
      }
    }
  });
}

const show = (list, label, collapse) => {
  if (!list.length) return;
  console.log(`\n${label}（${list.length}）`);
  if (collapse && !VERBOSE) {
    const byFile = new Map();
    for (const x of list) byFile.set(x.file, (byFile.get(x.file) ?? 0) + 1);
    for (const [f, n] of [...byFile].sort((a, b) => b[1] - a[1])) console.log(`  ${f}  ${n} 处`);
    console.log("  加 --verbose 看逐行");
    return;
  }
  for (const x of list.slice(0, 40)) console.log(`  ${x.file}${x.line ? ":" + x.line : ""}  ${x.text}`);
  if (list.length > 40) console.log(`  ... 另有 ${list.length - 40} 条`);
};

console.log(`检查范围：${docs.length} 份文档、${sources.length} 份源码${ALL ? "（含历史目录）" : ""}`);
show(issues, "必须修复");
show(warnings, "建议核对", true);
if (!issues.length && !warnings.length) console.log("\n全部通过");
process.exit(issues.length ? 1 : 0);
