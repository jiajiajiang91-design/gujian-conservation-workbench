/* 来源标记。任何一条数据都必须说清楚它是怎么来的。
   不区分来源，用户看见"AI 推测"却无法判断这到底是模型算的还是演示数据写死的，
   AI 的可靠性也就无从验证。 */
window.PROV = (function () {

  const DEF = {
    demo:     { 名: "示例资料", 说明: "页面预置内容，并非本次识别结果", cls: "prov-demo" },
    ai:       { 名: "AI 识别",   说明: "由 AI 从本次资料中识别",       cls: "prov-ai" },
    program:  { 名: "程序生成", 说明: "按固定程序或检查规则得出，可重复验证", cls: "prov-rule" },
    measured: { 名: "现场实测", 说明: "有现场实测记录支持",           cls: "prov-measured" },
    human:    { 名: "人工确认", 说明: "由项目人员判断并署名",         cls: "prov-human" },
    unknown:  { 名: "待确认",   说明: "证据不足，尚未判定",         cls: "prov-unknown" },
    missing:  { 名: "资料缺失", 说明: "当前没有找到所需资料",         cls: "prov-missing" }
  };

  function badge(k, 附加) {
    if (k === "rule") k = "program"; // 旧存档迁移别名
    const d = DEF[k] || DEF.demo;
    return '<span class="badge ' + d.cls + '" title="' + d.说明 + '">' +
      d.名 + (附加 ? " " + 附加 : "") + "</span>";
  }
  function name(k) { if (k === "rule") k = "program"; return (DEF[k] || DEF.demo).名; }
  function desc(k) { if (k === "rule") k = "program"; return (DEF[k] || DEF.demo).说明; }

  /* 统计当前工作区里各类来源各占多少，用于向用户交代 AI 到底参与了多少 */
  function summarize(S) {
    const c = { demo: 0, ai: 0, program: 0, measured: 0, human: 0, unknown: 0, missing: 0 };
    const bump = k => { if (k === "rule") k = "program"; if (c[k] != null) c[k]++; else c.demo++; };
    S.构件.forEach(p => bump(p.状态));
    S.实测.forEach(d => bump(d.状态));
    S.现状.forEach(x => bump(x.状态));
    Object.keys(S.任务卡).forEach(k => bump(S.任务卡[k].来源));
    return c;
  }

  return { badge, name, desc, summarize, DEF };
})();
