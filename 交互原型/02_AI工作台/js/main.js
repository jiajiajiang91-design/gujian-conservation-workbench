/* 启动 */
(async function () {
  try {
    await ProjectData.init();
    const initialBundle = await ProjectData.load(ProjectData.defaultId());
    Store.init(initialBundle, ProjectData.list());
  } catch (e) {
    const work = document.getElementById("work") || document.body;
    work.innerHTML = '<div class="empty" style="padding:32px">项目数据加载失败：' +
      UI.esc(String(e.message || e)) + "<br>请检查 data/projects 下的索引和项目 JSON。</div>";
    return;
  }
  await API.init();

  function renderAll() {
    Sidebar.render();
    Workspace.render();
    Chat.render();
  }

  Store.sub(renderAll);
  Chat.bind();
  LayoutPrefs.init();

  document.getElementById("btnSettings").onclick = () => Settings.open();
  document.getElementById("modalClose").onclick = () => Settings.close();
  document.getElementById("modal").onclick = e => {
    if (e.target.id === "modal") Settings.close();
  };
  document.getElementById("btnReset").onclick = async () => {
    const ok = await UI.askConfirm({
      title: "恢复示例数据",
      desc: "当前项目中的修改、判断和操作记录会被清空，服务连接不会改变。",
      okLabel: "恢复示例", cancelLabel: "保留现状"
    });
    if (!ok) return;
    Store.reset();
    Workspace.forceRepaint();
    location.reload();
  };

  const hint = document.getElementById("modelHint");
  function updHint() {
    hint.textContent = API.isReady()
      ? "在线服务已连接"
      : "当前使用示例资料";
  }
  updHint();
  Store.sub(updHint);

  // 首次进入：助手先发问
  const S = Store.get();
  if (!S.消息.length) {
    Store.say("ai", "请选择一个项目继续，或者新建测绘任务。你也可以在这里直接说明要做什么。");
    Store.say("sys", "现场照片、手写尺寸草图、任务书照片或截图都可以拖到这里。系统会先识别资料类型，再把结果分别写入构件清单和实测表。需要重新识别上传资料时，请先检查在线服务是否已连接。");
  }

  renderAll();
  Workspace.forceRepaint();
})();
