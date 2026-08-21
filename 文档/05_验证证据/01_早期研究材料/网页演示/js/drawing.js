// 参数化示意出图（浏览器 SVG 版画法库 v0）。
// 从部件表和核心尺寸生成正立面示意图：台基、柱网、额枋、斗拱带、屋面、门窗全部数据驱动。
// 与 poc 的 ezdxf 出图是同一思路的简化版：这里验证参数化画法，DXF 精确出图在 poc 脚本。
window.Drawing = (function () {

  // 从"3600（估）"之类的字符串里取数字
  function num(s, fallback) {
    const m = String(s || "").match(/\d+/);
    return m ? Number(m[0]) : fallback;
  }
  function dim(unit, name, fallback) {
    const d = (unit.核心尺寸 || []).find(x => (x.名称 || "").includes(name));
    if (d) return num(d.数值, fallback);
    const m = (unit.实测尺寸 || []).find(x => (x.名称 || "").includes(name));
    if (m) return Number(m.数值) || fallback;
    return fallback;
  }
  function has(unit, kw) { return (unit.部件 || []).some(p => (p.名称 + (p.类别 || "")).includes(kw)); }

  function buildSVG(unit) {
    // 控制尺寸（mm），缺省值取三样本的常见量级
    const 通面阔 = dim(unit, "通面阔", 9600);
    const 柱高 = dim(unit, "柱高", dim(unit, "檐柱", 3300));
    const 台基高 = dim(unit, "台基", 500);
    const 檐口高 = Math.max(dim(unit, "檐口", 柱高 + 1700), 柱高 + 800);
    const 脊高 = Math.max(dim(unit, "脊线", 檐口高 + 2000), 檐口高 + 800);
    const 台基挑出 = 900, 檐出 = 1100;
    const 开间数 = 通面阔 > 14000 ? 5 : 3;
    const 敞廊 = has(unit, "敞");
    const 有门 = has(unit, "门") && !敞廊;
    const 有窗 = (has(unit, "窗") || has(unit, "直棂")) && !敞廊;
    const 有斗拱 = has(unit, "斗拱") || has(unit, "铺作");
    const 有脊刹 = has(unit, "脊刹") || has(unit, "宝顶");
    const 有吻兽 = has(unit, "吻");
    const 歇山 = (unit.屋顶形式 || "").includes("歇山") || (unit.屋顶形式 || "").includes("庑殿");

    // 画布：mm → px。上留白 1800（含脊刹与图题），下留白 1800（含尺寸线与标注文字）
    const W = 通面阔 + 2 * (檐出 + 800), H = 脊高 + 台基高 + 1800 + 1800;
    const sc = 760 / W;
    const px = v => (v * sc).toFixed(1);
    // 坐标系：x 从左留白起，y 从地面起向上（SVG y 翻转）
    const X = mm => px(mm + 檐出 + 800);
    const Y = mm => px(H - 1800 - 台基高 - mm);   // mm 以台基顶面为 0
    const L = [];  // svg 元素
    const line = (x1, y1, x2, y2, w) => L.push(`<line x1="${X(x1)}" y1="${Y(y1)}" x2="${X(x2)}" y2="${Y(y2)}" stroke="#2D2A24" stroke-width="${w || 1}"/>`);
    const rect = (x, y, w, h, sw) => L.push(`<rect x="${X(x)}" y="${Y(y + h)}" width="${px(w)}" height="${px(h)}" fill="none" stroke="#2D2A24" stroke-width="${sw || 1}"/>`);
    const text = (x, y, s, size) => L.push(`<text x="${X(x)}" y="${Y(y)}" font-size="${size || 11}" fill="#6B6555" text-anchor="middle">${s}</text>`);

    // 台基
    rect(-台基挑出, -台基高, 通面阔 + 2 * 台基挑出, 台基高, 1.5);
    // 踏步（中央三级示意）
    for (let i = 1; i <= 3; i++) {
      const w = 1800 - i * 300, y = -台基高 * i / 3;
      line(通面阔 / 2 - w / 2, y, 通面阔 / 2 + w / 2, y);
    }

    // 柱网
    const 柱数 = 开间数 + 1, 柱宽 = 360;
    const bay = 通面阔 / 开间数;
    const 柱x = [];
    for (let i = 0; i < 柱数; i++) {
      const cx = i * bay;
      柱x.push(cx);
      rect(cx - 柱宽 / 2, 0, 柱宽, 柱高);
      rect(cx - 柱宽 * 0.8, 0, 柱宽 * 1.6, 220);  // 柱础
    }

    // 额枋带
    const 枋高 = 520;
    rect(0 - 柱宽 / 2, 柱高, 通面阔 + 柱宽, 枋高, 1.2);

    // 斗拱带（示意：连续小方格）
    let 拱顶 = 柱高 + 枋高;
    if (有斗拱) {
      const 拱高 = Math.min(檐口高 - 拱顶, 900);
      rect(-柱宽 / 2, 拱顶, 通面阔 + 柱宽, 拱高);
      const n = Math.round(通面阔 / 1200);
      for (let i = 1; i < n; i++) line(i * 通面阔 / n, 拱顶, i * 通面阔 / n, 拱顶 + 拱高, 0.6);
      拱顶 += 拱高;
    }

    // 檐口与屋面
    const 檐左 = -檐出, 檐右 = 通面阔 + 檐出;
    line(檐左, 檐口高, 檐右, 檐口高, 1.5);           // 檐口线
    line(檐左, 檐口高 - 260, 檐右, 檐口高 - 260, 0.8); // 椽飞带
    const 脊半宽 = 歇山 ? 通面阔 * 0.3 : 通面阔 * 0.5 + 200;
    const 脊左 = 通面阔 / 2 - 脊半宽, 脊右 = 通面阔 / 2 + 脊半宽;
    line(檐左, 檐口高, 脊左, 脊高, 1.5);              // 左坡
    line(檐右, 檐口高, 脊右, 脊高, 1.5);              // 右坡
    line(脊左, 脊高, 脊右, 脊高, 2);                  // 正脊
    if (有吻兽) {
      rect(脊左 - 150, 脊高 - 100, 420, 620, 1.2);
      rect(脊右 - 270, 脊高 - 100, 420, 620, 1.2);
    }
    if (有脊刹) rect(通面阔 / 2 - 220, 脊高, 440, 620, 1.2);

    // 门窗（敞廊则整间留空）
    if (敞廊) {
      text(通面阔 / 2, 柱高 / 2, "前廊敞开（无门窗墙）");
    } else {
      const 槛墙高 = 900;
      if (有门) {
        const 门宽 = Math.min(bay * 0.55, 2600), 门高 = Math.min(柱高 * 0.75, 2600);
        rect(通面阔 / 2 - 门宽 / 2, 0, 门宽, 门高, 1.2);
        line(通面阔 / 2, 0, 通面阔 / 2, 门高, 0.8);   // 双扇分缝
      }
      if (有窗) {
        for (const side of [0, 开间数 - 1]) {
          if (开间数 >= 3 && side !== Math.floor(开间数 / 2)) {
            const cx = side * bay + bay / 2;
            const 窗宽 = bay * 0.5, 窗高 = Math.min(柱高 * 0.45, 1600);
            rect(cx - 窗宽 / 2, 槛墙高, 窗宽, 窗高);
            const n = 6;
            for (let i = 1; i < n; i++) line(cx - 窗宽 / 2 + i * 窗宽 / n, 槛墙高, cx - 窗宽 / 2 + i * 窗宽 / n, 槛墙高 + 窗高, 0.5); // 直棂
          }
        }
      }
      // 槛墙线
      line(-柱宽 / 2, 0, 通面阔 + 柱宽 / 2, 0, 1);
    }

    // 尺寸标注（估）
    const 估 = unit.实测尺寸.length ? "" : "（估）";
    line(0, -台基高 - 500, 通面阔, -台基高 - 500, 0.6);
    text(通面阔 / 2, -台基高 - 900, `通面阔 ${通面阔}${估}`, 12);
    text(通面阔 + 檐出 + 600, 脊高 / 2, `脊高 ${脊高 + 台基高}${估}`, 11);

    // 图题
    text(通面阔 / 2, 脊高 + 900, `${unit.名称} ${unit.出图设置.视图}示意图（demo 参数化出图，${开间数}开间，${unit.屋顶形式}顶）`, 13);

    const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 760 ${(H * sc).toFixed(0)}" style="background:#FFF; max-width:100%;">${L.join("")}</svg>`;

    // 真实审计：实体计数 + 坐标合法性检查（NaN/负尺寸即错误），与 poc 的 ezdxf audit 同一思路
    let 错误数 = (svg.match(/NaN/g) || []).length;
    for (const m of svg.matchAll(/(?:width|height)="(-[\d.]+)"/g)) 错误数++;
    return { svg, 审计: { 实体数: L.length, 错误数 } };
  }

  return { build: buildSVG };
})();
