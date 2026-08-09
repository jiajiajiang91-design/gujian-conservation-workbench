/* 视图：图纸样式。出图前必须由人选定画法、标注、图签与附表。 */
window.ViewStyle = function (root) {
  const S = Store.get();
  const data = UI.el("div", "pane-data");
  const body = UI.el("div", "pane-body");
  data.appendChild(body);
  const evi = UI.el("div", "pane-evi");

  const opts = {
    构件画法: ["按规范附录 B 简化画法", "按实测轮廓详绘", "斗栱按标准图集替代"],
    标注方式: ["尺寸线标注，估算值加括注", "全部尺寸标注", "仅标注控制尺寸"],
    图签: ["泽州县文物保护中心标准图签", "测绘院通用图签"],
    图层: ["按规范附录 B 图层表", "沿用院内图层标准"]
  };
  Object.keys(opts).forEach(k => {
    const current = S.图纸样式[k];
    if (current && !opts[k].includes(current)) opts[k].unshift(current);
  });

  function paint() {
    let html = '<div class="pane-title"><span>出图设置</span><span class="hint">请按项目要求确认画法、标注和图签</span></div><div class="card">';
    Object.keys(opts).forEach(k => {
      html += '<div style="margin-bottom:10px"><label class="hint">' + k + "</label>" +
        '<select data-k="' + k + '" style="width:100%;padding:5px 8px;border:1px solid var(--line);border-radius:3px;margin-top:3px">' +
        opts[k].map(o => '<option' + (S.图纸样式[k] === o ? " selected" : "") + ">" + o + "</option>").join("") +
        "</select></div>";
    });
    html += '<div style="margin-top:12px"><label class="hint">附表</label><div style="margin-top:4px">' +
      ["构件材料表", "尺寸依据说明", "存疑项清单", "照片索引表"].map(x =>
        '<label style="display:block;font-weight:400;margin:3px 0"><input type="checkbox" class="att" value="' + x + '"' +
        (S.图纸样式.附表.includes(x) ? " checked" : "") + "> " + x + "</label>").join("") +
      "</div></div></div>";

    html += '<div class="card"><div class="card-title">图纸如何生成</div>' +
      '<div class="hint" style="line-height:1.9">系统会按上面的选择绘制、标注和排版。同一份构件数据会得到一致的图纸结果。遇到非标准形制时，仍需你确认采用哪种画法。</div></div>';

    body.innerHTML = html;

    body.querySelectorAll("select").forEach(s => {
      s.onchange = () => { S.图纸样式[s.dataset.k] = s.value; Store.emit(); };
    });
    body.querySelectorAll("input.att").forEach(c => {
      c.onchange = () => {
        const set = new Set(S.图纸样式.附表);
        c.checked ? set.add(c.value) : set.delete(c.value);
        S.图纸样式.附表 = Array.from(set);
        Store.emit();
      };
    });
  }

  root.appendChild(data);
  root.appendChild(evi);
  paint();
  const stylePreview = ProjectData.resolveResource(DATA.资源.样式参考图 || DATA.资源.正式图);
  evi.innerHTML = '<div class="evi-tools">出图效果预览</div>' +
    '<div class="evi-stage"><div class="evi-wrap">' +
    (stylePreview ? '<img src="' + UI.esc(stylePreview) + '" alt="立面图">' : '<div class="empty">没有样式参考图</div>') +
    '</div></div>';

  UI.actionBar(data, [
    { label: "设置完成，生成图纸", primary: true, onClick: () => Orchestrator.runDrawing() },
    { label: "回记录现状", onClick: () => Store.goto("condition") }
  ], "系统将按这里的选择生成图纸；非标准形制仍需人工确认画法。");
};
