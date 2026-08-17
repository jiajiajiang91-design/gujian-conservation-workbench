// 屏12：负责人审核（07 PRD R006：审核门可选，小所单人模式可跳过）
Router.register("review", function (root, args) {
  const u = Store.unit(args[0]);
  if (!u) { Router.go("projects"); return; }
  UI.header(root, "负责人审核 · " + u.名称, "output/" + u.id, "出图与交付");

  if (u.状态 !== "已出图") {
    root.appendChild(UI.el("div", { class: "warn" }, ["尚未出图，无可审核的图纸。"]));
    return;
  }

  const card = UI.el("div", { class: "card" }, [
    UI.el("h2", null, [`待审核：${u.名称} ${u.出图设置.视图}现状图 v${u.图纸版本}（${u.出图设置.比例}　${u.出图设置.图幅}　图号 ${u.出图设置.图号 || "未填"}）`])
  ]);
  if (u.立面图) card.appendChild(UI.el("div", { class: "drawing-preview" }, [UI.el("img", { src: u.立面图 })]));
  else card.appendChild(UI.el("div", { class: "drawing-preview", html: u.生成图svg || Drawing.build(u).svg }));
  const audit = u.审计 || Drawing.build(u).审计;
  card.appendChild(UI.el("ul", { class: "checklist", style: "margin-top:12px;" }, [
    UI.el("li", null, [`结构审计：实体 ${audit.实体数}，错误 ${audit.错误数}`]),
    UI.el("li", null, [`人工校正 ${u.校正记录.length} 次，记录可追溯`]),
    UI.el("li", null, [u.实测尺寸.length ? `实测尺寸 ${u.实测尺寸.length} 条，其余标（估）` : "无实测，全部尺寸标（估），交付说明中已声明"])
  ]));
  root.appendChild(card);

  const opCard = UI.el("div", { class: "card" }, [UI.el("h2", null, ["审核意见"])]);
  const 意见 = UI.el("textarea", { rows: "3", placeholder: "退回时必填修改意见" });
  opCard.appendChild(意见);
  opCard.appendChild(UI.el("div", { class: "btnbar" }, [
    UI.el("button", { class: "primary", onclick: () => {
      Store.mutate(u.id, x => x.审核 = { 结果: "通过", 意见: 意见.value.trim(), 时间: Store.now(), 版本: "v" + x.图纸版本 });
      Router.go("output/" + u.id);
    } }, ["审核通过"]),
    UI.el("button", { onclick: () => {
      if (!意见.value.trim()) { 意见.focus(); return; }
      Store.mutate(u.id, x => x.审核 = { 结果: "退回", 意见: 意见.value.trim(), 时间: Store.now(), 版本: "v" + x.图纸版本 });
      Store.transition(u.id, "校正中");   // 退回即重开校正，下次出图版本递增
      Router.go("parts/" + u.id);
    } }, ["退回修改"]),
    UI.el("span", { class: "hint" }, ["退回后状态回到校正中，修改后重新出图版本递增。"])
  ]));
  if (u.审核) opCard.appendChild(UI.el("div", { class: "hint", style: "margin-top:8px;" },
    [`最近审核：${u.审核.版本} ${u.审核.结果}（${u.审核.时间}）${u.审核.意见 ? "，意见：" + u.审核.意见 : ""}`]));
  root.appendChild(opCard);
});
