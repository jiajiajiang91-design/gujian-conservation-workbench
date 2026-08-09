/* 视图：核对构件。本形态的核心页面。
   左表与右图双向联动；在右图上拖框并在右栏说一句话即可完成修正。 */
window.ViewParts = function (root) {
  const S = Store.get();
  const data = UI.el("div", "pane-data");
  const body = UI.el("div", "pane-body");
  data.appendChild(body);
  const evi = UI.el("div", "pane-evi");
  let ev = null;

  function 存疑编号() {
    return S.存疑.filter(q => !q.已解决 && q.构件).map(q => q.构件);
  }

  function sortedParts() {
    const flags = 存疑编号();
    const a = S.构件.filter(p => flags.includes(p.编号));
    const b = S.构件.filter(p => !flags.includes(p.编号));
    return a.concat(b);
  }

  function paint() {
    const flags = 存疑编号();
    const list = sortedParts();
    const 未决 = S.存疑.filter(q => !q.已解决);

    const rows = list.map(p => {
      const f = flags.includes(p.编号);
      const sel = S.选中构件 === p.编号;
      return '<tr class="row' + (f ? " flag" : "") + (sel ? " sel" : "") + '" data-no="' + p.编号 + '">' +
        '<td class="mono">' + p.编号 + "</td>" +
        "<td>" + UI.esc(p.名称) +
          (p.人工结论 ? '<div class="hint">已判定：' + UI.esc(p.人工结论) + "</div>" : "") +
        "</td>" +
        "<td>" + UI.esc(p.类别) + "</td>" +
        "<td>" + UI.esc(p.尺寸 || "") + "</td>" +
        "<td>" + UI.stateBadge(p.状态) + " " + UI.confBadge(p.置信) + "</td></tr>";
    }).join("");

    let 存疑块 = "";
    if (未决.length) {
      存疑块 = '<section class="card question-queue">' +
        '<div class="queue-head"><div><div class="card-title">待确认问题</div>' +
        '<div class="hint">先处理影响构件身份和出图的判断</div></div>' +
        '<span class="queue-count">' + 未决.length + "</span></div>" +
        '<div class="question-list">' +
        未决.map(q =>
          '<button type="button" class="question-item" data-q="' + q.id + '">' +
          '<span class="question-title"><b>' + UI.esc(q.标题) + "</b>" +
          (q.构件 ? ' <span class="mono">' + q.构件 + "</span>" : "") + "</span>" +
          '<span class="question-summary">' + UI.esc(q.问题) + "</span>" +
          '<span class="question-meta"><span>需要：' + UI.esc(q.需要) +
          '</span><strong>查看判断 →</strong></span></button>'
        ).join("") + "</div></section>";
    }

    const sel = S.选中构件 ? Store.findPart(S.选中构件) : null;
    let 详情 = "";
    if (sel) {
      详情 = '<div class="card"><div class="card-title">' + sel.编号 + "　" + UI.esc(sel.名称) + "</div>" +
        '<dl class="kv"><dt>类别</dt><dd>' + UI.esc(sel.类别) + "</dd>" +
        "<dt>尺寸</dt><dd>" + UI.esc(sel.尺寸 || "未给出") + "</dd>" +
        "<dt>状态</dt><dd>" + UI.stateBadge(sel.状态) + "</dd>" +
        "<dt>判断依据</dt><dd>" + UI.esc(sel.依据) + "</dd></dl>" +
        '<div class="btn-row">' +
        '<button class="btn-line" id="btnWrong">这个认错了</button>' +
        '<button class="btn-line" id="btnNone">这里没有构件</button>' +
        "</div></div>";
    }

    body.innerHTML =
      '<div class="pane-title"><span>构件核对</span><span class="hint">共 ' + S.构件.length +
      " 项，其中 " + S.构件.filter(p => p.状态 === "measured").length + " 项有实测支持</span></div>" +
      存疑块 +
      '<div class="card parts-table-card"><div class="card-title">构件清单</div>' +
      UI.table(["编号", "名称", "类别", "尺寸", "状态"], [rows]) + "</div>" +
      详情;

    data.querySelectorAll("tr.row").forEach(tr => {
      tr.onclick = () => { Store.selectPart(tr.dataset.no); };
    });
    data.querySelectorAll(".question-item").forEach(d => {
      d.onclick = () => Orchestrator.openQuestion(d.dataset.q);
    });
    const bw = data.querySelector("#btnWrong");
    if (bw) bw.onclick = async () => {
      const nm = await UI.askText({
        title: "修改构件名称",
        desc: sel.编号 + " 现在记为「" + sel.名称 + "」。请填写现场确认后的名称，原记录会保留在修改历史中。",
        value: sel.名称, rows: 1, required: true, okLabel: "改正"
      });
      if (nm === null) return;
      Store.editPart(sel.编号, { 名称: nm }, "人工改正名称");
      Store.say("sys", "已把 " + sel.编号 + " 改为「" + nm + "」，本次修改已记入构件历史。");
    };
    const bn = data.querySelector("#btnNone");
    if (bn) bn.onclick = async () => {
      const ok = await UI.askConfirm({
        title: "确认这里没有构件",
        desc: "将删除 " + sel.编号 + "「" + sel.名称 + "」，并记入本项目排除记录，后续识别不再重复提出这一条。",
        okLabel: "确认删除", cancelLabel: "先不删"
      });
      if (!ok) return;
      Store.removePart(sel.编号, "人工判定该位置不存在构件");
      Store.say("sys", "已删除 " + sel.编号 + "，并记入本项目排除记录，后续识别不再重复提出。");
    };

    syncBoxes();
  }

  function syncBoxes() {
    if (!ev) return;
    const flags = 存疑编号();
    ev.setBoxes(S.构件.map(p => ({ no: p.编号, name: p.名称, box: p.框, flag: flags.includes(p.编号) })));
    ev.select(S.选中构件);
  }

  root.appendChild(data);
  root.appendChild(evi);

  // 用户上传过照片就用他的，否则用演示主图
  ev = Evidence.mount(evi, S.主图 || ProjectData.resolveResource(DATA.资源.主图), {
    draw: true,
    onSelect: no => { Store.selectPart(no); }
  });

  function bar() {
    const 剩 = S.存疑.filter(q => !q.已解决).length;
    const old = data.querySelector(".action-bar");
    if (old) old.remove();
    UI.actionBar(data, [
      { label: 剩 ? "还有 " + 剩 + " 个构件待确认" : "构件已核对，记录现状",
        primary: true, disabled: !!剩,
        onClick: () => Orchestrator.afterParts() },
      { label: "确认下一个构件", disabled: !剩, onClick: () => {
          const q = S.存疑.find(x => !x.已解决);
          if (q) Orchestrator.openQuestion(q.id);
        } },
      { label: "重新识别照片", onClick: () => Orchestrator.runRecognize() },
      { label: "回实测尺寸", onClick: () => Store.goto("datum") }
    ], "在右侧照片上框出位置，再说明漏项或错误，修改会保留记录。");
  }

  paint();
  bar();
  Store.subView(() => { paint(); bar(); });
};
