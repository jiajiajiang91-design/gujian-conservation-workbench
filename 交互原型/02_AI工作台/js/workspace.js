/* 中栏：视图标签与调度 */
window.Workspace = (function () {
  const VIEWS = {
    start: { 名: "项目", fn: () => ViewStart },
    task: { 名: "任务要求", fn: () => ViewTask },
    materials: { 名: "资料核对", fn: () => ViewMaterials },
    datum: { 名: "实测尺寸", fn: () => ViewDatum },
    parts: { 名: "构件核对", fn: () => ViewParts },
    condition: { 名: "现状记录", fn: () => ViewCondition },
    style: { 名: "出图设置", fn: () => ViewStyle },
    drawing: { 名: "图纸检查", fn: () => ViewDrawing },
    delivery: { 名: "交付归档", fn: () => ViewDelivery }
  };

  let lastView = null;

  /* 顶部真实性提示。用户必须能一眼看出当前这些结果是模型算的还是预置的。 */
  function renderMode() {
    const S = Store.get();
    const bar = document.getElementById("modeBar");
    if (!bar) return;
    const live = API.isReady();
    const c = PROV.summarize(S);
    bar.className = "mode-bar " + (live ? "live" : "demo");
    const proxy = DATA.项目.验证性质 === "demo-proxy" ? "　<b>代理验证数据，不可对外正式交付</b>" : "";
    const storageWarning = S.存储错误 ? "　<b>" + UI.esc(S.存储错误) + "</b>" : "";
    bar.innerHTML = live
      ? "<b>在线识别已连接</b>　可以读取新上传的资料" +
        '<span class="spacer"></span>当前依据：AI 识别 ' + c.ai + "　现场实测 " + c.measured +
        "　人工确认 " + c.human + "　示例资料 " + c.demo + proxy + storageWarning
      : "<b>当前为示例</b>　页面使用预置资料，所有结果只用于体验操作" +
        proxy + storageWarning + '<span class="spacer"></span><button class="btn-ghost" id="modeSet">检查连接</button>';
    const b = bar.querySelector("#modeSet");
    if (b) b.onclick = () => Settings.open();
  }

  function render() {
    const S = Store.get();
    const tabs = document.getElementById("tabs");
    const work = document.getElementById("work");
    renderMode();
    if (!document.getElementById("layoutTools").children.length) LayoutPrefs.renderControls();

    // 标签
    UI.clear(tabs);
    const home = UI.el("button", "tab" + (S.当前视图 === "start" ? " active" : ""), "项目");
    home.onclick = () => Store.goto("start");
    tabs.appendChild(home);
    /* 浏览不设锁：任何视图随时可看，未开始的只是显示初始内容。
       该停的地方由停靠点管写入，不靠锁住页面。 */
    DATA.步骤.forEach((st, i) => {
      const 未开始 = S.步骤状态[st.id] === "idle" && i > S.解锁到;
      const b = UI.el("button", "tab" + (S.当前视图 === st.视图 ? " active" : "") + (未开始 ? " locked" : ""),
        VIEWS[st.视图].名);
      b.onclick = () => {
        Store.goto(st.视图);
      };
      tabs.appendChild(b);
    });

    // 内容：视图切换时重建，同视图内的数据变化由视图自己订阅刷新
    if (lastView !== S.当前视图) {
      lastView = S.当前视图;
      Store.clearViewSubs();     // 丢掉上一个视图的订阅，避免累积
      UI.clear(work);
      const v = VIEWS[S.当前视图];
      if (v) v.fn()(work);
    }
    LayoutPrefs.apply();
  }

  function forceRepaint() { lastView = null; render(); }

  return { render, forceRepaint, VIEWS };
})();
