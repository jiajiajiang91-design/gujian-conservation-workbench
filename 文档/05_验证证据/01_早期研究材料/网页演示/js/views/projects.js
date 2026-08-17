// 屏：项目列表（入口）
Router.register("projects", function (root) {
  UI.header(root, "项目列表");

  const list = UI.el("div");
  Store.projects().forEach(p => {
    const units = Store.units(p.id);
    const card = UI.el("div", { class: "card clickable", onclick: () => Router.go("project/" + p.id) }, [
      UI.el("h2", null, [p.名称]),
      UI.el("div", { class: "hint" }, [`委托方：${p.委托方}　负责人：${p.负责人}　创建：${p.创建日期}　建筑单元：${units.length} 个`]),
      UI.el("div", { style: "margin-top:8px; display:flex; gap:8px;" },
        units.map(u => UI.badge(u.状态)))
    ]);
    list.appendChild(card);
  });
  if (!Store.projects().length) list.appendChild(UI.el("div", { class: "empty" }, ["还没有项目。点击下方按钮新建第一个项目。"]));
  root.appendChild(list);

  root.appendChild(UI.el("div", { class: "btnbar" }, [
    UI.el("button", { class: "primary", onclick: () => Router.go("project-new") }, ["＋ 新建项目"])
  ]));
});

// 屏：新建项目
Router.register("project-new", function (root) {
  UI.header(root, "新建项目", "projects", "项目列表");
  const card = UI.el("div", { class: "card" });
  const 名称 = UI.el("input", { type: "text", placeholder: "例：某县某庙修缮勘察" });
  const 委托方 = UI.el("input", { type: "text", placeholder: "委托单位名称" });
  const 负责人 = UI.el("input", { type: "text", placeholder: "项目负责人姓名" });
  card.appendChild(UI.field("项目名称（文字输入）", 名称));
  card.appendChild(UI.field("委托方（文字输入）", 委托方));
  card.appendChild(UI.field("项目负责人（文字输入）", 负责人));
  card.appendChild(UI.el("div", { class: "hint" }, ["项目是交付和审核的单位，一个项目下可以有多个建筑单元（一殿一单元）。"]));
  card.appendChild(UI.el("div", { class: "btnbar" }, [
    UI.el("button", { class: "primary", onclick: () => {
      if (!名称.value.trim()) { 名称.focus(); return; }
      const id = Store.addProject(名称.value.trim(), 委托方.value.trim() || "（未填）", 负责人.value.trim() || "（未填）");
      Router.go("project/" + id);
    } }, ["创建项目"]),
    UI.el("button", { onclick: () => Router.go("projects") }, ["取消"])
  ]));
  root.appendChild(card);
});

// 屏：项目详情（建筑单元列表）
Router.register("project", function (root, args) {
  const p = Store.project(args[0]);
  if (!p) { Router.go("projects"); return; }
  UI.header(root, p.名称, "projects", "项目列表");

  const units = Store.units(p.id);
  units.forEach(u => {
    root.appendChild(UI.el("div", { class: "card clickable", onclick: () => Router.go("unit/" + u.id) }, [
      UI.el("div", { style: "display:flex; justify-content:space-between; align-items:center;" }, [
        UI.el("h2", { style: "border:none; margin:0; padding:0;" }, [u.名称]),
        UI.badge(u.状态)
      ]),
      UI.el("div", { class: "hint", style: "margin-top:8px;" },
        [`${u.省市县.join(" / ")}　${u.保护级别}　${u.年代}代　${u.结构类型}　${u.屋顶形式}顶　图纸版本：${u.图纸版本 ? "v" + u.图纸版本 : "尚未出图"}`])
    ]));
  });
  if (!units.length) root.appendChild(UI.el("div", { class: "empty" }, ["此项目还没有建筑单元。先新建一个建筑单元（一殿一单元）。"]));

  root.appendChild(UI.el("div", { class: "btnbar" }, [
    UI.el("button", { class: "primary", onclick: () => Router.go("unit-new/" + p.id) }, ["＋ 新建建筑单元"])
  ]));
});

// 屏：新建建筑单元
Router.register("unit-new", function (root, args) {
  const p = Store.project(args[0]);
  if (!p) { Router.go("projects"); return; }
  UI.header(root, "新建建筑单元", "project/" + p.id, p.名称);

  const 词 = Store.词表();
  const card = UI.el("div", { class: "card" });
  const 名称 = UI.el("input", { type: "text", placeholder: "例：玉皇庙主殿" });
  const 省 = UI.el("input", { type: "text", placeholder: "省" });
  const 市 = UI.el("input", { type: "text", placeholder: "市" });
  const 县 = UI.el("input", { type: "text", placeholder: "县（区）" });
  let v级别 = 词.保护级别[1], v年代 = "待考", v结构 = 词.结构类型[0], v屋顶 = 词.屋顶形式[2];

  const grid = UI.el("div", { class: "form-grid" });
  grid.appendChild(UI.field("单元名称（文字输入）", 名称));
  grid.appendChild(UI.field("保护级别（下拉选择）", UI.select(词.保护级别, v级别, v => v级别 = v)));
  grid.appendChild(UI.field("年代（下拉选择）", UI.select(词.年代, v年代, v => v年代 = v)));
  grid.appendChild(UI.field("结构类型（下拉选择）", UI.select(词.结构类型, v结构, v => v结构 = v)));
  grid.appendChild(UI.field("屋顶形式（下拉选择）", UI.select(词.屋顶形式, v屋顶, v => v屋顶 = v)));
  const addr = UI.el("div", { style: "display:flex; gap:8px;" }, [省, 市, 县]);
  grid.appendChild(UI.field("所在地（省 / 市 / 县）", addr));
  card.appendChild(grid);
  card.appendChild(UI.el("div", { class: "hint" }, ["保护级别、年代、结构类型、屋顶形式是受控词表（下拉），驱动后续图纸模板和归档统计；名称与地名是专名（文字输入）。"]));
  card.appendChild(UI.el("div", { class: "btnbar" }, [
    UI.el("button", { class: "primary", onclick: () => {
      if (!名称.value.trim()) { 名称.focus(); return; }
      const id = Store.addUnit(p.id, {
        名称: 名称.value.trim(),
        省市县: [省.value.trim() || "（省）", 市.value.trim() || "（市）", 县.value.trim() || "（县）"],
        保护级别: v级别, 年代: v年代, 结构类型: v结构, 屋顶形式: v屋顶
      });
      Router.go("unit/" + id);
    } }, ["创建单元"]),
    UI.el("button", { onclick: () => Router.go("project/" + p.id) }, ["取消"])
  ]));
  root.appendChild(card);
});
