import {
  RuleDataFileSchema,
  type ModificationCheckConfig,
  type RuleDataFile,
  type RuleSpec,
  type RuleSpecFile,
} from "@gujian/domain";

import { recordHash } from "./hash.js";

// 声明式规则求值器（架构 v1.4 §5.5）：
// 公式只允许四则运算、括号、数字与已声明标识符；标识符先取基准参数，
// 再取同规则集内其他规则的 ruleId 结果。跨规则引用按依赖拓扑排序求值，
// 循环依赖拒绝；byMeasurement 与缺失参数映射为 unknown，不写默认值。

export class RuleFormulaError extends Error {}
export class RuleCycleError extends Error {}

export interface RuleEvaluationOutcome {
  readonly ruleId: string;
  readonly subjectConceptRef: string;
  readonly dimension: string;
  readonly status: "computed" | "unknown";
  readonly valueMm: number | null;
  readonly toleranceText: string | null;
  readonly sourceText: string;
  readonly unknownReason: "byMeasurement" | "missingParam" | null;
  readonly missingParams: readonly string[];
}

export interface RuleSetEvaluation {
  readonly ruleSetId: string;
  readonly sourceText: string;
  readonly results: readonly RuleEvaluationOutcome[];
}

export interface LoadedRuleData {
  readonly data: RuleDataFile;
  readonly contentHash: string;
  readonly ruleSetVersion: string;
}

export function loadRuleData(raw: unknown): LoadedRuleData {
  const data = RuleDataFileSchema.parse(raw);
  const contentHash = recordHash(data);
  return {
    data,
    contentHash,
    ruleSetVersion: `${data.dataSetId}-${data.version}@${contentHash.slice(0, 16)}`,
  };
}

export function modificationCheckConfig(data: RuleDataFile): ModificationCheckConfig {
  return data.modificationCheck;
}

type Token =
  | { kind: "number"; value: number }
  | { kind: "identifier"; name: string }
  | { kind: "operator"; op: "+" | "-" | "*" | "/" }
  | { kind: "paren"; open: boolean };

function tokenize(formula: string): Token[] {
  const tokens: Token[] = [];
  let index = 0;
  while (index < formula.length) {
    const char = formula[index]!;
    if (/\s/.test(char)) { index += 1; continue; }
    if (/[0-9]/.test(char)) {
      const match = /^\d+(?:\.\d+)?/.exec(formula.slice(index))!;
      tokens.push({ kind: "number", value: Number(match[0]) });
      index += match[0].length;
      continue;
    }
    if (/[A-Za-z_]/.test(char)) {
      const match = /^[A-Za-z_][A-Za-z0-9_]*/.exec(formula.slice(index))!;
      tokens.push({ kind: "identifier", name: match[0] });
      index += match[0].length;
      continue;
    }
    if (char === "+" || char === "-" || char === "*" || char === "/") {
      tokens.push({ kind: "operator", op: char });
      index += 1;
      continue;
    }
    if (char === "(" || char === ")") {
      tokens.push({ kind: "paren", open: char === "(" });
      index += 1;
      continue;
    }
    throw new RuleFormulaError(`公式包含不允许的字符: ${char}`);
  }
  if (!tokens.length) throw new RuleFormulaError("公式为空");
  return tokens;
}

export function formulaIdentifiers(formula: string): string[] {
  if (formula === "byMeasurement") return [];
  return [...new Set(tokenize(formula).filter((t) => t.kind === "identifier").map((t) => (t as { name: string }).name))];
}

const PRECEDENCE: Record<string, number> = { "+": 1, "-": 1, "*": 2, "/": 2 };

function evaluateFormula(formula: string, resolve: (name: string) => number): number {
  const output: Token[] = [];
  const stack: Token[] = [];
  for (const token of tokenize(formula)) {
    if (token.kind === "number" || token.kind === "identifier") { output.push(token); continue; }
    if (token.kind === "operator") {
      while (stack.length) {
        const top = stack[stack.length - 1]!;
        if (top.kind === "operator" && PRECEDENCE[top.op]! >= PRECEDENCE[token.op]!) output.push(stack.pop()!);
        else break;
      }
      stack.push(token);
      continue;
    }
    if (token.open) { stack.push(token); continue; }
    while (stack.length && stack[stack.length - 1]!.kind !== "paren") output.push(stack.pop()!);
    if (!stack.length) throw new RuleFormulaError("括号不匹配");
    stack.pop();
  }
  while (stack.length) {
    const top = stack.pop()!;
    if (top.kind === "paren") throw new RuleFormulaError("括号不匹配");
    output.push(top);
  }
  const values: number[] = [];
  for (const token of output) {
    if (token.kind === "number") { values.push(token.value); continue; }
    if (token.kind === "identifier") { values.push(resolve(token.name)); continue; }
    if (token.kind === "operator") {
      const right = values.pop();
      const left = values.pop();
      if (right === undefined || left === undefined) throw new RuleFormulaError("公式结构不完整");
      if (token.op === "/" && right === 0) throw new RuleFormulaError("除数为零");
      values.push(token.op === "+" ? left + right : token.op === "-" ? left - right : token.op === "*" ? left * right : left / right);
    }
  }
  if (values.length !== 1) throw new RuleFormulaError("公式结构不完整");
  return values[0]!;
}

function toleranceText(rule: RuleSpec, value: number | null): string | null {
  if (!rule.tolerance) return null;
  if (rule.tolerance.kind === "absoluteMm") return `±${rule.tolerance.value}mm`;
  if (value === null) return `±${Number(rule.tolerance.value) * 100}%`;
  const band = Number(rule.tolerance.value) * value;
  return `±${Math.round(band * 100) / 100}mm（比例 ${rule.tolerance.value}）`;
}

// 依赖拓扑排序：结果键为 ruleId；识别公式引用的其他规则并先行求值。
function topologicalOrder(rules: readonly RuleSpec[]): RuleSpec[] {
  const byId = new Map(rules.map((rule) => [rule.ruleId, rule]));
  const ordered: RuleSpec[] = [];
  const state = new Map<string, "visiting" | "done">();
  const visit = (rule: RuleSpec, path: string[]) => {
    const current = state.get(rule.ruleId);
    if (current === "done") return;
    if (current === "visiting") throw new RuleCycleError(`规则循环依赖: ${[...path, rule.ruleId].join(" -> ")}`);
    state.set(rule.ruleId, "visiting");
    for (const identifier of formulaIdentifiers(rule.formula)) {
      const dependency = byId.get(identifier);
      if (dependency) visit(dependency, [...path, rule.ruleId]);
    }
    state.set(rule.ruleId, "done");
    ordered.push(rule);
  };
  for (const rule of rules) visit(rule, []);
  return ordered;
}

export function evaluateRuleSet(set: RuleSpecFile, params: Record<string, number>): RuleSetEvaluation {
  const outcomes = new Map<string, RuleEvaluationOutcome>();
  for (const rule of topologicalOrder(set.rules)) {
    if (rule.formula === "byMeasurement") {
      outcomes.set(rule.ruleId, {
        ruleId: rule.ruleId, subjectConceptRef: rule.subjectConceptRef, dimension: rule.dimension,
        status: "unknown", valueMm: null, toleranceText: toleranceText(rule, null),
        sourceText: rule.sourceText, unknownReason: "byMeasurement", missingParams: [],
      });
      continue;
    }
    const missing: string[] = [];
    const resolve = (name: string): number => {
      if (Object.prototype.hasOwnProperty.call(params, name)) return params[name]!;
      const dependency = outcomes.get(name);
      if (dependency) {
        if (dependency.status === "computed" && dependency.valueMm !== null) return dependency.valueMm;
        missing.push(name);
        return Number.NaN;
      }
      missing.push(name);
      return Number.NaN;
    };
    let value: number | null = null;
    try {
      const computed = evaluateFormula(rule.formula, resolve);
      value = Number.isFinite(computed) && !missing.length ? computed : null;
    } catch (error) {
      if (error instanceof RuleFormulaError && !missing.length) throw error;
      value = null;
    }
    outcomes.set(rule.ruleId, value === null
      ? {
        ruleId: rule.ruleId, subjectConceptRef: rule.subjectConceptRef, dimension: rule.dimension,
        status: "unknown", valueMm: null, toleranceText: toleranceText(rule, null),
        sourceText: rule.sourceText, unknownReason: "missingParam", missingParams: [...new Set(missing)],
      }
      : {
        ruleId: rule.ruleId, subjectConceptRef: rule.subjectConceptRef, dimension: rule.dimension,
        status: "computed", valueMm: Math.round(value * 1000) / 1000, toleranceText: toleranceText(rule, value),
        sourceText: rule.sourceText, unknownReason: null, missingParams: [],
      });
  }
  return { ruleSetId: set.ruleSetId, sourceText: set.sourceText, results: set.rules.map((rule) => outcomes.get(rule.ruleId)!) };
}

// 多规范并存：同一输入按全部规则集分别计算，输出并列方案（规范选择停靠的选项来源）
export function evaluateOptionSets(data: RuleDataFile, params: Record<string, number>): RuleSetEvaluation[] {
  return data.ruleSets.map((set) => evaluateRuleSet(set, params));
}
