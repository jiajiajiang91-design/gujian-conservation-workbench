// 文档与引用的静态检查。退出码 0 表示全过，1 表示存在 issue。
// 用法：node .claude/skills/quality-check/scripts/check-docs.mjs [--all] [--verbose]
// 默认跳过 文档/99_历史归档 与 文档/05_验证证据：两者刻意保留当时状态的旧路径。
// --all 连同它们一起检查，--verbose 展开逐行的建议核对项。

import { readFileSync, readdirSync, statSync, existsSync } from "node:fs";
import { resolve, dirname, join, relative } from "node:path";
import { execFileSync } from "node:child_process";

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
    if (["node_modules", ".git", "dist", ".venv", "__pycache__", ".vite"].includes(name)) continue;
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

// 6 本机绝对路径。公开仓库不该带任何一条，它暴露开发机的目录布局与用户名。
//
// 这一项连着三次靠人工想起来才发现，且每次都漏：第一次只匹配 C:\\Users\\用户名，
// 漏了 D 盘的仓库路径；第二次漏了 JSON 里双写转义的反斜杠；第三次漏了嵌在
// JSON 串里的 Blender 输出路径。按关键词扫描只能找到写法与检索式相同的那些，
// 所以这里把同一类信息的几种写法一起列出来，而不是写一条正则了事。
//
// 三类豁免，都要求写法本身能自证：占位符、代码里的虚构示例、安全负例。
const LOCAL_PATHS = [
  // 单反斜杠：Windows 原生写法，日志与文档里最常见
  /[A-Za-z]:\\(?:Users|Claude_jiajia|WORKS)\\[^\s"'`,)）]*/g,
  // 双反斜杠：JSON 字符串里的转义写法
  /[A-Za-z]:\\\\(?:Users|Claude_jiajia|WORKS)\\\\[^\s"'`,)）]*/g,
  // 正斜杠：跨平台工具与部分脚本写成这样
  /[A-Za-z]:\/(?:Users|Claude_jiajia|WORKS)\/[^\s"'`,)）]*/g,
];
// 已经处理过的写法：USER 占位、虚构示例、只提盘符不带具体路径的安全负例
const PATH_EXEMPT = /\\USER\b|\/USER\b|\\example\b|<仓库根>|<REPO_ROOT>|<本机[^>]*>|<LOCAL_PARENT>/;

// 只查 git 跟踪的文件：这一项的判据是公开仓库里有没有，未跟踪的发布不出去。
// git ls-files 失败（不在仓库里跑）时退回全量，宁可多报不漏报。
// core.quotepath=false 不能省：默认输出会把中文路径转义成八进制，
// 中文文件名一条都匹配不上，整项检查会静默失效而不是报错。
let trackedPaths = null;
try {
  trackedPaths = new Set(
    execFileSync("git", ["-c", "core.quotepath=false", "ls-files"], { cwd: ROOT, encoding: "utf8", maxBuffer: 64 * 1024 * 1024 })
      .split(/\r?\n/).filter(Boolean),
  );
} catch { trackedPaths = null; }

for (const file of [...docs, ...sources]) {
  if (trackedPaths && !trackedPaths.has(rel(file))) continue;
  const text = readFileSync(file, "utf8");
  for (const pattern of LOCAL_PATHS) {
    for (const m of text.matchAll(pattern)) {
      if (PATH_EXEMPT.test(m[0])) continue;
      // 只写到盘符加 Users 就结束的，是在举例说明外部路径，不是真路径
      if (/^[A-Za-z]:[\\/]{1,2}Users[\\/]{0,2}$/.test(m[0])) continue;
      add(issues, rel(file), lineOf(text, m.index), `本机绝对路径：${m[0].slice(0, 60)}`);
    }
  }
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
