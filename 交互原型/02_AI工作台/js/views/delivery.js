/* 视图：交付归档。文件清单、限制条件、权限、三级确认。 */
window.ViewDelivery = function (root) {
  const S = Store.get();
  const data = UI.el("div", "pane-data");
  const body = UI.el("div", "pane-body");
  data.appendChild(body);
  const evi = UI.el("div", "pane-evi");

  function paint() {
    const d = S.交付;
    const 文件行 = d.文件.map(f =>
      "<tr><td>" + UI.esc(f.名称) + "</td><td>" + UI.esc(f.类型) + "</td>" +
      '<td class="mono">' + UI.esc(f.大小) + "</td>" +
      "<td>" + (f.就绪 ? '<span class="badge measured">就绪</span>' : '<span class="badge alert">缺</span>') + "</td></tr>"
    ).join("");

    const 确认行 = d.确认.map((c, i) =>
      "<tr><td>" + UI.esc(c.环节) + "</td>" +
      "<td>" + (c.完成 ? UI.esc(c.人) : "未确认") + "</td>" +
      '<td class="mono">' + UI.esc(c.时间 || "") + "</td>" +
      "<td>" + (c.完成
        ? '<span class="badge human">已确认</span>'
        : '<button class="btn-line" data-ci="' + i + '" style="padding:2px 8px;font-size:11px">确认</button>') +
      "</td></tr>"
    ).join("");

    body.innerHTML =
      '<div class="pane-title"><span>交付归档</span><span class="hint">共 ' + d.文件.length + " 个文件</span></div>" +
      '<div class="card">' + UI.table(["文件", "类型", "大小", "状态"], [文件行]) + "</div>" +
      '<div class="card"><div class="card-title">限制条件说明</div>' +
      '<div class="hint" style="line-height:1.95">' +
      d.限制条件.map((x, i) => (i + 1) + ". " + UI.esc(x)).join("<br>") +
      "</div><div class=\"hint\" style=\"margin-top:8px;color:var(--ink-3)\">这段由 AI 助手起草，签发前请逐条核对。</div></div>" +
      '<div class="card"><div class="card-title">查看与导出权限</div><dl class="kv">' +
      "<dt>可查看</dt><dd>" + UI.esc(d.权限.查看) + "</dd>" +
      "<dt>可导出</dt><dd>" + UI.esc(d.权限.导出) + "</dd>" +
      "<dt>二次利用</dt><dd>" + UI.esc(d.权限.二次利用) + "</dd></dl></div>" +
      '<div class="card"><div class="card-title">三级确认</div>' +
      UI.table(["环节", "确认人", "时间", "操作"], [确认行]) +
      '<div class="hint" style="margin-top:8px">技术检查、专业复核和责任签发分别留痕。' +
      "这些确认不能由系统代替，正式文件必须由具备资质的责任人员签署。</div></div>";

    data.querySelectorAll("button[data-ci]").forEach(b => {
      b.onclick = async () => {
        const i = +b.dataset.ci;
        const 环节 = d.确认[i].环节;
        const 人 = await UI.askText({
          title: "确认" + 环节,
          desc: 环节 + "确认后会写入图签和交付记录，接收方可以查到是谁签的。\n" +
                (i === 2 ? "正式签发必须由具备资质的责任人员完成。" : ""),
          value: i === 2 ? "王工" : "李工",
          placeholder: "确认人姓名",
          rows: 1,
          required: true,
          okLabel: "确认"
        });
        if (人 === null) return;
        d.确认[i].完成 = true;
        d.确认[i].人 = 人;
        d.确认[i].时间 = new Date().toLocaleString("zh-CN", { hour12: false });
        Store.log("确认环节", d.确认[i].环节, 人 + " 确认");
        if (d.确认.every(x => x.完成)) {
          Store.setStep("delivery", "done");
          Store.say("ai", "三级确认已完成，交付包可以导出了。整个任务的修改记录共 " +
            S.修改记录.length + " 条，每条都能追到人、时间和依据。");
          Store.status("任务已完成", "成果已签发，可导出交付包", "idle");
        }
        Store.emit();
      };
    });
  }

  function bar() {
    const 未确认 = S.交付.确认.filter(c => !c.完成).length;
    const 未决 = S.存疑.filter(q => !q.已解决).length + S.检查问题.filter(c => c.处理 === "pending").length;
    const 预览失效 = !S.正式图资源 || S.正式图资源.status !== "current";
    const 代理项目 = DATA.项目.可对外正式交付 === false;
    const 草图 = S.实测.filter(d => d.状态 === "measured").length === 0 || S.降级 || 未决 > 0 || 预览失效 || 代理项目;
    const 阻断原因 = 代理项目 ? "当前是代理验证项目，不能对外正式签发。"
      : 未决 ? "仍有 " + 未决 + " 项未决问题。"
      : 预览失效 ? "当前没有与业务数据一致的正式图，需要重新生成。"
      : "缺少现场实测尺寸时不能导出正式成果。";
    const old = data.querySelector(".action-bar");
    if (old) old.remove();
    UI.actionBar(data, [
      { label: 草图 ? "当前不能正式交付"
              : 未确认 ? "还有 " + 未确认 + " 个环节未确认" : "导出交付包",
        primary: true, disabled: !!未确认 || 草图,
        onClick: () => {
          Store.log("导出交付包", "全部文件", "六个文件已导出");
          Store.say("ai", "交付包已导出。共 " + S.交付.文件.length + " 个文件，" +
            S.修改记录.length + " 条修改记录随包归档。");
          Store.status("任务已完成", "交付包已导出", "idle");
        } },
      { label: "导出结构化工作包", onClick: () => Store.downloadCurrent() },
      { label: "接收方退回", danger: true, onClick: () => Orchestrator.openReturn("delivery") },
      { label: "回图纸与检查", onClick: () => Store.goto("drawing") }
    ], 草图 ? 阻断原因
            : "技术检查、专业复核、责任签发三个环节分别留痕。");
  }

  root.appendChild(data);
  root.appendChild(evi);
  paint();
  bar();

  evi.innerHTML = '<div class="evi-tools">修改记录 · 可查看操作人、时间和原因</div>' +
    '<div style="flex:1;overflow:auto;padding:12px 14px;background:#fff">' +
    (S.修改记录.length
      ? S.修改记录.map(r =>
          '<div style="padding:6px 0;border-bottom:1px solid var(--line-soft);font-size:12px">' +
          '<span class="badge human">' + UI.esc(r.动作) + "</span> " +
          '<span class="mono">' + UI.esc(r.对象) + "</span>" +
          '<div class="hint">' + UI.esc(r.说明) + "</div>" +
          '<div class="hint">' + UI.esc(r.人) + "　" + UI.esc(r.时间) + "</div></div>").reverse().join("")
      : '<div class="empty">还没有修改记录</div>') +
    "</div>";

  Store.subView(() => { paint(); bar(); });
};
