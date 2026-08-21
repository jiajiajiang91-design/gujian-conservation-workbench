/* 视图：核对实测。左边助手从手写草图读出的尺寸，未标注部位的置顶等待确认。 */
window.ViewDatum = function (root) {
  const S = Store.get();
  const data = UI.el("div", "pane-data");
  const body = UI.el("div", "pane-body");
  data.appendChild(body);
  const evi = UI.el("div", "pane-evi");

  function paint() {
    const 待定 = S.实测.filter(d => d.状态 === "unknown");
    const 已定 = S.实测.filter(d => d.状态 !== "unknown");

    let 待定块 = "";
    if (待定.length) {
      待定块 = '<div class="card" style="border-color:var(--warn);background:var(--warn-soft)">' +
        '<div class="card-title">' + 待定.length + " 个数值不知道量的是哪里</div>" +
        '<div class="hint" style="margin-bottom:8px">草图上只有数字，没有标注测量部位。请逐条确认，系统不会自行补填。</div>' +
        待定.map(d =>
          '<div style="display:flex;gap:8px;align-items:center;margin-bottom:6px">' +
          '<span class="mono" style="width:70px">' + d.数值 + " mm</span>" +
          '<select data-id="' + d.id + '" class="pick" style="flex:1;padding:4px 6px;border:1px solid var(--line);border-radius:3px">' +
          '<option value="">请选择部位</option>' +
          ["柱宽", "额枋高", "檐出", "台基挑出", "踏步宽", "柱础高"].map(x =>
            '<option value="' + x + '">' + x + "</option>").join("") +
          "</select></div>"
        ).join("") +
        "</div>";
    }

    const 行 = 已定.map(d =>
      "<tr><td>" + UI.esc(d.部位) + "</td><td class=\"mono\">" + d.数值 + " " + d.单位 + "</td>" +
      "<td>" + UI.esc(d.方式) + "</td><td>" + UI.stateBadge(d.状态) + "</td></tr>"
    ).join("");

    // 程序核对：确定性计算交给规则，不交给模型
    const 检查 = window.DatumCheck.run(S.实测);
    let 检查块 = "";
    if (检查.length) {
      检查块 = '<div class="card" style="border-color:var(--alert);background:var(--alert-soft)">' +
        '<div class="card-title">自动核对发现 ' + 检查.length + " 处不一致</div>" +
        检查.map(c =>
          '<div style="padding:5px 0;border-bottom:1px solid rgba(166,106,90,.25)">' +
          "<b>" + UI.esc(c.标题) + "</b>" +
          '<div class="mono" style="margin:2px 0">' + UI.esc(c.算式) + "</div>" +
          '<div class="hint">' + UI.esc(c.说明) + "</div></div>").join("") +
        '<div class="hint" style="margin-top:8px">这些结果按固定公式计算，可以重复验证。请根据现场记录确认应采用哪一项尺寸。</div></div>';
    }

    body.innerHTML =
      '<div class="pane-title"><span>尺寸记录</span><span class="hint">来源：' + UI.esc(S.实测来源 || "项目数据") + "</span></div>" +
      待定块 + 检查块 +
      '<div class="card"><div class="card-title">当前尺寸记录</div>' +
      UI.table(["部位", "数值", "测量方式", "状态"], [行]) +
      '<div class="hint" style="margin-top:8px">其中 ' + S.实测.filter(d => d.状态 === "measured").length +
      " 项有现场实测来源；示例、人工判断和估算值不能自动成为正式比例基准。</div></div>";

    data.querySelectorAll("select.pick").forEach(sel => {
      sel.onchange = () => {
        const d = S.实测.find(x => x.id === sel.dataset.id);
        if (!d || !sel.value) return;
        d.部位 = sel.value;
        d.状态 = S.实测来源 === "用户上传的草图" ? "measured" : "human";
        d.可用于正式交付 = d.状态 === "measured";
        d.说明 = "由人工指认部位；来源性质不因指认自动改变";
        Store.log("确认实测部位", sel.value, d.数值 + "mm 由李工指认");
        Store.emit();
        paint();
        // 三项都指认完，编排层继续往下走
        if (!S.实测.some(x => x.状态 === "unknown") && S.步骤状态.datum === "stop") {
          Store.say("ai", "三个尺寸的部位都已确认，可以建立比例基准并继续识别构件。");
          setTimeout(() => Orchestrator.runRecognize(), 400);
        }
      };
    });
  }

  function bar() {
    const 待定 = S.实测.filter(d => d.状态 === "unknown").length;
    const old = data.querySelector(".action-bar");
    if (old) old.remove();
    UI.actionBar(data, [
      { label: 待定 ? "还有 " + 待定 + " 个尺寸待确认" : "尺寸记录已核对，识别构件",
        primary: true, disabled: !!待定,
        onClick: () => Orchestrator.runRecognize() },
      { label: "跳过，直接按估算出图", danger: true, onClick: () => {
          Store.get().降级 = true;
          Store.say("ai", "好。没有完整基准，成果全程标为草图，正式交付包会锁住。");
          Orchestrator.runRecognize();
        } },
      { label: "回资料核对", onClick: () => Store.goto("materials") }
    ], 待定 ? "左边逐条指认部位；来源性质不会因指认自动改变。"
      : S.实测.some(d => d.状态 === "measured")
        ? S.实测.filter(d => d.状态 === "measured").length + " 项现场实测可作为当前比例基准。"
        : "当前没有现场实测基准，继续后只能生成草图或代理验证结果。");
  }

  root.appendChild(data);
  root.appendChild(evi);
  paint();
  bar();
  Store.subView(() => { paint(); bar(); });
  evi.innerHTML =
    '<div class="evi-tools">现场手写尺寸草图 · 黄底数值需要确认部位</div>' +
    '<div style="flex:1;display:flex;align-items:center;justify-content:center;padding:24px">' +
    '<div style="background:#fff;border:1px solid var(--line);padding:22px 26px;max-width:420px;font-family:var(--mono);font-size:12.5px;line-height:2.1">' +
    "<div style=\"color:var(--ink-3);margin-bottom:10px\">草图第 1 张 · 识别出的尺寸</div>" +
    '<pre style="white-space:pre-wrap;font:inherit;margin:0">' + UI.esc(DATA.草图转写 || "未提供尺寸草图") + "</pre>" +
    "<div class=\"hint\" style=\"margin-top:12px\">待确认数值不会由系统自行匹配部位</div>" +
    "</div></div>";
};
