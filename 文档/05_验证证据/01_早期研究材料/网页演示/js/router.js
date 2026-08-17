// 路由：hash 形式 #/视图名/参数。每个界面文件调用 Router.register 注册自己。
// 加新界面 = 新建 views/xx.js 注册一个视图 + index.html 里加一行 script，不改本文件。
window.Router = (function () {
  const views = {};

  function register(name, renderFn) { views[name] = renderFn; }

  function go(path) { location.hash = "#/" + path; }

  function parse() {
    const h = location.hash.replace(/^#\//, "");
    const seg = h.split("/").filter(Boolean);
    return { name: seg[0] || "projects", args: seg.slice(1) };
  }

  function render() {
    const { name, args } = parse();
    const fn = views[name] || views["projects"];
    const root = document.getElementById("app");
    root.innerHTML = "";
    fn(root, args);
    window.scrollTo(0, 0);
  }

  window.addEventListener("hashchange", render);
  window.addEventListener("DOMContentLoaded", render);

  return { register, go, render, parse };
})();

// 界面公用的小工具
window.UI = {
  el(tag, attrs, children) {
    const e = document.createElement(tag);
    if (attrs) for (const k in attrs) {
      if (k === "class") e.className = attrs[k];
      else if (k === "html") e.innerHTML = attrs[k];
      else if (k.startsWith("on")) e.addEventListener(k.slice(2), attrs[k]);
      else e.setAttribute(k, attrs[k]);
    }
    (children || []).forEach(c => e.appendChild(typeof c === "string" ? document.createTextNode(c) : c));
    return e;
  },
  // 页头：标题 + 面包屑返回
  header(root, title, backPath, backLabel) {
    const h = UI.el("div", { class: "page-head" });
    if (backPath) h.appendChild(UI.el("a", { class: "back", href: "#/" + backPath }, ["← " + (backLabel || "返回")]));
    h.appendChild(UI.el("h1", null, [title]));
    root.appendChild(h);
    return h;
  },
  badge(状态) {
    const cls = { "草稿": "b-grey", "校正中": "b-amber", "校正完成": "b-blue", "已出图": "b-green" }[状态] || "b-grey";
    return UI.el("span", { class: "badge " + cls }, [状态]);
  },
  select(options, value, onchange) {
    const s = UI.el("select", { onchange: e => onchange && onchange(e.target.value) });
    options.forEach(o => {
      const opt = UI.el("option", { value: o }, [o]);
      if (o === value) opt.selected = true;
      s.appendChild(opt);
    });
    return s;
  },
  field(label, control) {
    return UI.el("label", { class: "field" }, [UI.el("span", { class: "flabel" }, [label]), control]);
  },
  table(headers, rows) {
    const t = UI.el("table", { class: "tbl" });
    const tr = UI.el("tr");
    headers.forEach(h => tr.appendChild(UI.el("th", null, [h])));
    t.appendChild(tr);
    rows.forEach(cells => {
      const r = UI.el("tr");
      cells.forEach(c => r.appendChild(UI.el("td", null, [typeof c === "object" && c.nodeType ? c : String(c)])));
      t.appendChild(r);
    });
    return t;
  }
};
