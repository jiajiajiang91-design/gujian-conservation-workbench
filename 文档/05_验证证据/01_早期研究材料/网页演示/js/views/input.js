// 屏：照片上传与打标 + 实测尺寸录入（工作流环节一：输入）
Router.register("photos", function (root, args) {
  const u = Store.unit(args[0]);
  if (!u) { Router.go("projects"); return; }
  UI.header(root, "照片上传与打标 · " + u.名称, "unit/" + u.id, "工作区");

  const 词 = Store.词表();
  const card = UI.el("div", { class: "card" }, [UI.el("h2", null, ["已上传照片"])]);
  const grid = UI.el("div", { class: "photo-grid" });

  function draw() {
    const uu = Store.unit(u.id);
    grid.innerHTML = "";
    uu.照片.forEach((ph, i) => {
      const thumb = ph.dataUrl
        ? UI.el("img", { src: ph.dataUrl, style: "width:100%; height:110px; object-fit:cover; border-radius:3px; margin-bottom:8px;" })
        : UI.el("div", { class: "ph" }, ["示例照片（poc 素材）"]);
      const item = UI.el("div", { class: "photo-item" }, [
        thumb,
        UI.el("div", { class: "fname" }, [ph.文件]),
        UI.field("打标（下拉选择）", UI.select(["正立面", "侧立面", "背立面", "斜视", "细部", "标识碑", "环境"], ["正立面","侧立面","背立面","斜视","细部","标识碑","环境"].includes(ph.打标) ? ph.打标 : "正立面", v => Store.mutate(u.id, x => x.照片[i].打标 = v))),
        UI.el("button", { style: "font-size:12px; padding:4px 10px;", onclick: () => { Store.mutate(u.id, x => x.照片.splice(i, 1)); draw(); } }, ["移除"])
      ]);
      grid.appendChild(item);
    });
    if (!uu.照片.length) grid.appendChild(UI.el("div", { class: "empty", style: "width:100%;" }, ["还没有照片。点击下方按钮从本机选择照片上传。"]));
  }
  draw();
  card.appendChild(grid);

  const fileInput = UI.el("input", { type: "file", accept: "image/*", multiple: "multiple", style: "display:none;", onchange: async e => {
    for (const f of Array.from(e.target.files)) {
      try {
        const dataUrl = await API.readImage(f);
        Store.mutate(u.id, x => x.照片.push({ 文件: f.name, 打标: "正立面", 状态: "已上传", dataUrl }));
      } catch (err) {
        alert("读取失败：" + f.name);
      }
    }
    e.target.value = "";
    draw();
  } });
  card.appendChild(fileInput);
  card.appendChild(UI.el("div", { class: "btnbar" }, [
    UI.el("button", { class: "primary", onclick: () => fileInput.click() }, ["＋ 上传照片（本机文件）"]),
    UI.el("span", { class: "hint" }, ["真实上传，识别时发给模型。照片压缩到长边 1280 后存在本机浏览器，不上传到任何服务器（识别时除外）。打标用来告诉模型每张照片的视角。"])
  ]));
  root.appendChild(card);

  root.appendChild(UI.el("div", { class: "btnbar" }, [
    UI.el("a", { class: "btn", href: "#/dims/" + u.id }, ["下一步：实测尺寸录入 →"])
  ]));
});

Router.register("dims", function (root, args) {
  const u = Store.unit(args[0]);
  if (!u) { Router.go("projects"); return; }
  UI.header(root, "实测尺寸录入 · " + u.名称, "unit/" + u.id, "工作区");

  const 词 = Store.词表();
  const card = UI.el("div", { class: "card" }, [UI.el("h2", null, ["实测尺寸表（按测稿录入：部位 + 数值）"])]);
  const holder = UI.el("div");

  function draw() {
    holder.innerHTML = "";
    holder.appendChild(UI.table(["部位（下拉）", "名称（文字）", "数值", "单位", "测量方式（下拉）", "备注", ""],
      u.实测尺寸.map((d, i) => [
        UI.select(词.部位, d.部位, v => Store.mutate(u.id, x => x.实测尺寸[i].部位 = v)),
        UI.el("input", { type: "text", value: d.名称, onchange: e => Store.mutate(u.id, x => x.实测尺寸[i].名称 = e.target.value) }),
        UI.el("input", { type: "number", value: d.数值, style: "width:90px;", onchange: e => Store.mutate(u.id, x => x.实测尺寸[i].数值 = Number(e.target.value)) }),
        "mm",
        UI.select(词.测量方式, d.测量方式, v => Store.mutate(u.id, x => x.实测尺寸[i].测量方式 = v)),
        UI.el("input", { type: "text", value: d.备注 || "", onchange: e => Store.mutate(u.id, x => x.实测尺寸[i].备注 = e.target.value) }),
        UI.el("button", { style: "font-size:12px; padding:3px 8px;", onclick: () => { Store.mutate(u.id, x => x.实测尺寸.splice(i, 1)); draw(); } }, ["删"])
      ])));
    if (!u.实测尺寸.length) holder.appendChild(UI.el("div", { class: "empty" }, ["无实测尺寸。可以直接进入识别，此时全部尺寸由照片比例推算并标（估）。"]));
  }
  draw();
  card.appendChild(holder);
  card.appendChild(UI.el("div", { class: "btnbar" }, [
    UI.el("button", { onclick: () => { Store.mutate(u.id, x => x.实测尺寸.push({ 部位: 词.部位[1], 名称: "", 数值: 0, 单位: "mm", 测量方式: 词.测量方式[0], 备注: "" })); draw(); } }, ["＋ 加一条"]),
    UI.el("span", { class: "hint" }, ["有实测值的尺寸出图时按实测标注；没有的标（估）。基准尺寸（如柱高、门高）建议至少实测一条。"])
  ]));
  root.appendChild(card);

  root.appendChild(UI.el("div", { class: "btnbar" }, [
    UI.el("a", { class: "btn primary", href: "#/recognize/" + u.id }, ["下一步：AI 部件识别 →"])
  ]));
});
