/* 视图：出图与检查。
   证据区两个标签：
   正式图纸 = poc 里参数化脚本真实跑出来的 DXF 渲染结果，这是产品要交付的东西；
   数据校核图 = 按当前构件数据实时画的 SVG，用来核对数据是否齐全、改动有没有生效。
   两者不是二选一：正式图证明专业性，校核图证明数据驱动。 */
window.ViewDrawing = function (root) {
  const S = Store.get();
  const data = UI.el("div", "pane-data");
  const body = UI.el("div", "pane-body");
  const evi = UI.el("div", "pane-evi");
  data.appendChild(body);

  let 图标签 = "formal";   // formal | check
  let 画环境 = false;

  function paint() {
    const auto = S.检查问题.filter(c => c.处理 === "auto");
    const pend = S.检查问题.filter(c => c.处理 === "pending");
    const done = S.检查问题.filter(c => c.处理 === "resolved");
    const 未决构件 = S.存疑.filter(q => !q.已解决).length;

    let html = '<div class="pane-title"><span>图纸检查</span>' +
      '<span class="hint">根据当前资料重新检查</span></div>';

    if (!S.检查已运行) {
      html += '<div class="card" style="border-color:var(--warn);background:var(--warn-soft)">' +
        '<div class="card-title">尚未按当前数据运行检查</div>' +
        '<div class="hint">请先点击“按当前资料重新出图”，再处理检查问题。浏览静态预览不等于检查完成。</div></div>';
    }

    if (auto.length) {
      html += '<div class="card"><div class="card-title">已自动处理 ' + auto.length + " 项</div>" +
        auto.map(c => '<div style="padding:4px 0;border-bottom:1px solid var(--line-soft)">' +
          '<span class="badge">' + UI.esc(c.类型) + "</span> " + UI.esc(c.标题) +
          '<div class="hint">' + UI.esc(c.说明) + "</div></div>").join("") +
        '<div class="hint" style="margin-top:8px">这些问题有明确的检查规则，系统已经修正并保留记录。</div></div>';
    }

    if (pend.length) {
      html += '<div class="card" style="border-color:var(--warn);background:var(--warn-soft)">' +
        '<div class="card-title">需要你决定 ' + pend.length + " 项</div>" +
        pend.map(c =>
          '<div style="padding:8px 0;border-bottom:1px solid rgba(168,149,90,.3)">' +
          '<span class="badge warn">' + UI.esc(c.类型) + "</span> <b>" + UI.esc(c.标题) + "</b>" +
          '<div class="hint" style="margin:3px 0 2px">' + UI.esc(c.说明) + "</div>" +
          '<div class="hint mono">位置：' + UI.esc(c.位置 || "") + "</div>" +
          '<div class="msg-opts">' + (c.选项 || []).map((o, i) =>
            '<button class="msg-opt" data-c="' + c.id + '" data-i="' + i + '">' + UI.esc(o) + "</button>").join("") +
          "</div></div>").join("") + "</div>";
    }

    if (done.length) {
      html += '<div class="card"><div class="card-title">已处理 ' + done.length + " 项</div>" +
        done.map(c => '<div style="padding:4px 0"><span class="badge human">已定</span> ' +
          UI.esc(c.标题) + '<div class="hint">处理方式：' + UI.esc(c.结论) + "</div></div>").join("") + "</div>";
    }

    const 实测数 = S.实测.filter(d => d.状态 === "measured").length;
    const 估算数 = S.构件.filter(p => /（估）|\(估\)/.test(p.尺寸 || "")).length;
    const 草图 = 实测数 === 0 || S.降级 || DATA.项目.可对外正式交付 === false;
    html += '<div class="card"><div class="card-title">图纸信息</div><dl class="kv">' +
      "<dt>比例</dt><dd>" + UI.esc((S.任务卡.比例 && S.任务卡.比例.值) || "未确定") + "</dd>" +
      "<dt>构件</dt><dd>" + S.构件.length + " 项</dd>" +
      "<dt>估算尺寸</dt><dd>" + 估算数 + " 项</dd>" +
      "<dt>尺寸依据</dt><dd>" + 实测数 + " 项实测控制尺寸</dd>" +
      "<dt>成果性质</dt><dd>" + (草图
        ? '<span class="badge alert">草图，不能正式交付</span>'
        : '<span class="badge measured">正式成果</span>') + "</dd></dl>" +
      '<div class="hint" style="margin-top:8px">右侧「正式图纸」用于检查最终表达；「校核预览」用于查看当前构件资料是否完整。</div></div>';

    body.innerHTML = html;

    body.querySelectorAll(".msg-opt").forEach(b => {
      b.onclick = () => {
        const c = S.检查问题.find(x => x.id === b.dataset.c);
        c.处理 = "resolved";
        c.结论 = c.选项[+b.dataset.i];
        Store.log("处理检查问题", c.标题, "选择：" + c.结论);
        Store.say("sys", "已按你的选择处理：" + c.标题 + " → " + c.结论);
        Store.emit();
      };
    });

    // 底部操作条。paint 会反复调用，先清掉上一个再加，否则会叠出多份
    const 剩 = pend.length + 未决构件;
    const old = data.querySelector(".action-bar");
    if (old) old.remove();
    UI.actionBar(data, [
      { label: !S.检查已运行 ? "尚未运行检查" : 剩 ? "还有 " + 剩 + " 项待确认" : "检查完成，整理交付文件",
        primary: true, disabled: !S.检查已运行 || !!剩,
        onClick: () => Orchestrator.afterDrawing() },
      { label: "按当前资料重新出图", onClick: () => {
          S.检查问题 = window.CheckRules.run(S);
          S.检查已运行 = true;
          Store.log("重新出图", "正立面", "按当前数据重新绘制并重新检查");
          Store.say("sys", "已按当前数据重新出图并检查，共 " + S.检查问题.length + " 项。");
          Store.emit();
        } },
      { label: "回构件核对修改", onClick: () => Store.goto("parts") },
      { label: "退回上一环节", danger: true, onClick: () => Orchestrator.openReturn("drawing") }
    ], !S.检查已运行 ? "先按当前数据运行生成与检查。"
      : 剩 ? "仍有检查问题或构件存疑，处理完才能继续。" : "所有检查项已处理。");

    paintDrawing();
  }

  function paintDrawing() {
    const S0 = Store.get();
    const 草图 = S0.实测.filter(d => d.状态 === "measured").length === 0 || S0.降级 ||
      DATA.项目.可对外正式交付 === false;
    const 主体数 = S0.构件.filter(p => p.类别 !== "环境陈设").length;

    let tools = '<div class="evi-tools">' +
      '<button class="tab-mini' + (图标签 === "formal" ? " on" : "") + '" data-t="formal">正式图纸</button>' +
      '<button class="tab-mini' + (图标签 === "check" ? " on" : "") + '" data-t="check">校核预览</button>' +
      '<span style="margin-left:10px">' +
      (图标签 === "formal"
        ? "既有成果预览（与当前数据分开核对）"
        : "按当前资料生成，立面主体 " + 主体数 + " 项") + "</span>";
    if (图标签 === "check") {
      tools += '<label style="margin-left:auto;font-size:11.5px;cursor:pointer">' +
        '<input type="checkbox" id="ckEnv"' + (画环境 ? " checked" : "") + "> 显示环境陈设</label>";
    }
    tools += "</div>";

    let stage;
    if (图标签 === "formal") {
      const formal = S0.正式图资源 || {};
      const formalPath = ProjectData.resolveResource(formal);
      const formalStatus = formal.status === "stale" ? "已有预览已失效，需按当前数据重新生成"
        : formal.status === "current" ? "与当前数据一致" : "既有代理成果预览，不随当前数据自动更新";
      stage = '<div class="evi-stage" style="background:#eceae5;position:relative">' +
        '<div class="evi-wrap" style="max-width:960px">' +
        (formalPath ? '<img src="' + UI.esc(formalPath) + '" alt="正立面成果预览" style="width:100%">'
          : '<div class="empty">当前项目没有正式图预览</div>') +
        '<div class="hint" style="padding:6px 10px;background:#fff">' + UI.esc(formalStatus) + '</div>' +
        (草图 ? '<div class="draft-mark">草图　无实测基准　不作为正式测绘成果</div>' : "") +
        "</div></div>";
    } else {
      stage = '<div class="evi-stage" style="background:#eceae5;position:relative">' +
        '<div style="width:100%;max-width:940px;position:relative">' +
        window.DrawGen.render(S0, { 环境: 画环境 }) +
        (草图 ? '<div class="draft-mark">草图　无实测基准</div>' : "") +
        "</div></div>";
    }
    evi.innerHTML = tools + stage;

    evi.querySelectorAll(".tab-mini").forEach(b => {
      b.onclick = () => { 图标签 = b.dataset.t; paintDrawing(); };
    });
    const ck = evi.querySelector("#ckEnv");
    if (ck) ck.onchange = () => { 画环境 = ck.checked; paintDrawing(); };
  }

  root.appendChild(data);
  root.appendChild(evi);
  paint();
  Store.subView(() => paint());
};
