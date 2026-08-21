/* 任务级度量：模型调用、采用结果、失败降级和人工基线分开记录。 */
window.Metrics = (function () {
  const LS = "gujian-wt-metrics";
  let M = null;

  function fresh() {
    return { 调用: [], 采用: [], 失败: [], 降级: [], 人工耗时: {}, 核对耗时: {} };
  }

  function load() {
    try { M = JSON.parse(localStorage.getItem(LS)) || fresh(); } catch (e) { M = fresh(); }
    ["调用", "采用", "失败", "降级"].forEach(key => { if (!Array.isArray(M[key])) M[key] = []; });
    if (!M.人工耗时 || typeof M.人工耗时 !== "object") M.人工耗时 = {};
    if (!M.核对耗时 || typeof M.核对耗时 !== "object") M.核对耗时 = {};
  }

  function save() { try { localStorage.setItem(LS, JSON.stringify(M)); } catch (e) { /* 存储不可用 */ } }
  function now() { return new Date().toLocaleString("zh-CN", { hour12: false }); }
  function number(value) { return Number.isFinite(Number(value)) ? Number(value) : 0; }
  function projectId() {
    try { return window.Store && Store.activeProjectId && Store.activeProjectId() || "unassigned"; }
    catch (e) { return "unassigned"; }
  }

  function normalizeUsage(usage, meta) {
    const normalized = meta?.usage || {};
    const input = number(normalized.input || usage.prompt_tokens || usage.input_tokens);
    const output = number(normalized.output || usage.completion_tokens || usage.output_tokens);
    const cached = number(normalized.cached || usage.prompt_tokens_details?.cached_tokens ||
      usage.input_tokens_details?.cached_tokens);
    const reasoning = number(normalized.reasoning || usage.completion_tokens_details?.reasoning_tokens ||
      usage.output_tokens_details?.reasoning_tokens);
    const total = number(normalized.total || usage.total_tokens) || input + output;
    return { input, output, cached, reasoning, total };
  }

  function record(entry) {
    const meta = entry.meta || {};
    const usage = normalizeUsage(entry.usage || {}, meta);
    M.调用.push({
      项目Id: projectId(),
      步骤: entry.step || meta.taskLabel || "未命名",
      任务: entry.taskId || meta.taskId || "",
      任务组: meta.taskGroup || "未分类",
      秒: number(entry.seconds),
      输入token: usage.input,
      输出token: usage.output,
      缓存token: usage.cached,
      推理token: usage.reasoning,
      tokens: usage.total,
      供应商: meta.provider || "",
      模型: meta.model || "",
      上游模型: meta.upstreamModel || "",
      成本金额: meta.cost ? number(meta.cost.amount) : null,
      成本币种: meta.cost?.currency || "",
      价格来源: meta.cost?.source || "",
      价格日期: meta.cost?.effectiveAt || "",
      重试: number(entry.retries),
      时间: now()
    });
    save();
  }

  function adopt(object, action) { M.采用.push({ 项目Id: projectId(), 对象: object, 动作: action, 时间: now() }); save(); }
  function fail(step, reason) { M.失败.push({ 项目Id: projectId(), 步骤: step, 原因: String(reason).slice(0, 120), 时间: now() }); save(); }
  function fallback(step, reason) { M.降级.push({ 项目Id: projectId(), 步骤: step, 原因: reason, 时间: now() }); save(); }
  function humanTime(taskId, kind, seconds) {
    if (!taskId || !Number.isFinite(Number(seconds)) || Number(seconds) <= 0) return false;
    const target = kind === "review" ? M.核对耗时 : M.人工耗时;
    target[projectId() + "|" + taskId] = Number(seconds);
    save();
    return true;
  }
  function get() { return M; }
  function reset() {
    const id = projectId();
    ["调用", "采用", "失败", "降级"].forEach(key => {
      M[key] = M[key].filter(item => (item.项目Id || "legacy") !== id);
    });
    [M.人工耗时, M.核对耗时].forEach(target => Object.keys(target).forEach(key => {
      if (key.startsWith(id + "|")) delete target[key];
    }));
    save();
  }

  function summary() {
    const id = projectId();
    const mine = list => list.filter(item => (item.项目Id || "legacy") === id);
    const calls = mine(M.调用);
    const adoptedItems = mine(M.采用);
    const failItems = mine(M.失败);
    const fallbackItems = mine(M.降级);
    const totalSeconds = calls.reduce((sum, item) => sum + number(item.秒), 0);
    const input = calls.reduce((sum, item) => sum + number(item.输入token), 0);
    const output = calls.reduce((sum, item) => sum + number(item.输出token), 0);
    const cached = calls.reduce((sum, item) => sum + number(item.缓存token), 0);
    const totalTokens = calls.reduce((sum, item) => sum + number(item.tokens), 0);
    const priced = calls.filter(item => item.成本金额 != null || item.成本元 != null);
    const costs = {};
    priced.forEach(item => {
      const currency = item.成本币种 || "CNY";
      costs[currency] = (costs[currency] || 0) + number(item.成本金额 != null ? item.成本金额 : item.成本元);
    });
    const adopted = adoptedItems.filter(item => item.动作 === "采用").length;
    const edited = adoptedItems.filter(item => item.动作 === "修改").length;
    const deleted = adoptedItems.filter(item => item.动作 === "删除").length;
    const ignored = adoptedItems.filter(item => item.动作 === "忽略").length;
    const handled = adopted + edited + deleted + ignored;
    const grouped = {};
    calls.forEach(call => {
      const key = (call.任务 || call.步骤) + "｜" + (call.模型 || "未记录模型");
      grouped[key] = grouped[key] || {
        任务: call.任务 || call.步骤,
        步骤: call.步骤,
        任务组: call.任务组,
        模型: call.模型 || "未记录",
        次数: 0, 秒: 0, 输入: 0, 输出: 0, 费用: {}, 已计价: 0, 重试: 0
      };
      const group = grouped[key];
      group.次数++;
      group.秒 += number(call.秒);
      group.输入 += number(call.输入token);
      group.输出 += number(call.输出token);
      group.重试 += number(call.重试);
      const amount = call.成本金额 != null ? call.成本金额 : call.成本元;
      if (amount != null) {
        const currency = call.成本币种 || "CNY";
        group.费用[currency] = (group.费用[currency] || 0) + number(amount);
        group.已计价++;
      }
    });
    return {
      调用数: calls.length,
      总秒: totalSeconds,
      平均秒: calls.length ? Math.round(totalSeconds / calls.length * 10) / 10 : 0,
      输入token: input,
      输出token: output,
      缓存token: cached,
      总token: totalTokens,
      费用: Object.fromEntries(Object.entries(costs).map(([currency, amount]) =>
        [currency, Math.round(amount * 1000000) / 1000000])),
      已计价调用: priced.length,
      采用: adopted, 修改: edited, 删除: deleted, 忽略: ignored, 处理总数: handled,
      直接采用率: handled ? Math.round(adopted / handled * 100) : null,
      失败数: failItems.length,
      降级数: fallbackItems.length,
      重试数: calls.reduce((sum, item) => sum + number(item.重试), 0),
      按任务模型: grouped,
      人工耗时: Object.fromEntries(Object.entries(M.人工耗时)
        .filter(([key]) => key.startsWith(id + "|"))
        .map(([key, value]) => [key.slice(id.length + 1), value])),
      核对耗时: Object.fromEntries(Object.entries(M.核对耗时)
        .filter(([key]) => key.startsWith(id + "|"))
        .map(([key, value]) => [key.slice(id.length + 1), value]))
    };
  }

  load();
  return { record, adopt, fail, fallback, humanTime, get, reset, summary };
})();
