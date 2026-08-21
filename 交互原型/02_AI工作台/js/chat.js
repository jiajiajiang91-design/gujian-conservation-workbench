/* 右栏：状态条、消息流、输入区 */
window.Chat = (function () {

  function renderStatus() {
    const S = Store.get();
    const bar = document.getElementById("statusBar");
    const st = S.状态条;
    const 标题 = st.标题 === "工作助手" ? "可以开始" : st.标题;
    bar.className = "status-bar" + (st.类型 === "busy" ? " busy" : st.类型 === "stop" ? " stop" : "");
    bar.innerHTML =
      '<div class="assistant-label">AI 助手</div>' +
      '<div class="status-title">' +
      (st.类型 === "busy" ? '<span class="spinner"></span>' : "") +
      UI.esc(标题) + "</div>" +
      '<div class="status-sub">' + UI.esc(st.说明) + "</div>";
  }

  function renderStream() {
    const S = Store.get();
    const box = document.getElementById("stream");
    const atBottom = box.scrollHeight - box.scrollTop - box.clientHeight < 60;
    UI.clear(box);

    S.消息.forEach((m, idx) => {
      const d = UI.el("div", "msg " + m.who);
      let inner = "";
      if (m.who !== "sys") {
        inner += '<div class="msg-who">' + (m.who === "user" ? "我" : "AI 助手") + "</div>";
      }
      if (m.process && m.process.length) {
        const processLast = m.process[m.process.length - 1];
        const processText = m.processing ? "进行中" : processLast.state === "error" ? "未完成" : "已完成";
        inner += '<details class="process-log"' + (m.processing ? " open" : "") + '>' +
          '<summary><span>AI 处理过程</span><span class="process-state">' +
          processText + "</span></summary>" +
          '<div class="process-list">' + m.process.map(p =>
            '<div class="process-item ' + UI.esc(p.state || "running") + '">' +
              '<span class="process-dot" aria-hidden="true"></span>' +
              '<div><div class="process-label">' + UI.esc(p.label) + "</div>" +
              (p.detail ? '<div class="process-detail">' + UI.esc(p.detail) + "</div>" : "") +
              "</div><time>" + UI.esc(p.time || "") + "</time></div>"
          ).join("") + "</div></details>";
      }
      if (m.text && m.text.trim()) {
        inner += '<div class="msg-body">' + UI.esc(m.text) + "</div>";
      }

      // AI 提议的修改：逐条可应用，这是"AI 提议、人确认"的落点
      if (m.edits && m.edits.length) {
        const 待定 = m.edits.filter(e => !e.状态).length;
        inner += '<div class="msg-card stop"><div class="msg-card-title">建议修改 ' +
          m.edits.length + " 处" + (待定 ? "，待确认 " + 待定 : "，已全部处理") + "</div>";
        m.edits.forEach((e, i) => {
          const done = !!e.状态;
          const warn = e.警告 && e.警告.length;
          inner += '<div class="edit-item' + (done ? " done" : "") + (warn ? " warn" : "") + '">' +
            '<div class="edit-head"><span class="mono">' + UI.esc(e.编号) + "</span> " +
            UI.esc(e.名称) + "　" + UI.esc(e.字段) +
            (e.对象 !== "构件" ? ' <span class="badge">' + UI.esc(e.对象) + "</span>" : "") +
            (e.把握 === "低" ? ' <span class="badge alert">把握低</span>' :
             e.把握 === "中" ? ' <span class="badge warn">把握中</span>' : "") + "</div>" +
            '<div class="edit-diff"><span class="old">' + UI.esc(e.原值 || "空") + "</span>" +
            '<span class="arrow"> → </span><span class="new">' + UI.esc(e.新值) + "</span></div>" +
            '<div class="hint">' + UI.esc(e.理由) + "</div>" +
            (warn ? '<div class="edit-warn">自动核对提示：' +
              e.警告.map(x => UI.esc(x)).join("；") + "</div>" : "") +
            (done
              ? '<div class="hint" style="color:var(--accent)">' + UI.esc(e.状态) + "</div>"
              : '<div class="edit-btns">' +
                '<button class="btn-line ed-apply" data-m="' + idx + '" data-e="' + i + '">应用</button>' +
                '<button class="btn-ghost ed-ignore" data-m="' + idx + '" data-e="' + i + '">忽略</button>' +
                "</div>") +
            "</div>";
        });
        if (待定 > 1) {
          const 干净 = m.edits.filter(e => !e.状态 && !(e.警告 && e.警告.length)).length;
          inner += '<div class="edit-btns" style="margin-top:8px;border-top:1px solid var(--line);padding-top:8px">' +
            (干净 ? '<button class="btn ed-clean" data-m="' + idx + '">应用无疑问的 ' + 干净 + " 条</button>" : "") +
            '<button class="btn-line ed-all" data-m="' + idx + '">全部应用（' + 待定 + " 条）</button></div>" +
            (干净 < 待定 ? '<div class="hint" style="margin-top:4px">有疑问的 ' + (待定 - 干净) +
              " 条建议逐条看过再决定。</div>" : "");
        }
        inner += "</div>";
      }

      if (m.card) {
        inner += '<div class="msg-card ' + (m.card.type || "") + '">' +
          '<div class="msg-card-title">' + UI.esc(m.card.title) + "</div>" +
          (m.card.body ? '<div class="hint">' + UI.esc(m.card.body) + "</div>" : "") +
          (m.card.options
            ? '<div class="msg-opts">' + m.card.options.map((o, i) =>
                '<button class="msg-opt" data-m="' + idx + '" data-i="' + i + '">' +
                UI.esc(o.label) + (o.sub ? '<span class="o-sub">' + UI.esc(o.sub) + "</span>" : "") +
                "</button>").join("") + "</div>"
            : "") +
          (m.card.answered ? '<div class="hint" style="margin-top:6px">已选择：' + UI.esc(m.card.answered) + "</div>" : "") +
          "</div>";
      }
      d.innerHTML = inner;
      box.appendChild(d);
    });

    box.querySelectorAll(".ed-apply").forEach(b => {
      b.onclick = () => Orchestrator.applyEdit(+b.dataset.m, +b.dataset.e);
    });
    box.querySelectorAll(".ed-ignore").forEach(b => {
      b.onclick = () => Orchestrator.ignoreEdit(+b.dataset.m, +b.dataset.e);
    });
    box.querySelectorAll(".ed-all").forEach(b => {
      b.onclick = () => Orchestrator.applyAllEdits(+b.dataset.m, false);
    });
    box.querySelectorAll(".ed-clean").forEach(b => {
      b.onclick = () => Orchestrator.applyAllEdits(+b.dataset.m, true);
    });

    box.querySelectorAll(".msg-opt").forEach(b => {
      b.onclick = () => {
        const m = Store.get().消息[+b.dataset.m];
        if (!m || !m.card || m.card.answered) return;
        const opt = m.card.options[+b.dataset.i];
        m.card.answered = opt.label;
        m.card.options = null;
        Store.emit();
        Orchestrator.onChoice(m.card.key, opt.value != null ? opt.value : +b.dataset.i, opt.label);
      };
    });

    if (atBottom) box.scrollTop = box.scrollHeight;
  }

  function renderRef() {
    const S = Store.get();
    const chip = document.getElementById("refChip");
    if (!S.引用) { chip.classList.add("hidden"); return; }
    chip.classList.remove("hidden");
    const r = S.引用;
    chip.innerHTML = "<span>已框选位置　" +
      (r.命中 ? "包含 " + r.命中 : "未对应到已有构件") + "</span>" +
      '<button class="btn-ghost" id="refClear">取消</button>';
    const c = document.getElementById("refClear");
    if (c) c.onclick = () => Store.clearRef();
  }

  function render() { renderStatus(); renderStream(); renderRef(); }

  function bind() {
    const ta = document.getElementById("input");
    const btn = document.getElementById("btnSend");
    function send() {
      const v = ta.value.trim();
      if (!v) return;
      ta.value = "";
      Orchestrator.userSay(v);
    }
    btn.onclick = send;
    ta.onkeydown = e => {
      if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) { e.preventDefault(); send(); }
    };
    // 拖入文件
    ["dragover", "drop"].forEach(evt => {
      document.addEventListener(evt, e => { e.preventDefault(); });
    });
    document.addEventListener("drop", e => {
      const f = e.dataTransfer && e.dataTransfer.files && e.dataTransfer.files[0];
      if (f) Orchestrator.onDrop(f);
    });
  }

  return { render, bind };
})();
