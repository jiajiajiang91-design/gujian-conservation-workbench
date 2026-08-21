/* 左栏：项目、步骤进度、待办 */
window.Sidebar = (function () {

  function render() {
    const S = Store.get();
    const box = document.getElementById("leftBody");
    UI.clear(box);

    // 项目
    const s1 = UI.el("div", "left-sect");
    s1.innerHTML = '<div class="left-sect-title">项目</div>' +
      '<div class="proj' + (S.当前视图 !== "start" ? " active" : "") + '" id="projCard">' +
      '<div class="proj-name">' + UI.esc(DATA.项目.名称) + "</div>" +
      '<div class="proj-meta">' + UI.esc(DATA.项目.成果) + "　" +
      UI.esc((S.任务卡.比例 && S.任务卡.比例.值) || "未确定") + "</div></div>" +
      '<button class="btn-line back-project" id="toList">← 返回项目列表</button>';
    box.appendChild(s1);
    const tl = s1.querySelector("#toList");
    if (tl) tl.onclick = () => Store.goto("start");

    // 步骤
    const s2 = UI.el("div", "left-sect");
    let h = '<div class="left-sect-title">工作步骤</div>';
    box.appendChild(s2);
    s2.innerHTML = h;

    DATA.步骤.forEach((st, i) => {
      const state = S.步骤状态[st.id];
      const 未开始 = state === "idle" && i > S.解锁到;
      const cls = "step" +
        (state === "done" ? " done" : "") +
        (state === "stop" ? " blocked" : "") +
        (S.当前视图 === st.视图 ? " current" : "") +
        (未开始 ? " locked" : "");
      const note = state === "done" ? "已完成"
        : state === "stop" ? "等你决定"
        : state === "running" ? "进行中" : "尚未开始";
      const d = UI.el("div", cls);
      d.innerHTML = '<span class="step-dot">' + (state === "done" ? "✓" : "") + "</span>" +
        '<span><span class="step-name">' + UI.esc(st.名) + "</span>" +
        '<span class="step-note"> · ' + note + "</span></span>";
      // 浏览不设锁，未开始的步骤也能点开看初始内容
      d.onclick = () => Store.goto(st.视图);
      box.appendChild(d);
    });

    // 待办
    const 未决存疑 = S.存疑.filter(q => !q.已解决).length;
    const 待决检查 = S.检查问题.filter(c => c.处理 === "pending").length;
    const 未指定人员 = S.人员.filter(p => !p.姓名).length;
    const total = 未决存疑 + 待决检查;
    const s3 = UI.el("div", "left-sect");
    s3.innerHTML = '<div class="left-sect-title">待办 ' + total + "</div>";
    box.appendChild(s3);

    if (未决存疑) {
      const t = UI.el("div", "todo");
      t.innerHTML = '<span class="todo-count">' + 未决存疑 + "</span> 个构件待确认";
      t.onclick = () => Store.goto("parts");
      box.appendChild(t);
    }
    if (待决检查) {
      const t = UI.el("div", "todo");
      t.innerHTML = '<span class="todo-count">' + 待决检查 + "</span> 项图纸问题待确认";
      t.onclick = () => Store.goto("drawing");
      box.appendChild(t);
    }
    if (未指定人员) {
      const t = UI.el("div", "todo");
      t.innerHTML = '<span class="todo-count">' + 未指定人员 + "</span> 名人员待指定";
      t.onclick = () => Store.goto("task");
      box.appendChild(t);
    }
    if (!total && !未指定人员) {
      const t = UI.el("div", "left-sect");
      t.innerHTML = '<div class="hint">当前没有需要你处理的事</div>';
      box.appendChild(t);
    }
  }

  return { render };
})();
