/* 视图：建立任务。左边是 AI 读任务书后填好的任务卡，右边是任务书原文，可点到出处。 */
window.ViewTask = function (root) {
  const S = Store.get();
  const data = UI.el("div", "pane-data");
  const body = UI.el("div", "pane-body");
  data.appendChild(body);
  const evi = UI.el("div", "pane-evi");

  // ---- 左：任务卡 ----
  let rows = "";
  Object.keys(S.任务卡).forEach(k => {
    const v = S.任务卡[k];
    const miss = v.来源 === "missing" || v.来源 === "缺";
    rows += '<tr class="row' + (miss ? " flag" : "") + '" data-src="' + UI.esc(v.出处) + '">' +
      "<td>" + UI.esc(k) + "</td>" +
      "<td>" + UI.esc(v.值) + "</td>" +
      "<td>" + UI.stateBadge(v.来源) + "</td>" +
      '<td class="mono">' + UI.esc(v.出处) + "</td></tr>";
  });

  let 人员行 = "";
  S.人员.forEach((p, i) => {
    const 空 = !p.姓名;
    人员行 += '<tr class="' + (空 ? "flag" : "") + '">' +
      "<td>" + UI.esc(p.角色) + "</td>" +
      '<td><input data-i="' + i + '" class="who" style="width:100%;border:1px solid var(--line);border-radius:3px;padding:3px 6px" value="' +
      UI.esc(p.姓名) + '" placeholder="未指定"></td>' +
      "<td>" + UI.esc(p.说明) + "</td></tr>";
  });

  body.innerHTML =
    '<div class="pane-title"><span>任务要求</span><span class="hint">已从任务书整理，请逐项核对</span></div>' +
    '<div class="card">' + UI.table(["要求", "内容", "依据", "原文位置"], [rows]) + "</div>" +
    '<div class="card"><div class="card-title">参与人员与检查要求</div>' +
    UI.table(["角色", "姓名", "职责"], [人员行]) +
    '<div class="hint" style="margin-top:8px">专业复核与责任签发必须指定到人。未指定时不能进入签发环节。</div></div>' +
    '<div class="card"><div class="card-title">开始工作前至少需要</div>' +
    '<div class="hint">当前成果：' + UI.esc((S.任务卡.成果类型 && S.任务卡.成果类型.值) || DATA.项目.成果) +
    '；比例：' + UI.esc((S.任务卡.比例 && S.任务卡.比例.值) || "未确定") +
    '；精度要求：' + UI.esc((S.任务卡.精度要求 && S.任务卡.精度要求.值) || "未确定") +
    '。至少需要覆盖目标成果的照片、可追溯的尺寸依据和资料来源记录。当前现场实测记录 ' +
    S.实测.filter(d => d.状态 === "measured").length + " 项。</div></div>";

  // ---- 右：任务书原文 ----
  evi.innerHTML =
    '<div class="evi-tools">委托任务书原文 · 点击左侧要求可核对出处</div>' +
    '<div style="flex:1;overflow:auto;padding:18px 22px;background:#fff">' +
    '<pre style="white-space:pre-wrap;font-family:inherit;font-size:12.5px;line-height:1.9">' +
    UI.esc(DATA.任务书原文) + "</pre></div>";

  root.appendChild(data);
  root.appendChild(evi);

  data.querySelectorAll("input.who").forEach(inp => {
    inp.onchange = () => {
      Store.get().人员[+inp.dataset.i].姓名 = inp.value.trim();
      Store.log("指定人员", Store.get().人员[+inp.dataset.i].角色, inp.value.trim() || "清空");
      Store.emit();
    };
  });

  const 缺基准 = !S.实测.some(d => d.状态 === "measured") ||
    (S.任务卡.实测基准 && ["missing", "缺"].includes(S.任务卡.实测基准.来源));
  UI.actionBar(data, [
    { label: "要求无误，核对资料", primary: true,
      onClick: () => { Store.setStep("task", "done"); Store.goto("materials"); } },
    { label: "我要传实测记录", onClick: () => {
        Store.say("user", "上周现场量过，尺寸记在纸上拍了照，我传给你。");
        Orchestrator.onChoice("datum-missing", "upload", "我有实测记录");
      } },
    { label: "先出草图", danger: true, onClick: () => {
        Store.say("user", "先出一版草图。");
        Orchestrator.onChoice("datum-missing", "draft", "先出一版草图");
      } }
  ], 缺基准 ? "缺少实测尺寸。补齐后才能出正式成果，否则只能生成草图。" : "确认无误后进入下一步。");
};
