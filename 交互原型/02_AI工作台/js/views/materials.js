/* 视图：整理资料。左边资料清单与缺口，右边选中资料的原图。 */
window.ViewMaterials = function (root) {
  const S = Store.get();
  const data = UI.el("div", "pane-data");
  // paint 只重写 body，操作条挂在 data 上，否则点一下列表按钮就没了
  const body = UI.el("div", "pane-body");
  data.appendChild(body);
  const evi = UI.el("div", "pane-evi");

  let cur = S.资料.find(m => m.id === (S.选中资料 || "m1")) || S.资料[0];
  const 可用照片 = S.资料.filter(m => m.类型 === "照片" && m.可用);
  const 缺口 = S.资料.filter(m => !m.可用 || m.状态 === "missing");
  const 非正式来源 = S.资料.filter(m => ["demo", "ai", "unknown"].includes(m.状态));

  function rows() {
    return S.资料.map(m => {
      const bad = !m.可用;
      return '<tr class="row' + (bad ? " flag" : "") + (cur && m.id === cur.id ? " sel" : "") + '" data-id="' + UI.esc(m.id) + '">' +
        "<td>" + UI.esc(m.类型) + "</td>" +
        "<td>" + UI.esc(m.名称) + "<div class=\"hint\">" + UI.esc(m.说明) + "</div></td>" +
        "<td>" + UI.esc(m.用途) + "</td>" +
        "<td>" + (bad ? UI.stateBadge("缺") : UI.stateBadge(m.状态)) + "</td></tr>";
    }).join("");
  }

  function paint() {
    body.innerHTML =
      '<div class="pane-title"><span>资料核对</span><span class="hint">共 ' + S.资料.length + " 份</span></div>" +
      '<div class="card">' + UI.table(["类型", "名称", "用途", "状态"], [rows()]) + "</div>" +
      '<div class="card"><div class="card-title">资料是否够用</div>' +
      '<div class="hint" style="line-height:1.9">' +
      (可用照片.length ? "可用照片 " + 可用照片.length + " 张；主图：" + UI.esc(可用照片[0].名称) + "。<br>" : "<b>没有可用照片。</b><br>") +
      (缺口.length ? "<b>资料缺口 " + 缺口.length + " 项：</b>" +
        缺口.map(m => UI.esc(m.名称) + "（" + UI.esc(m.说明) + "）").join("；") + "。"
        : "当前资料清单没有标记缺失项。") +
      (非正式来源.length ? "<br>其中 " + 非正式来源.length + " 项仍是示例、AI 或待确认来源，不能仅凭‘可用’状态作为正式交付依据。" : "") +
      "</div></div>";

    body.querySelectorAll("tr.row").forEach(tr => {
      tr.onclick = () => {
        cur = S.资料.find(m => m.id === tr.dataset.id);
        S.选中资料 = cur.id;
        paint(); paintEvi();
      };
    });
  }

  function paintEvi() {
    if (!cur) {
      evi.innerHTML = '<div class="empty">当前项目还没有资料</div>';
      return;
    }
    if (cur.类型 === "照片") {
      Evidence.mount(evi, "assets/" + cur.文件, { draw: false });
    } else {
      evi.innerHTML = '<div class="evi-tools">' + UI.esc(cur.名称) + "</div>" +
        '<div style="flex:1;display:flex;align-items:center;justify-content:center;color:var(--ink-3);font-size:12.5px;text-align:center;padding:30px">' +
        (cur.可用
          ? UI.esc(cur.文件 || cur.名称) + "<br><span class=\"hint\">" + UI.esc(cur.说明) + "</span>"
          : "这份资料不存在<br><span class=\"hint\">" + UI.esc(cur.说明) + "</span>") +
        "</div>";
    }
  }

  root.appendChild(data);
  root.appendChild(evi);
  paint();
  paintEvi();

  UI.actionBar(data, [
    { label: "资料已核对，检查实测尺寸", primary: true,
      onClick: () => { Store.setStep("materials", "done"); Store.goto("datum"); } },
    { label: "标记需要补拍", onClick: () => {
        const item = 缺口.find(m => m.类型 === "照片") || 缺口[0];
        Store.log("补采清单", item ? item.名称 : DATA.项目.名称, item ? item.说明 : "补充现场资料");
        Store.say("ai", "已把资料缺口记入补采清单，补齐前会保留限制说明。");
      } },
    { label: "回任务要求", onClick: () => Store.goto("task") }
  ], "缺少的资料会在图上标为不可见部位，也可以先安排补拍。");
};
