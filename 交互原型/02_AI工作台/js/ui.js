/* 通用 DOM 工具 */
window.UI = (function () {

  function el(tag, cls, html) {
    const d = document.createElement(tag);
    if (cls) d.className = cls;
    if (html != null) d.innerHTML = html;
    return d;
  }
  function esc(s) {
    return String(s == null ? "" : s)
      .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;").replace(/'/g, "&#39;");
  }
  function clear(node) { while (node.firstChild) node.removeChild(node.firstChild); }

  // 来源徽章。七种来源见 js/provenance.js，兼容旧写法「缺」
  function stateBadge(st) {
    if (st === "缺") st = "missing";
    return PROV.badge(st);
  }
  function confBadge(c) {
    if (c === "低") return '<span class="badge alert">低</span>';
    if (c === "中") return '<span class="badge warn">中</span>';
    return '<span class="badge">高</span>';
  }

  function table(headers, rows) {
    let h = '<table class="tb"><thead><tr>';
    headers.forEach(x => h += "<th>" + x + "</th>");
    h += "</tr></thead><tbody>" + rows.join("") + "</tbody></table>";
    return h;
  }

  function scrollIntoViewIfNeeded(node, container) {
    if (!node || !container) return;
    const nr = node.getBoundingClientRect(), cr = container.getBoundingClientRect();
    if (nr.top < cr.top || nr.bottom > cr.bottom) {
      node.scrollIntoView({ block: "center", behavior: "smooth" });
    }
  }

  function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

  /* 视图底部操作条。每个视图都要有，用户不必只靠对话往下走。
     btns: [{label, primary, danger, disabled, onClick}] */
  function actionBar(container, btns, hint) {
    const bar = el("div", "action-bar actions-" + btns.length);
    let h = hint ? '<div class="ab-hint">' + esc(hint) + "</div>" : "";
    h += '<div class="ab-btns">';
    btns.forEach((b, i) => {
      const cls = b.primary ? "btn" : "btn-line";
      h += "<button class=\"" + cls + "\" data-i=\"" + i + "\"" +
        (b.disabled ? " disabled" : "") +
        (b.danger ? ' style="border-color:var(--alert);color:var(--alert)"' : "") +
        ">" + esc(b.label) + "</button>";
    });
    h += "</div>";
    bar.innerHTML = h;
    container.appendChild(bar);
    bar.querySelectorAll("button[data-i]").forEach(btn => {
      btn.onclick = () => {
        const b = btns[+btn.dataset.i];
        if (b && !b.disabled && b.onClick) b.onClick();
      };
    });
    return bar;
  }

  /* 应用内弹层，替代浏览器原生 prompt/confirm。
     原生弹窗有两个问题：取消返回 null 容易被漏判，导致点取消也当成确认；
     另外它显示不了上下文，用户看不到自己正在给哪一项写理由。 */
  function dialog(opts) {
    return new Promise(resolve => {
      const mask = el("div", "dlg-mask");
      const 需要输入 = opts.type !== "confirm";
      mask.innerHTML =
        '<div class="dlg">' +
        '<div class="dlg-title">' + esc(opts.title) + "</div>" +
        (opts.desc ? '<div class="dlg-desc">' + esc(opts.desc) + "</div>" : "") +
        (需要输入
          ? '<textarea class="dlg-input" rows="' + (opts.rows || 3) + '" placeholder="' +
            esc(opts.placeholder || "") + '">' + esc(opts.value || "") + "</textarea>" +
            (opts.required ? '<div class="dlg-err hidden">这一项必须填写，它会进入责任记录</div>' : "")
          : "") +
        '<div class="dlg-btns">' +
        '<button class="btn-line" data-act="cancel">' + esc(opts.cancelLabel || "取消") + "</button>" +
        '<button class="btn" data-act="ok">' + esc(opts.okLabel || "确定") + "</button>" +
        "</div></div>";
      document.body.appendChild(mask);

      const ta = mask.querySelector(".dlg-input");
      const err = mask.querySelector(".dlg-err");
      if (ta) setTimeout(() => ta.focus(), 30);

      function close(v) { mask.remove(); resolve(v); }
      mask.querySelector('[data-act="cancel"]').onclick = () => close(null);
      mask.querySelector('[data-act="ok"]').onclick = () => {
        if (!需要输入) return close(true);
        const v = (ta.value || "").trim();
        if (opts.required && !v) { err && err.classList.remove("hidden"); ta.focus(); return; }
        close(v);
      };
      mask.onclick = e => { if (e.target === mask) close(null); };
      mask.onkeydown = e => {
        if (e.key === "Escape") close(null);
        if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) mask.querySelector('[data-act="ok"]').click();
      };
    });
  }
  function askText(opts) { return dialog(Object.assign({ type: "text" }, opts)); }
  function askConfirm(opts) { return dialog(Object.assign({ type: "confirm" }, opts)); }

  return { el, esc, clear, stateBadge, confBadge, table, scrollIntoViewIfNeeded, sleep,
           actionBar, askText, askConfirm };
})();
