import { readFileSync, writeFileSync } from "node:fs";

import { KimiGateway } from "../kimi-gateway.js";
import { modelFacingCatalog } from "./action-catalog.js";
import { dispatchUserText } from "./dispatch.js";
import type { WorkspaceSnapshot } from "./snapshot-types.js";

// 分发测试基准（D6）：读取用例文件，对每条真实表达运行三级分发，
// 统计三档命中率（模型直判、重试后命中、关键词退路）与未命中清单。
// 用法：node dist/actions/dispatch-benchmark.js <cases.json> <out.json>
// 用例格式：[{ "text": "...", "expected": "switch_view", "note": "可选" }]
// 模型档仅在 KIMI_API_KEY 配置时运行；未配置时全部走关键词档并如实标注。

interface BenchmarkCase {
  text: string;
  expected: string;
  note?: string;
}

const snapshot: WorkspaceSnapshot = {
  projectId: "3b241101-e2bb-4255-8caf-4136c566a962",
  currentStage: "objects",
  openDockItems: 0,
  componentCount: 886,
  hasGeometryRevision: true,
  hasDrawings: true,
  hasDeliverable: true,
  modelRouteAvailable: true,
  unparsedEvidenceCount: 3,
};

async function main(): Promise<number> {
  const [casesPath, outPath] = process.argv.slice(2);
  if (!casesPath || !outPath) {
    console.error("用法: node dispatch-benchmark.js <cases.json> <out.json>");
    return 1;
  }
  const cases = JSON.parse(readFileSync(casesPath, "utf8")) as BenchmarkCase[];
  const gateway = new KimiGateway();
  const modelAvailable = gateway.configured && typeof gateway.executeWithTools === "function";
  const tiers = { modelDirect: 0, modelRetry: 0, keyword: 0, miss: 0 };
  const rows: Record<string, unknown>[] = [];

  for (const item of cases) {
    const decision = await dispatchUserText(item.text, {
      modelAvailable,
      runModel: async ({ userText, retryIssues }) => gateway.executeWithTools({
        systemPrompt: "你是古建测绘工作台的操作助手。根据用户这句话，从提供的动作中选择一个调用。",
        userContent: retryIssues ? `${userText}\n\n（上一次动作参数有误：${retryIssues.join("；")}）` : userText,
        tools: modelFacingCatalog(),
        signal: new AbortController().signal,
      }),
    });
    const actual = decision.kind === "action" ? decision.action.name : "answer_question";
    const hit = actual === item.expected;
    const modelAttempts = decision.trace.attempts.filter((attempt) => attempt.source === "model").length;
    const tier = !hit ? "miss"
      : decision.source === "keyword" ? "keyword"
        : modelAttempts > 1 ? "modelRetry" : "modelDirect";
    tiers[tier] += 1;
    rows.push({
      text: item.text, expected: item.expected, actual, hit, tier,
      attempts: decision.trace.attempts.map((attempt) => `${attempt.source}:${attempt.resultCode}`),
      note: item.note ?? null,
    });
    console.log(`${hit ? "命中" : "未中"} [${tier}] ${item.text} -> ${actual}`);
  }

  const report = {
    schemaVersion: "assistant-dispatch-benchmark-1",
    ranAt: new Date().toISOString(),
    modelAvailable,
    model: modelAvailable ? gateway.model : null,
    caseCount: cases.length,
    tiers,
    hitRate: Math.round(((cases.length - tiers.miss) / Math.max(1, cases.length)) * 1000) / 10,
    rows,
  };
  writeFileSync(outPath, `${JSON.stringify(report, null, 2)}\n`, "utf8");
  console.log(`\n命中率 ${report.hitRate}%（模型直判 ${tiers.modelDirect}，重试命中 ${tiers.modelRetry}，关键词 ${tiers.keyword}，未中 ${tiers.miss}）`);
  console.log(`报告已写入 ${outPath}`);
  return 0;
}

main().then((code) => { process.exitCode = code; }, (error) => { console.error(error); process.exitCode = 1; });
