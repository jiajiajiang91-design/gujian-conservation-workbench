// 屏：建筑单元工作区（枢纽页，展示状态机位置和五个环节入口）
Router.register("unit", function (root, args) {
  const u = Store.unit(args[0]);
  if (!u) { Router.go("projects"); return; }
  const p = Store.project(u.项目id);
  UI.header(root, u.名称, "project/" + p.id, p.名称);

  // 状态机可视化
  const flow = UI.el("div", { class: "state-flow" });
  ["草稿", "校正中", "校正完成", "已出图"].forEach((s, i) => {
    if (i) flow.appendChild(UI.el("span", null, ["→"]));
    flow.appendChild(UI.el("span", { class: "st" + (u.状态 === s ? " cur" : "") }, [s]));
  });
  flow.appendChild(UI.el("span", { class: "hint", style: "margin-left:12px;" },
    [u.图纸版本 ? `当前图纸版本 v${u.图纸版本}（重开校正后再出图版本递增）` : "尚未出图"]));
  root.appendChild(flow);

  // 基本信息
  root.appendChild(UI.el("div", { class: "card" }, [
    UI.el("h2", null, ["基本信息"]),
    UI.el("div", { class: "hint" },
      [`${u.省市县.join(" / ")}　${u.保护级别}　${u.年代}代　${u.结构类型}　${u.屋顶形式}顶`])
  ]));

  // 五个环节入口，按工作流顺序（09 报告五环节）
  const steps = [
    { path: "photos",  title: "1 照片上传与打标", info: `已上传 ${u.照片.length} 张`, ready: true },
    { path: "dims",    title: "2 实测尺寸录入", info: u.实测尺寸.length ? `已录 ${u.实测尺寸.length} 条` : "无实测（可跳过，尺寸将全部标（估））", ready: true },
    { path: "recognize", title: "3 AI 部件识别", info: u.部件.length ? `已识别 ${u.部件.length} 个部件` : "未识别", ready: u.照片.length > 0, lock: "先上传照片" },
    { path: "overview", title: "4 识别结果概览与人工校正", info: u.校正记录.length ? `校正动作 ${u.校正记录.length} 次` : "未校正", ready: u.部件.length > 0, lock: "先完成识别" },
    { path: "output",  title: "5 出图、核验、审核与交付", info: u.交付记录.length ? `已交付 ${u.交付记录.length} 次，当前 v${u.图纸版本}` : (u.审核 ? `审核${u.审核.结果}` : "未出图"), ready: u.状态 === "校正完成" || u.状态 === "已出图", lock: "先完成校正（状态到达校正完成）" }
  ];
  steps.forEach(s => {
    const c = UI.el("div", { class: "card" + (s.ready ? " clickable" : ""), onclick: () => { if (s.ready) Router.go(s.path + "/" + u.id); } }, [
      UI.el("div", { style: "display:flex; justify-content:space-between;" }, [
        UI.el("strong", null, [s.title]),
        UI.el("span", { class: "hint" }, [s.ready ? s.info : "未解锁：" + s.lock])
      ])
    ]);
    if (!s.ready) c.style.opacity = "0.55";
    root.appendChild(c);
  });
});
