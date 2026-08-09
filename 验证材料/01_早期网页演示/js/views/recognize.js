// 屏6：识别进行中（工作流环节二）。有 API key 且有真实照片时调 Claude 多模态真识别；
// 否则退回模拟模式并明确标注。识别结果落库后进入屏7 识别结果概览。
Router.register("recognize", function (root, args) {
  const u = Store.unit(args[0]);
  if (!u) { Router.go("projects"); return; }
  UI.header(root, "AI 部件识别 · " + u.名称, "unit/" + u.id, "工作区");

  // 边界：无照片（原型 异常1）
  if (!u.照片.length) {
    root.appendChild(UI.el("div", { class: "warn" }, ["没有照片，无法识别。请先上传至少一张打标为立面的照片。"]));
    root.appendChild(UI.el("a", { class: "btn", href: "#/photos/" + u.id }, ["去上传照片"]));
    return;
  }

  const hasKey = !!API.getKey();
  const hasRealPhoto = u.照片.some(p => p.dataUrl);
  const realMode = hasKey && hasRealPhoto;

  const card = UI.el("div", { class: "card" });
  root.appendChild(card);

  // 起始页：说明将用哪种模式，用户点击开始
  const modeText = realMode
    ? "真实识别：照片将发送给 Claude 多模态模型（" + u.照片.filter(p => p.dataUrl).length + " 张真实照片）。"
    : !hasRealPhoto
      ? "模拟识别：当前没有真实上传的照片（示例数据的照片是 poc 素材占位）。上传本机照片并在设置里填入 API key 后可真识别。"
      : "模拟识别：尚未配置 API key。点右上角设置填入后可真识别。";
  card.appendChild(UI.el("div", { class: "progress-wrap" }, [
    UI.el("div", { style: "margin-bottom:12px;" }, [modeText]),
    UI.el("div", { class: "btnbar", style: "justify-content:center;" }, [
      UI.el("button", { class: "primary", onclick: start }, [realMode ? "开始真实识别" : "开始模拟识别"]),
      realMode ? "" : UI.el("a", { class: "btn", href: "#/settings" }, ["去设置 API key"])
    ].filter(Boolean))
  ]));

  function showProgress() {
    card.innerHTML = "";
    const wrap = UI.el("div", { class: "progress-wrap" });
    const bar = UI.el("div", { class: "progress-bar" }, [UI.el("div", { class: "fill" })]);
    const stepText = UI.el("div", { class: "progress-steps" }, ["准备开始"]);
    wrap.appendChild(UI.el("div", null, ["识别进行中，请稍候"]));
    wrap.appendChild(bar);
    wrap.appendChild(stepText);
    card.appendChild(wrap);
    return { bar: bar.firstChild, stepText };
  }

  async function start() {
    const p = showProgress();
    if (realMode) {
      try {
        p.bar.style.width = "20%";
        const result = await API.recognize(u, msg => { p.stepText.textContent = msg; p.bar.style.width = "60%"; });
        p.bar.style.width = "90%"; p.stepText.textContent = "写入识别结果";
        Store.mutate(u.id, x => {
          // 增量保护（07 PRD R003）：已有人工校正记录时不覆盖，改为追加待比对提示
          if (x.校正记录.length && x.部件.length) {
            x.部件重跑待比对 = result.部件;
          } else {
            x.部件 = result.部件;
            x.核心尺寸 = result.核心尺寸 || [];
          }
          x.形制说明 = result.形制说明 || "";
        });
        finish(true);
      } catch (err) {
        showError(err);
      }
    } else {
      // 模拟：定时器走完五步，写入占位结果
      const steps = [[15, "读取照片与打标信息"], [35, "识别立面构成与屋顶形式"], [60, "逐部件识别"], [80, "推算部件尺寸，无实测项标（估）"], [100, "生成结构化识别结果"]];
      let i = 0;
      const timer = setInterval(() => {
        if (i >= steps.length) { clearInterval(timer); simFill(); finish(false); return; }
        p.bar.style.width = steps[i][0] + "%"; p.stepText.textContent = steps[i][1]; i++;
      }, 600);
    }
  }

  function simFill() {
    if (u.部件.length) return;   // 示例单元已有 poc 真实结果，保留
    Store.mutate(u.id, x => {
      x.部件 = [
        { 编号: "P01", 名称: "台基", 类别: "台基", 置信度: "中", 尺寸: "（估）", 来源: "AI识别（demo 模拟）" },
        { 编号: "P02", 名称: "檐柱", 类别: "柱", 置信度: "中", 尺寸: "（估）", 来源: "AI识别（demo 模拟）" },
        { 编号: "P03", 名称: "额枋", 类别: "枋", 置信度: "中", 尺寸: "（估）", 来源: "AI识别（demo 模拟）" },
        { 编号: "P04", 名称: "斗拱层", 类别: "铺作", 置信度: "低", 尺寸: "（估）", 来源: "AI识别（demo 模拟）", 提示: "模拟占位结果" },
        { 编号: "P05", 名称: x.屋顶形式 + "顶", 类别: "屋面", 置信度: "中", 尺寸: "（估）", 来源: "AI识别（demo 模拟）" },
        { 编号: "P06", 名称: "门窗", 类别: "门窗", 置信度: "低", 尺寸: "（估）", 来源: "AI识别（demo 模拟）" }
      ];
      x.核心尺寸 = [{ 名称: "通面阔（轴线）", 数值: "（估）" }];
    });
  }

  function finish(real) {
    Store.transition(u.id, "校正中");
    const uu = Store.unit(u.id);
    card.innerHTML = "";
    card.appendChild(UI.el("div", { class: "progress-wrap" }, [
      UI.el("div", { style: "font-size:16px; margin-bottom:12px;" },
        ["识别完成，共 " + uu.部件.length + " 个部件" + (real ? "（真实识别）" : "（模拟）")]),
      uu.形制说明 ? UI.el("div", { class: "hint", style: "margin-bottom:12px;" }, ["形制说明：" + uu.形制说明]) : "",
      uu.部件重跑待比对 ? UI.el("div", { class: "warn" }, ["检测到已有人工校正，本次结果未覆盖，已存为待比对稿（增量保护）。"]) : "",
      UI.el("div", { class: "hint", style: "margin-bottom:20px;" }, ["识别结果是待校正稿，进入下一步逐项确认或修改。"]),
      UI.el("a", { class: "btn primary", href: "#/overview/" + u.id }, ["查看识别结果概览 →"])
    ].filter(Boolean)));
  }

  // 边界：识别失败（原型 异常2）
  function showError(err) {
    card.innerHTML = "";
    const msg = err.message === "EMPTY_RESULT" ? "模型返回了空结果。换更清晰的正立面照片，或补充打标后重试。"
      : err.message.startsWith("API 401") ? "API key 无效，请到设置里检查。"
      : "识别失败：" + err.message;
    card.appendChild(UI.el("div", { class: "progress-wrap" }, [
      UI.el("div", { class: "warn", style: "text-align:left;" }, [msg]),
      UI.el("div", { class: "btnbar", style: "justify-content:center;" }, [
        UI.el("button", { class: "primary", onclick: () => Router.render() }, ["重试"]),
        UI.el("a", { class: "btn", href: "#/photos/" + u.id }, ["回到照片"]),
        UI.el("a", { class: "btn", href: "#/settings" }, ["检查设置"])
      ])
    ]));
  }
});
