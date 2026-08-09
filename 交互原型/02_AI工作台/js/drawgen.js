/* 由构件数据实时生成立面图。
   这里是规则程序，不是模型：同一份数据每次画出的结果完全一致，改一个构件图就跟着变。
   注意这是数据驱动的示意图，不是正式测绘图。正式图需要按规范的参数化画法规则库，
   本原型只证明图来自数据，不来自一张预先做好的图片。 */
window.DrawGen = (function () {

  const W = 1000, H = 700;                    // 画布
  const M = { l: 90, r: 110, t: 70, b: 120 }; // 图框内边距，留给尺寸线和图签

  // 类别 → 画法
  const STYLE = {
    "台基":     { fill: "#e8e4da", stroke: "#6b6455", w: 1.4 },
    "柱":       { fill: "#dfe7ef", stroke: "#3c5a78", w: 1.4 },
    "枋":       { fill: "#f0e6d2", stroke: "#8a6d3b", w: 1.2 },
    "铺作":     { fill: "#e6dff0", stroke: "#6b5a8a", w: 1.0 },
    "屋面木作": { fill: "#f2ece0", stroke: "#8b7355", w: 1.0 },
    "屋面":     { fill: "#e0e4e0", stroke: "#4a5a4a", w: 1.4 },
    "屋面瓦饰": { fill: "#dcdcd4", stroke: "#5a5a4a", w: 1.0 },
    "门窗":     { fill: "#ffffff", stroke: "#3c5a78", w: 1.2 },
    "木装修":   { fill: "#f4e8e5", stroke: "#a66a5a", w: 1.0 },
    "墙体":     { fill: "#f0efeb", stroke: "#6b6455", w: 1.2 },
    "彩画":     { fill: "none",    stroke: "#a8955a", w: 0.8, dash: "4 3" },
    "环境陈设": { fill: "none",    stroke: "#b0aca4", w: 0.8, dash: "3 3" }
  };
  // 立面主体不含环境陈设，按规范环境物不入立面
  const 不入主体 = ["环境陈设"];

  function esc(s) {
    return String(s == null ? "" : s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  }

  /* 主入口：state → svg 字符串 */
  function render(S, opts) {
    opts = opts || {};
    const 构件 = S.构件.slice();
    const 主体 = 构件.filter(p => !不入主体.includes(p.类别));
    const 环境 = 构件.filter(p => 不入主体.includes(p.类别));

    // 立面主体按自身范围铺满图框，不被两侧碑刻等环境物压扁
    let minX = 1, maxX = 0, minY = 1, maxY = 0;
    (主体.length ? 主体 : 构件).forEach(p => {
      minX = Math.min(minX, p.框[0]); maxX = Math.max(maxX, p.框[2]);
      minY = Math.min(minY, p.框[1]); maxY = Math.max(maxY, p.框[3]);
    });
    const spanX = Math.max(0.05, maxX - minX), spanY = Math.max(0.05, maxY - minY);
    const bw = W - M.l - M.r, bh = H - M.t - M.b;
    const X = v => M.l + ((v - minX) / spanX) * bw;
    const Y = v => M.t + ((v - minY) / spanY) * bh;

    let g = "";
    // 环境陈设默认不画，规范上它不入立面主体；需要时可开
    const 画环境 = !!opts.环境;
    (画环境 ? 环境 : []).concat(主体).forEach(p => { g += shape(p, X, Y); });
    // 地平线
    g += '<line x1="' + f(M.l - 30) + '" y1="' + f(Y(maxY)) + '" x2="' + f(W - M.r + 30) +
      '" y2="' + f(Y(maxY)) + '" stroke="#2d2a24" stroke-width="1.4"/>';

    // 尺寸标注：横向按开间，纵向按高度
    g += dimsH(S, X, Y, bh, maxY);
    g += dimsV(S, X, Y, bw, maxX);

    const 比例 = (S.任务卡.比例 && S.任务卡.比例.值) || "未确定";
    const 估算数 = 构件.filter(p => /（估）|\(估\)/.test(p.尺寸 || "")).length;
    const 不可见 = 构件.filter(p => p.状态 === "unknown").length;

    return '<svg viewBox="0 0 ' + W + " " + H + '" xmlns="http://www.w3.org/2000/svg" ' +
      'style="width:100%;height:100%;background:#fff">' +
      '<rect x="18" y="18" width="' + (W - 36) + '" height="' + (H - 36) +
        '" fill="none" stroke="#2d2a24" stroke-width="1.6"/>' +
      '<text x="' + (W / 2) + '" y="46" text-anchor="middle" font-size="17" font-weight="700" fill="#2d2a24">' +
        esc(DATA.项目.名称) + "　正立面现状图</text>" +
      g +
      titleBlock(S, 比例, 构件.length, 估算数, 不可见) +
      "</svg>";
  }

  /* 按构件类别用不同画法。立面图不是色块堆叠，
     屋面要有坡度、柱要有柱身线、台基要有踏步、脊饰要在脊线上。 */
  function shape(p, X, Y) {
    const st = STYLE[p.类别] || STYLE["木装修"];
    const [x1, y1, x2, y2] = p.框;
    const x = X(x1), y = Y(y1), w = Math.max(1, X(x2) - X(x1)), h = Math.max(1, Y(y2) - Y(y1));
    const 未确认 = p.状态 === "unknown";
    const stroke = 未确认 ? "#a66a5a" : st.stroke;
    const dash = 未确认 ? ' stroke-dasharray="5 4"' : (st.dash ? ' stroke-dasharray="' + st.dash + '"' : "");
    const 名 = p.名称;
    let s = "";

    // 屋面：悬山顶正立面是梯形，上窄下宽，两端出际
    if (p.类别 === "屋面" && /屋面/.test(名)) {
      const 收 = w * 0.06;
      s += '<polygon points="' +
        [[x + 收, y], [x + w - 收, y], [x + w, y + h], [x, y + h]].map(pt => f(pt[0]) + "," + f(pt[1])).join(" ") +
        '" fill="' + st.fill + '" stroke="' + stroke + '" stroke-width="' + st.w + '"' + dash + "/>";
      // 瓦垄
      const n = Math.max(6, Math.round(w / 22));
      for (let i = 1; i < n; i++) {
        const t = i / n;
        s += '<line x1="' + f(x + 收 + (w - 2 * 收) * t) + '" y1="' + f(y) +
             '" x2="' + f(x + w * t) + '" y2="' + f(y + h) +
             '" stroke="' + stroke + '" stroke-width="0.4" opacity="0.45"/>';
      }
    }
    // 正脊、垂脊：细长条，画成线加脊身
    else if (/正脊|垂脊/.test(名)) {
      s += '<rect x="' + f(x) + '" y="' + f(y) + '" width="' + f(w) + '" height="' + f(Math.max(3, h)) +
        '" fill="' + st.fill + '" stroke="' + stroke + '" stroke-width="' + st.w + '"' + dash + "/>";
      if (/正脊/.test(名)) {
        s += '<line x1="' + f(x) + '" y1="' + f(y + h / 2) + '" x2="' + f(x + w) + '" y2="' + f(y + h / 2) +
          '" stroke="' + stroke + '" stroke-width="1.6"/>';
      }
    }
    // 吻兽、脊刹：脊上小构件，画成上翘的形
    else if (/吻兽|脊刹/.test(名)) {
      s += '<path d="M' + f(x) + " " + f(y + h) + " Q" + f(x + w / 2) + " " + f(y - h * 0.25) +
        " " + f(x + w) + " " + f(y + h) + ' Z" fill="' + st.fill +
        '" stroke="' + stroke + '" stroke-width="' + st.w + '"' + dash + "/>";
    }
    // 柱：矩形加柱身竖线，柱础加宽
    else if (p.类别 === "柱") {
      s += '<rect x="' + f(x) + '" y="' + f(y) + '" width="' + f(w) + '" height="' + f(h) +
        '" fill="' + st.fill + '" stroke="' + stroke + '" stroke-width="' + st.w + '"' + dash + "/>" +
        '<line x1="' + f(x + w / 2) + '" y1="' + f(y + 2) + '" x2="' + f(x + w / 2) + '" y2="' + f(y + h - 2) +
        '" stroke="' + stroke + '" stroke-width="0.4" opacity="0.5"/>' +
        '<rect x="' + f(x - w * 0.22) + '" y="' + f(y + h - 6) + '" width="' + f(w * 1.44) + '" height="6" ' +
        'fill="' + st.fill + '" stroke="' + stroke + '" stroke-width="' + st.w + '"/>';
    }
    // 台基：矩形加上皮线
    else if (/台基|月台/.test(名)) {
      s += '<rect x="' + f(x) + '" y="' + f(y) + '" width="' + f(w) + '" height="' + f(h) +
        '" fill="' + st.fill + '" stroke="' + stroke + '" stroke-width="' + st.w + '"' + dash + "/>" +
        '<line x1="' + f(x) + '" y1="' + f(y + 3) + '" x2="' + f(x + w) + '" y2="' + f(y + 3) +
        '" stroke="' + stroke + '" stroke-width="0.6" opacity="0.7"/>';
    }
    // 踏步：画成台阶
    else if (/踏步/.test(名)) {
      const 级 = 3, dh = h / 级, dw = w / (级 * 2);
      let pts = [];
      for (let i = 0; i < 级; i++) {
        pts.push([x + dw * i, y + dh * i]);
        pts.push([x + w - dw * i, y + dh * i]);
        pts.push([x + w - dw * i, y + dh * (i + 1)]);
        pts.push([x + dw * i, y + dh * (i + 1)]);
      }
      for (let i = 0; i < 级; i++) {
        s += '<rect x="' + f(x + dw * i) + '" y="' + f(y + dh * i) + '" width="' + f(w - dw * i * 2) +
          '" height="' + f(dh) + '" fill="' + st.fill + '" stroke="' + stroke + '" stroke-width="0.8"/>';
      }
    }
    // 椽飞：密排短竖线
    else if (p.类别 === "屋面木作") {
      s += '<rect x="' + f(x) + '" y="' + f(y) + '" width="' + f(w) + '" height="' + f(h) +
        '" fill="' + st.fill + '" stroke="' + stroke + '" stroke-width="' + st.w + '"' + dash + "/>";
      const n = Math.max(8, Math.round(w / 12));
      for (let i = 1; i < n; i++) {
        const gx = x + (w / n) * i;
        s += '<line x1="' + f(gx) + '" y1="' + f(y) + '" x2="' + f(gx) + '" y2="' + f(y + h) +
          '" stroke="' + stroke + '" stroke-width="0.35" opacity="0.6"/>';
      }
    }
    // 铺作：密排小格，体现清式密布
    else if (p.类别 === "铺作") {
      s += '<rect x="' + f(x) + '" y="' + f(y) + '" width="' + f(w) + '" height="' + f(h) +
        '" fill="' + st.fill + '" stroke="' + stroke + '" stroke-width="' + st.w + '"' + dash + "/>";
      const n = Math.max(4, Math.round(w / 24));
      for (let i = 1; i < n; i++) {
        const gx = x + (w / n) * i;
        s += '<line x1="' + f(gx) + '" y1="' + f(y) + '" x2="' + f(gx) + '" y2="' + f(y + h) +
          '" stroke="' + stroke + '" stroke-width="0.5" opacity="0.75"/>';
      }
      s += '<line x1="' + f(x) + '" y1="' + f(y + h * 0.55) + '" x2="' + f(x + w) + '" y2="' + f(y + h * 0.55) +
        '" stroke="' + stroke + '" stroke-width="0.5" opacity="0.6"/>';
    }
    // 雀替：柱头两侧的托，画成带弧的形
    else if (/雀替|替木/.test(名)) {
      s += '<path d="M' + f(x) + " " + f(y) + " L" + f(x + w) + " " + f(y) +
        " Q" + f(x + w * 0.4) + " " + f(y + h * 0.6) + " " + f(x) + " " + f(y + h) +
        ' Z" fill="' + st.fill + '" stroke="' + stroke + '" stroke-width="' + st.w + '"' + dash + "/>";
    }
    // 其余按矩形
    else {
      s += '<rect x="' + f(x) + '" y="' + f(y) + '" width="' + f(w) + '" height="' + f(h) +
        '" fill="' + st.fill + '" stroke="' + stroke + '" stroke-width="' + st.w + '"' + dash + "/>";
    }

    // 引出标注：小构件放到框外，避免压在图上
    const 估 = /（估）|\(估\)/.test(p.尺寸 || "");
    const 标签 = esc(名) + (估 ? "(估)" : "") + (未确认 ? "(不可见)" : "");
    if (w > 30 && h > 14) {
      s += '<text x="' + f(x + w / 2) + '" y="' + f(y + h / 2 + 3.5) +
        '" text-anchor="middle" font-size="8.5" fill="#2d2a24" opacity="0.9">' + 标签 + "</text>";
    } else if (w > 8) {
      const ly = y - 4 < M.t + 6 ? y + h + 9 : y - 4;
      s += '<text x="' + f(x + w / 2) + '" y="' + f(ly) +
        '" text-anchor="middle" font-size="7.5" fill="#5f5a51">' + 标签 + "</text>";
    }
    return s;
  }

  /* 横向尺寸链：优先用实测的开间尺寸，没有就按位置框宽度标估算 */
  function dimsH(S, X, Y, bh, maxY) {
    const 柱 = S.构件.filter(p => p.名称 === "檐柱").sort((a, b) => a.框[0] - b.框[0]);
    if (柱.length < 2) return "";
    const y = Y(maxY) + 34;
    const 实测 = {};
    S.实测.forEach(d => { if (d.状态 === "measured") 实测[d.部位] = d.数值; });

    let s = '<line x1="' + f(X(柱[0].框[0])) + '" y1="' + f(y) + '" x2="' + f(X(柱[柱.length - 1].框[2])) +
      '" y2="' + f(y) + '" stroke="#3c5a78" stroke-width="0.8"/>';

    for (let i = 0; i < 柱.length - 1; i++) {
      const a = (柱[i].框[0] + 柱[i].框[2]) / 2, b = (柱[i + 1].框[0] + 柱[i + 1].框[2]) / 2;
      const mid = X((a + b) / 2);
      const 中间 = i === Math.floor((柱.length - 1) / 2);
      const 名 = 中间 ? "明间面阔" : "次间面阔";
      const v = 实测[名];
      const 文 = v ? v + "" : "按图估算";
      s += '<line x1="' + f(X(a)) + '" y1="' + f(y - 6) + '" x2="' + f(X(a)) + '" y2="' + f(y + 6) +
           '" stroke="#3c5a78" stroke-width="0.8"/>' +
           '<line x1="' + f(X(b)) + '" y1="' + f(y - 6) + '" x2="' + f(X(b)) + '" y2="' + f(y + 6) +
           '" stroke="#3c5a78" stroke-width="0.8"/>' +
           '<text x="' + f(mid) + '" y="' + f(y - 9) + '" text-anchor="middle" font-size="10" fill="#3c5a78">' +
           esc(文) + (v ? "" : "") + "</text>";
    }
    const 通 = 实测["通面阔"];
    s += '<text x="' + f(X(0.5)) + '" y="' + f(y + 24) + '" text-anchor="middle" font-size="10.5" fill="#3c5a78">' +
      "通面阔 " + (通 ? 通 + "（实测）" : "无实测") + "</text>";
    return s;
  }

  /* 纵向尺寸链：台基高、檐柱高、檐口高 */
  function dimsV(S, X, Y, bw, maxX) {
    const x = Math.min(W - M.r + 46, X(maxX) + 46);
    const 实测 = {};
    S.实测.forEach(d => { if (d.状态 === "measured") 实测[d.部位] = d.数值; });
    const 台 = S.构件.find(p => p.名称 === "台基");
    const 柱 = S.构件.find(p => p.名称 === "檐柱");
    const 屋 = S.构件.find(p => p.类别 === "屋面");
    let s = "";
    function seg(y1, y2, 名, 值) {
      if (y1 == null || y2 == null) return "";
      const a = Y(y1), b = Y(y2);
      return '<line x1="' + f(x) + '" y1="' + f(a) + '" x2="' + f(x) + '" y2="' + f(b) +
        '" stroke="#5a7a5f" stroke-width="0.8"/>' +
        '<line x1="' + f(x - 5) + '" y1="' + f(a) + '" x2="' + f(x + 5) + '" y2="' + f(a) + '" stroke="#5a7a5f" stroke-width="0.8"/>' +
        '<line x1="' + f(x - 5) + '" y1="' + f(b) + '" x2="' + f(x + 5) + '" y2="' + f(b) + '" stroke="#5a7a5f" stroke-width="0.8"/>' +
        '<text x="' + f(x + 8) + '" y="' + f((a + b) / 2 + 3) + '" font-size="9.5" fill="#5a7a5f">' +
        esc(名 + " " + (值 ? 值 : "估")) + "</text>";
    }
    if (台) s += seg(台.框[1], 台.框[3], "台基高", 实测["台基高"]);
    if (柱) s += seg(柱.框[1], 柱.框[3], "檐柱高", 实测["檐柱高"]);
    if (屋) s += seg(屋.框[1], 屋.框[3], "屋面", null);
    return s;
  }

  function titleBlock(S, 比例, 总数, 估算数, 不可见) {
    const x = W - M.r - 250, y = H - 96, w = 340, h = 74;
    const 签发 = (S.交付.确认.find(c => c.环节 === "责任签发") || {});
    const rows = [
      ["项目", DATA.项目.名称],
      ["图名", "正立面现状图　" + 比例],
      ["构件", 总数 + " 项，其中估算 " + 估算数 + " 项，不可见 " + 不可见 + " 项"],
      ["尺寸依据", S.实测.filter(d => d.状态 === "measured").length + " 项现场实测"],
      ["签发", 签发.完成 ? 签发.人 + "　" + 签发.时间 : "未签发"]
    ];
    let s = '<rect x="' + x + '" y="' + y + '" width="' + w + '" height="' + h +
      '" fill="#fff" stroke="#2d2a24" stroke-width="1"/>';
    rows.forEach((r, i) => {
      const ty = y + 13 + i * 13;
      s += '<text x="' + (x + 6) + '" y="' + ty + '" font-size="8.5" fill="#5f5a51">' + esc(r[0]) + "</text>" +
           '<text x="' + (x + 58) + '" y="' + ty + '" font-size="8.5" fill="#2d2a24">' + esc(r[1]) + "</text>";
    });
    s += '<text x="' + (M.l - 60) + '" y="' + (H - 30) + '" font-size="8" fill="#8b8676">' +
      "本图由工作台按当前构件数据实时生成，非正式测绘成果。标注（估）者无实测依据。</text>";
    return s;
  }

  function f(n) { return Math.round(n * 10) / 10; }

  return { render };
})();
