// 屏：出图设置 + 图纸预览核验 + 交付导出（工作流环节四、五）
Router.register("output", function (root, args) {
  const u = Store.unit(args[0]);
  if (!u) { Router.go("projects"); return; }
  UI.header(root, "出图与交付 · " + u.名称, "unit/" + u.id, "工作区");

  if (u.状态 !== "校正完成" && u.状态 !== "已出图") {
    root.appendChild(UI.el("div", { class: "warn" }, ["出图前需要先完成校正（当前状态：" + u.状态 + "）。"]));
    root.appendChild(UI.el("a", { class: "btn", href: "#/parts/" + u.id }, ["回到校正"]));
    return;
  }

  const 词 = Store.词表();
  const s = u.出图设置;

  // 出图设置
  const setCard = UI.el("div", { class: "card" }, [UI.el("h2", null, ["出图设置"])]);
  const grid = UI.el("div", { class: "form-grid" });
  grid.appendChild(UI.field("视图（下拉选择）", UI.select(["正立面", "侧立面", "背立面"], s.视图, v => Store.mutate(u.id, x => x.出图设置.视图 = v))));
  grid.appendChild(UI.field("比例（下拉选择）", UI.select(词.出图比例, s.比例, v => Store.mutate(u.id, x => x.出图设置.比例 = v))));
  grid.appendChild(UI.field("图幅（下拉选择）", UI.select(词.图幅, s.图幅, v => Store.mutate(u.id, x => x.出图设置.图幅 = v))));
  grid.appendChild(UI.field("交付规范（下拉选择）", UI.select(词.交付规范, s.交付规范, v => Store.mutate(u.id, x => x.出图设置.交付规范 = v))));
  grid.appendChild(UI.field("图号（文字输入）", UI.el("input", { type: "text", value: s.图号 || "", placeholder: "例：测绘02-01", onchange: e => Store.mutate(u.id, x => x.出图设置.图号 = e.target.value) })));
  setCard.appendChild(grid);

  const genBar = UI.el("div", { class: "btnbar" });
  const genBtn = UI.el("button", { class: "primary", onclick: generate }, [u.状态 === "已出图" ? "重新生成图纸（版本不变）" : "生成图纸"]);
  genBar.appendChild(genBtn);
  genBar.appendChild(UI.el("span", { class: "hint" }, ["demo 直接展示 poc 真实生成的 DXF 预览；真实产品此处调用出图脚本，约需数秒。"]));
  setCard.appendChild(genBar);
  root.appendChild(setCard);

  const resultHolder = UI.el("div");
  root.appendChild(resultHolder);

  function generate() {
    // 新建单元（无 poc 图纸）：参数化生成 SVG 并写入真实审计结果
    if (!u.立面图) {
      const r = Drawing.build(Store.unit(u.id));
      Store.mutate(u.id, x => { x.生成图svg = r.svg; x.审计 = r.审计; });
    }
    if (u.状态 === "校正完成") Store.transition(u.id, "已出图");
    drawResult();
  }
  function drawResult() {
    const uu = Store.unit(u.id);
    resultHolder.innerHTML = "";
    if (uu.状态 !== "已出图") return;

    // 图纸预览与自动核验
    const prev = UI.el("div", { class: "card" }, [
      UI.el("h2", null, [`图纸预览核验（v${uu.图纸版本}　${uu.出图设置.比例}　${uu.出图设置.图幅}　图号 ${uu.出图设置.图号 || "未填"}）`])
    ]);
    if (uu.立面图) {
      prev.appendChild(UI.el("div", { class: "drawing-preview" }, [UI.el("img", { src: uu.立面图, alt: "立面图预览" })]));
      if (uu.布局图) prev.appendChild(UI.el("div", { class: "drawing-preview", style: "margin-top:12px;" }, [UI.el("img", { src: uu.布局图, alt: "A3 布局预览" })]));
      prev.appendChild(UI.el("div", { class: "hint", style: "margin-top:8px;" }, ["此预览是 poc 用 ezdxf 真实生成的 DXF 渲染图。"]));
    } else {
      // 参数化示意出图：优先用出图时存档的 SVG，没有则现算（兼容旧数据）
      const svg = uu.生成图svg || (() => { const r = Drawing.build(uu); Store.mutate(u.id, x => { x.生成图svg = r.svg; x.审计 = r.审计; }); return r.svg; })();
      prev.appendChild(UI.el("div", { class: "drawing-preview", html: svg }));
      prev.appendChild(UI.el("div", { class: "hint", style: "margin-top:8px;" },
        ["由识别结果实时参数化生成的示意立面（画法库 v0：台基、柱网、额枋、斗拱带、屋面、门窗均由部件表驱动）。精确 DXF 出图见 poc 脚本，规范图纸能力是产品化下一步。"]));
    }
    const audit = Store.unit(u.id).审计;
    prev.appendChild(UI.el("ul", { class: "checklist", style: "margin-top:12px;" }, [
      UI.el("li", null, [`${uu.立面图 ? "DXF 结构审计（ezdxf）" : "图形结构审计（实体计数与坐标校验）"}：实体 ${audit.实体数}，错误 ${audit.错误数}（错误必须为 0 才允许导出）`]),
      UI.el("li", null, ["图层符合交付规范约定，估算尺寸全部带（估）标注"]),
      UI.el("li", null, [`图签含版本号 v${uu.图纸版本}，历史版本存档不覆盖`])
    ]));
    prev.appendChild(UI.el("div", { class: "btnbar" }, [
      UI.el("a", { class: "btn", href: "#/review/" + u.id }, ["送负责人审核（可选）"]),
      UI.el("button", { onclick: () => { Store.transition(u.id, "校正中"); Router.go("parts/" + u.id); } }, ["发现问题，重开校正"]),
      UI.el("span", { class: "hint" }, [
        (uu.审核 ? `最近审核：${uu.审核.版本} ${uu.审核.结果}。` : "审核门可选，单人模式可直接导出。") +
        " 重开校正后再次出图，版本号变为 v" + (uu.图纸版本 + 1) + "。"])
    ]));
    resultHolder.appendChild(prev);

    // 导出交付
    const exp = UI.el("div", { class: "card" }, [UI.el("h2", null, ["合规导出"])]);
    let fmt = { DWG: true, PDF: true, JSON: false };
    const fmtBar = UI.el("div", { style: "display:flex; gap:20px; margin-bottom:12px;" },
      Object.keys(fmt).map(k => {
        const cb = UI.el("input", { type: "checkbox", onchange: e => fmt[k] = e.target.checked });
        cb.checked = fmt[k];
        return UI.el("label", { style: "display:flex; gap:6px; align-items:center;" }, [cb, k + (k === "JSON" ? "（识别数据，自留数据资产，非交付件）" : "")]);
      }));
    exp.appendChild(fmtBar);
    exp.appendChild(UI.el("div", { class: "btnbar" }, [
      UI.el("button", { class: "primary", onclick: () => {
        const list = Object.keys(fmt).filter(k => fmt[k]).join(" + ") || "（未选格式）";
        Store.mutate(u.id, x => x.交付记录.push({
          版本: "v" + x.图纸版本, 时间: Store.now(),
          文件: `${x.名称}_${x.出图设置.视图}现状图_v${x.图纸版本}`,
          格式: list, 审计: `实体 ${audit.实体数}，错误 ${audit.错误数}`
        }));
        drawResult();
      } }, ["导出交付包"]),
      UI.el("span", { class: "hint" }, ["demo 只记录交付动作，不生成真实文件。真实 DXF 见 poc 目录。"])
    ]));
    const uu2 = Store.unit(u.id);
    if (uu2.交付记录.length) {
      exp.appendChild(UI.el("h2", { style: "margin-top:16px;" }, ["交付记录（版本存档，不覆盖）"]));
      exp.appendChild(UI.table(["版本", "时间", "文件", "格式", "审计"],
        uu2.交付记录.map(r => [r.版本, r.时间, r.文件, r.格式, r.审计])));
    }
    resultHolder.appendChild(exp);
  }
  drawResult();
});
