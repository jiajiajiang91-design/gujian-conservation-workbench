/* 视图：记录现状。空间关系、构造、可见残损与不可见部位。 */
window.ViewCondition = function (root) {
  const S = Store.get();
  const data = UI.el("div", "pane-data");
  const body = UI.el("div", "pane-body");
  data.appendChild(body);
  const evi = UI.el("div", "pane-evi");

  const rows = S.现状.map(c =>
    '<tr class="row" data-p="' + UI.esc(c.部位) + '">' +
    "<td>" + UI.esc(c.部位) + "</td>" +
    "<td>" + UI.esc(c.项目) + "</td>" +
    "<td>" + UI.esc(c.内容) + '<div class="hint">' + UI.esc(c.依据) + "</div></td>" +
    "<td>" + UI.stateBadge(c.状态) + "</td></tr>"
  ).join("");
  const 待复查 = S.现状.filter(c => c.状态 === "unknown" || c.状态 === "missing");
  const 待复查说明 = 待复查.length
    ? 待复查.map(c => "<b>" + UI.esc(c.部位) + "</b>：" + UI.esc(c.内容) +
      '<div class="hint">' + UI.esc(c.依据) + "</div>").join('<div style="height:8px"></div>')
    : '<span class="hint">当前没有标为待确认或资料缺失的现状项。</span>';

  body.innerHTML =
    '<div class="pane-title"><span>现状记录</span><span class="hint">空间关系与保存状况</span></div>' +
    '<div class="card">' + UI.table(["部位", "项目", "内容", "状态"], [rows]) + "</div>" +
    '<div class="card" style="border-color:var(--alert);background:var(--alert-soft)">' +
    '<div class="card-title">待复查或资料缺失 ' + 待复查.length + " 项</div>" +
    '<div class="hint" style="line-height:1.9">' + 待复查说明 + "</div></div>" +
    '<div class="card"><div class="card-title">需要专业人员确认</div>' +
    '<div class="hint" style="line-height:1.9">' +
    "AI 可以根据照片整理空间关系，但保存状况、病害性质与年代结论必须由专业人员现场判断。" +
    "国家文物局要求这类结论结合历史调查、现场探查和必要检测，照片只能提供可见线索。</div></div>";

  root.appendChild(data);
  root.appendChild(evi);
  Evidence.mount(evi, ProjectData.resolveResource(DATA.资源.斜视图 || DATA.资源.主图), { draw: false });

  UI.actionBar(data, [
    { label: "记录无误，设置出图方式", primary: true,
      onClick: () => { Store.setStep("condition", "done"); Store.setStep("style", "stop"); Store.goto("style"); } },
    { label: "标记待现场复查", onClick: () => {
        const item = 待复查[0];
        Store.log("待复查", item ? item.部位 : DATA.项目.名称, "现场复查未确认的现状项");
        Store.say("ai", "已记入待复查清单，会写进交付说明的限制条件。");
      } },
    { label: "回构件清单", onClick: () => Store.goto("parts") }
  ], "这里记录照片中的可见线索；保存状况和病害结论仍需专业人员在现场确认。");
};
