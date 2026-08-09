/* 视图：起始页与项目列表。
   第一屏必须有明显的入口，不能让用户只能靠猜要在右边打字。 */
window.ViewStart = function (root) {
  const S = Store.get();
  const full = UI.el("div", "pane-full");

  const 进行中 = S.项目列表.filter(p => p.状态 !== "已交付");
  const 已完成 = S.项目列表.filter(p => p.状态 === "已交付");

  function card(p) {
    const 步 = DATA.步骤.find(s => s.id === p.当前步骤) || {};
    return '<div class="start-card" data-id="' + p.id + '">' +
      "<b>" + UI.esc(p.名称) + "</b>" +
      '<div class="hint">' + UI.esc(p.成果) + "　" + UI.esc(p.比例) +
      "　" + UI.esc(p.地点) + "</div>" +
      '<div class="hint">状态：' + UI.esc(p.状态) +
      (p.状态 !== "已交付" ? "　停在：" + UI.esc(步.名 || p.当前步骤) : "") +
      (p.待办 ? '　<span class="badge warn">' + p.待办 + " 项待办</span>" : "") + "</div></div>";
  }

  full.innerHTML =
    '<div class="start">' +
    "<h2>项目总览</h2>" +
    "<p>继续已有项目，或者建立新的测绘任务。AI 助手会提示每一步需要处理的内容。</p>" +
    (进行中.length ? '<div class="left-sect-title" style="margin-bottom:6px">进行中</div>' +
      进行中.map(card).join("") : "") +
    (已完成.length ? '<div class="left-sect-title" style="margin:14px 0 6px">已交付</div>' +
      已完成.map(card).join("") : "") +
    '<div class="btn-row" style="margin:14px 0">' +
    '<button class="btn-line" id="btnImportProject">导入项目 JSON</button>' +
    '<button class="btn-line" id="btnExportProject">导出当前项目</button>' +
    '<input type="file" id="projectFile" accept="application/json,.json" hidden>' +
    '</div><div class="hint" style="margin-bottom:12px">JSON 只包含结构化数据，不会嵌入图片文件；图片路径须指向本工作台 assets 目录。</div>' +
    '<div class="start-card" data-new="1" style="border-style:dashed">' +
    "<b>新建测绘任务</b>" +
    '<div class="hint">说明测绘对象、成果要求和资料位置，系统会先整理出一份任务要求供你核对</div></div>' +
    "</div>";

  root.appendChild(full);

  full.querySelectorAll(".start-card[data-id]").forEach(c => {
    c.onclick = async () => {
      const p = S.项目列表.find(x => x.id === c.dataset.id);
      if (!p) return;
      try {
        await Store.switchProject(p.id);
      } catch (e) {
        Store.say("sys", "项目切换失败：" + String(e.message || e));
        return;
      }
      Store.get().已进入项目 = true;
      Store.goto(p.当前步骤 === "start" ? "task" : (DATA.步骤.find(s => s.id === p.当前步骤) || {}).视图 || "task");
      Workspace.forceRepaint();
    };
  });

  const fileInput = full.querySelector("#projectFile");
  full.querySelector("#btnImportProject").onclick = () => fileInput.click();
  fileInput.onchange = async () => {
    const file = fileInput.files && fileInput.files[0];
    if (!file) return;
    try {
      const result = await Store.importProject(file);
      Store.say("sys", "已导入「" + result.bundle.项目.名称 + "」。同 ID 项目会自动作为副本保存。");
      Store.goto("start");
      Workspace.forceRepaint();
    } catch (e) {
      Store.say("sys", "导入失败：" + String(e.message || e));
    } finally {
      fileInput.value = "";
    }
  };
  full.querySelector("#btnExportProject").onclick = () => {
    try { Store.downloadCurrent(); }
    catch (e) { Store.say("sys", "导出失败：" + String(e.message || e)); }
  };

  const nb = full.querySelector(".start-card[data-new]");
  if (nb) nb.onclick = () => {
    const t = document.getElementById("input");
    t.value = "为" + DATA.项目.名称 + "整理" + DATA.项目.成果 + "，请先核对现有任务书、照片和尺寸记录，并明确哪些资料还不能支持正式交付。";
    t.focus();
    Store.say("sys", "示例任务已经填好。可以直接发送，也可以改成自己的项目要求。");
  };
};
