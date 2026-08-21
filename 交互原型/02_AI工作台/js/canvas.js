/* 证据区：图片 + 位置框叠加层。
   这是本形态与传统后台差别最大的部分：
   点表格行高亮图上位置，在图上拖框并说一句话即可修正。 */
window.Evidence = (function () {

  let host = null, img = null, cv = null, ctx = null;
  let boxes = [];          // [{no, name, box:[x1,y1,x2,y2], flag}]
  let selected = null;
  let onSelect = null;
  let dragging = false, start = null, current = null;
  let enableDraw = true;

  function mount(container, imgSrc, opts) {
    opts = opts || {};
    enableDraw = opts.draw !== false;
    onSelect = opts.onSelect || null;
    UI.clear(container);

    const tools = UI.el("div", "evi-tools");
    tools.innerHTML = enableDraw
      ? "现场照片 · 按住拖动框出位置，再在右侧说明问题"
      : "现场资料预览";
    container.appendChild(tools);

    const stage = UI.el("div", "evi-stage");
    const wrap = UI.el("div", "evi-wrap");
    img = UI.el("img");
    img.src = imgSrc;
    cv = UI.el("canvas");
    wrap.appendChild(img);
    wrap.appendChild(cv);
    stage.appendChild(wrap);
    container.appendChild(stage);
    host = wrap;

    img.onload = () => { sizeCanvas(); draw(); };
    if (img.complete) { sizeCanvas(); draw(); }

    bind();
    return { setBoxes, select, redraw: draw };
  }

  function sizeCanvas() {
    if (!img || !cv) return;
    const r = img.getBoundingClientRect();
    cv.width = Math.max(1, Math.round(r.width));
    cv.height = Math.max(1, Math.round(r.height));
    ctx = cv.getContext("2d");
  }

  function setBoxes(list) { boxes = list || []; draw(); }
  function select(no) { selected = no; draw(); }

  function draw() {
    if (!ctx) { if (cv) ctx = cv.getContext("2d"); else return; }
    const W = cv.width, H = cv.height;
    ctx.clearRect(0, 0, W, H);

    boxes.forEach(b => {
      const [x1, y1, x2, y2] = b.box;
      const X = x1 * W, Y = y1 * H, w = (x2 - x1) * W, h = (y2 - y1) * H;
      const on = b.no === selected;
      ctx.lineWidth = on ? 2.5 : 1.2;
      ctx.strokeStyle = on ? "#3c5a78" : (b.flag ? "rgba(168,149,90,.95)" : "rgba(255,255,255,.75)");
      if (on) {
        ctx.fillStyle = "rgba(60,90,120,.16)";
        ctx.fillRect(X, Y, w, h);
      }
      ctx.strokeRect(X, Y, w, h);

      if (on || b.flag) {
        const label = b.no + " " + b.name;
        ctx.font = "12px system-ui, sans-serif";
        const tw = ctx.measureText(label).width + 10;
        const ty = Y > 18 ? Y - 17 : Y + 2;
        ctx.fillStyle = on ? "#3c5a78" : "rgba(168,149,90,.95)";
        ctx.fillRect(X, ty, tw, 16);
        ctx.fillStyle = "#fff";
        ctx.fillText(label, X + 5, ty + 12);
      }
    });

    // 正在拖拽的新框
    if (dragging && start && current) {
      const x1 = Math.min(start.x, current.x), y1 = Math.min(start.y, current.y);
      const x2 = Math.max(start.x, current.x), y2 = Math.max(start.y, current.y);
      ctx.setLineDash([5, 4]);
      ctx.lineWidth = 2;
      ctx.strokeStyle = "#a66a5a";
      ctx.fillStyle = "rgba(166,106,90,.14)";
      ctx.fillRect(x1, y1, x2 - x1, y2 - y1);
      ctx.strokeRect(x1, y1, x2 - x1, y2 - y1);
      ctx.setLineDash([]);
    }
  }

  function pos(e) {
    const r = cv.getBoundingClientRect();
    return { x: e.clientX - r.left, y: e.clientY - r.top };
  }
  function hit(p) {
    const W = cv.width, H = cv.height;
    // 命中面积最小的框，避免大框盖住小框
    let best = null, bestArea = Infinity;
    boxes.forEach(b => {
      const [x1, y1, x2, y2] = b.box;
      if (p.x >= x1 * W && p.x <= x2 * W && p.y >= y1 * H && p.y <= y2 * H) {
        const a = (x2 - x1) * (y2 - y1);
        if (a < bestArea) { bestArea = a; best = b; }
      }
    });
    return best;
  }

  function bind() {
    cv.onmousedown = e => {
      if (!enableDraw) return;
      start = pos(e); current = start; dragging = true;
    };
    cv.onmousemove = e => {
      if (!dragging) {
        const b = hit(pos(e));
        cv.style.cursor = b ? "pointer" : (enableDraw ? "crosshair" : "default");
        return;
      }
      current = pos(e); draw();
    };
    cv.onmouseup = e => {
      const p = pos(e);
      const moved = start && (Math.abs(p.x - start.x) > 6 || Math.abs(p.y - start.y) > 6);
      dragging = false;
      if (!moved) {
        const b = hit(p);
        if (b) { selected = b.no; draw(); onSelect && onSelect(b.no); }
        else { selected = null; draw(); onSelect && onSelect(null); }
        start = current = null;
        return;
      }
      // 完成一次框选，写入引用
      const W = cv.width, H = cv.height;
      const box = [
        Math.min(start.x, p.x) / W, Math.min(start.y, p.y) / H,
        Math.max(start.x, p.x) / W, Math.max(start.y, p.y) / H
      ].map(v => Math.round(Math.max(0, Math.min(1, v)) * 1000) / 1000);
      const inside = hit({ x: (box[0] + box[2]) / 2 * W, y: (box[1] + box[3]) / 2 * H });
      Store.setRef({ 框: box, 命中: inside ? inside.no : null, 图: img.getAttribute("src") });
      start = current = null;
      draw();
      const ta = document.getElementById("input");
      if (ta) ta.focus();
    };
    window.addEventListener("resize", () => { sizeCanvas(); draw(); });
  }

  return { mount };
})();
