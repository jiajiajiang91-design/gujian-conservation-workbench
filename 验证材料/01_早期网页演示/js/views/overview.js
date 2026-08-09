// 屏7：识别结果概览（只读，对应原型屏7；确认后进入屏8 人工校正）
Router.register("overview", function (root, args) {
  const u = Store.unit(args[0]);
  if (!u) { Router.go("projects"); return; }
  UI.header(root, "识别结果概览 · " + u.名称, "unit/" + u.id, "工作区");

  if (!u.部件.length) {
    root.appendChild(UI.el("div", { class: "warn" }, ["还没有识别结果。"]));
    root.appendChild(UI.el("a", { class: "btn", href: "#/recognize/" + u.id }, ["去识别"]));
    return;
  }

  // 统计卡
  const conf = { 高: 0, 中: 0, 低: 0 };
  u.部件.forEach(p => { if (conf[p.置信度] !== undefined) conf[p.置信度]++; });
  const row = UI.el("div", { class: "row" });
  row.appendChild(UI.el("div", { class: "card" }, [
    UI.el("h2", null, ["识别统计"]),
    UI.table(["项", "值"], [
      ["部件总数", u.部件.length],
      ["置信度高", conf.高], ["置信度中（需重点核对）", conf.中], ["置信度低（需重点核对）", conf.低],
      ["照片数", u.照片.length],
      ["实测尺寸条数", u.实测尺寸.length + (u.实测尺寸.length ? "" : "（全部尺寸标（估））")]
    ])
  ]));
  if (u.核心尺寸.length) {
    row.appendChild(UI.el("div", { class: "card" }, [
      UI.el("h2", null, ["核心控制尺寸"]),
      UI.table(["名称", "数值 mm"], u.核心尺寸.map(d => [d.名称, d.数值]))
    ]));
  }
  root.appendChild(row);

  if (u.形制说明) root.appendChild(UI.el("div", { class: "card" }, [UI.el("h2", null, ["形制说明（模型输出）"]), UI.el("div", { class: "hint" }, [u.形制说明])]));

  // 部件清单（只读）
  root.appendChild(UI.el("div", { class: "card" }, [
    UI.el("h2", null, ["部件清单（只读，修改到下一步人工校正）"]),
    UI.table(["编号", "名称", "类别", "尺寸标注", "置信度", "识别依据/提示"],
      u.部件.map(p => [p.编号, p.名称, p.类别, p.尺寸 || "", UI.el("span", { class: "conf-" + p.置信度 }, [p.置信度]), p.提示 || ""]))
  ]));

  root.appendChild(UI.el("div", { class: "btnbar" }, [
    UI.el("a", { class: "btn primary", href: "#/parts/" + u.id }, ["进入人工校正 →"]),
    UI.el("a", { class: "btn", href: "#/recognize/" + u.id }, ["重新识别"])
  ]));
});

// 设置：API key（真识别开关）
Router.register("settings", function (root) {
  UI.header(root, "设置", "projects", "项目列表");
  const card = UI.el("div", { class: "card" }, [UI.el("h2", null, ["Claude API key（真实识别）"])]);
  const input = UI.el("input", { type: "text", value: API.getKey(), placeholder: "sk-ant-..." });
  card.appendChild(UI.field("API key（只存本机浏览器 localStorage，不发送到除 api.anthropic.com 以外的任何地方）", input));
  card.appendChild(UI.el("div", { class: "hint" }, [
    "填入后，识别环节会把上传的照片发给 Claude 多模态模型做真实部件识别；不填则用模拟模式。",
    UI.el("br"), "key 在 console.anthropic.com 创建。单次识别成本约 0.05 到 0.2 元人民币量级。"
  ]));
  card.appendChild(UI.el("div", { class: "btnbar" }, [
    UI.el("button", { class: "primary", onclick: () => { API.setKey(input.value); alert(input.value.trim() ? "已保存" : "已清除"); } }, ["保存"]),
    UI.el("button", { onclick: () => { input.value = ""; API.setKey(""); alert("已清除"); } }, ["清除 key"])
  ]));
  root.appendChild(card);
});
