// 屏：识别结果概览与人工校正（工作流环节三：交叉验证/校正）
Router.register("parts", function (root, args) {
  const u = Store.unit(args[0]);
  if (!u) { Router.go("projects"); return; }
  UI.header(root, "识别结果与人工校正 · " + u.名称, "unit/" + u.id, "工作区");

  if (u.状态 === "草稿") Store.transition(u.id, "校正中");
  if (u.状态 === "已出图") {
    root.appendChild(UI.el("div", { class: "warn" }, [
      "当前状态是已出图（v" + u.图纸版本 + "）。修改识别结果需要先重开校正，重新出图后版本号递增。",
      UI.el("div", { class: "btnbar" }, [
        UI.el("button", { onclick: () => { Store.transition(u.id, "校正中"); Router.render(); } }, ["重开校正"])
      ])
    ]));
    // 已出图状态下表格只读展示
  }
  const editable = Store.unit(u.id).状态 === "校正中" || Store.unit(u.id).状态 === "校正完成";
  const 词 = Store.词表();

  // 部件表
  const card = UI.el("div", { class: "card" }, [UI.el("h2", null, ["部件清单（AI 识别输出，逐项校正）"])]);
  const holder = UI.el("div");
  function draw() {
    const uu = Store.unit(u.id);
    holder.innerHTML = "";
    holder.appendChild(UI.table(["编号", "名称", "类别（下拉）", "尺寸标注", "置信度", "来源", "提示", editable ? "操作" : ""],
      uu.部件.map((pt, i) => [
        pt.编号,
        editable ? UI.el("input", { type: "text", value: pt.名称, onchange: e => { Store.mutate(u.id, x => x.部件[i].名称 = e.target.value); Store.correct(u.id, pt.编号, "修改", "名称改为 " + e.target.value); refreshLog(); } }) : pt.名称,
        editable ? UI.select(词.部位, pt.类别, v => { Store.mutate(u.id, x => x.部件[i].类别 = v); Store.correct(u.id, pt.编号, "修改", "类别改为 " + v); refreshLog(); }) : pt.类别,
        editable ? UI.el("input", { type: "text", value: pt.尺寸 || "", onchange: e => { Store.mutate(u.id, x => x.部件[i].尺寸 = e.target.value); Store.correct(u.id, pt.编号, "修改", "尺寸改为 " + e.target.value); refreshLog(); } }) : (pt.尺寸 || ""),
        UI.el("span", { class: "conf-" + pt.置信度 }, [pt.置信度]),
        pt.来源,
        pt.提示 || "",
        editable ? UI.el("button", { style: "font-size:12px; padding:3px 8px;", onclick: () => { Store.mutate(u.id, x => x.部件.splice(i, 1)); Store.correct(u.id, pt.编号, "删除", pt.名称); draw(); refreshLog(); } }, ["删"]) : ""
      ])));
  }
  draw();
  card.appendChild(holder);
  if (editable) {
    card.appendChild(UI.el("div", { class: "btnbar" }, [
      UI.el("button", { onclick: () => {
        Store.mutate(u.id, x => {
          const n = "P" + String(x.部件.length + 1).padStart(2, "0");
          x.部件.push({ 编号: n, 名称: "（新增部件）", 类别: 词.部位[0], 置信度: "人工", 尺寸: "", 来源: "人工新增" });
          Store.correct(u.id, n, "新增", "人工补录部件");
        });
        draw(); refreshLog();
      } }, ["＋ 人工补录部件"]),
      UI.el("span", { class: "hint" }, ["置信度中低的行优先核对。每次修改自动计入校正记录，是修正率指标的数据来源。"])
    ]));
  }
  root.appendChild(card);

  // 核心尺寸
  if (u.核心尺寸.length) {
    root.appendChild(UI.el("div", { class: "card" }, [
      UI.el("h2", null, ["核心控制尺寸"]),
      UI.table(["名称", "数值 mm"], Store.unit(u.id).核心尺寸.map(d => [d.名称, d.数值])),
      UI.el("div", { class: "hint", style: "margin-top:8px;" }, ["标（估）的值由照片比例推算，实测后在环节 2 录入即自动替换标注。"])
    ]));
  }

  // 校正记录
  const logCard = UI.el("div", { class: "card" }, [UI.el("h2", null, ["校正记录"])]);
  const logHolder = UI.el("div");
  function refreshLog() {
    const uu = Store.unit(u.id);
    logHolder.innerHTML = "";
    if (uu.校正记录.length) logHolder.appendChild(UI.table(["时间", "部件", "动作", "内容"], uu.校正记录.map(r => [r.时间, r.部件, r.动作, r.内容])));
    else logHolder.appendChild(UI.el("div", { class: "hint" }, ["尚无校正动作。"]));
  }
  refreshLog();
  logCard.appendChild(logHolder);
  root.appendChild(logCard);

  // 完成校正
  if (editable) {
    root.appendChild(UI.el("div", { class: "btnbar" }, [
      UI.el("button", { class: "primary", onclick: () => {
        if (Store.unit(u.id).状态 === "校正中") Store.transition(u.id, "校正完成");
        Router.go("output/" + u.id);
      } }, ["校正完成，进入出图 →"]),
      UI.el("span", { class: "hint" }, ["确认全部部件无误后进入出图。之后仍可重开校正。"])
    ]));
  }
});
