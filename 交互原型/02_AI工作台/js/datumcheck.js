/* 尺寸一致性核对。这一步由规则程序做，不交给模型。
   实测发现：同一份数据，kimi-k2.6 算出了分间之和与通面阔差 4400mm 的矛盾，
   moonshot-v1-128k 不仅没发现，还算错成 2800 并编造了一条不存在的矛盾。
   这类结果唯一、可复算的检查必须由程序承担，用模型不可靠。 */
window.DatumCheck = (function () {

  /* 部位名称标准化。模型会把"明间面阔"写成"明间"这类近义词，
     写入前不映射到标准名，核对规则会静默失效：页面还说有矛盾，程序却算不出差值。 */
  const 标准名 = ["通面阔", "明间面阔", "次间面阔", "梢间面阔", "通进深",
                  "台基高", "檐柱高", "金柱高", "檐口高", "正脊高"];
  const 同义 = { 明间: "明间面阔", 次间: "次间面阔", 梢间: "梢间面阔",
    总面阔: "通面阔", 通面宽: "通面阔", 面阔总长: "通面阔",
    台基: "台基高", 檐柱: "檐柱高", 金柱: "金柱高", 檐口: "檐口高", 进深: "通进深" };
  function normalize(部位) {
    const s = String(部位 || "").replace(/\s/g, "").replace(/（.*?）|\(.*?\)/g, "");
    if (标准名.includes(s)) return s;
    if (同义[s]) return 同义[s];
    const t = s.replace(/高度$/, "高").replace(/宽$/, "面阔");
    if (标准名.includes(t)) return t;
    if (同义[t]) return 同义[t];
    return String(部位 || "").trim();   // 映射不了保留原词，标准化失败不如保留原始信息
  }

  // 读取时也按标准名比对，已存进去的近义词同样能被核对到
  function val(list, 部位) {
    const d = list.find(x => normalize(x.部位) === 部位 && x.状态 === "measured");
    return d ? d.数值 : null;
  }

  function run(实测) {
    const out = [];

    // 项目数据声明尺寸关系，规则层不再假定所有建筑都是三开间。
    const relations = (window.DATA && Array.isArray(DATA.尺寸关系)) ? DATA.尺寸关系 : [];
    relations.filter(r => r && r.类型 === "sum").forEach(r => {
      const total = val(实测, normalize(r.结果));
      const terms = Array.isArray(r.项) ? r.项.map(item => ({
        部位: normalize(item.部位), 数量: Number(item.数量 || 1), 值: val(实测, normalize(item.部位))
      })) : [];
      if (total == null || !terms.length || terms.some(item => item.值 == null)) return;
      const sum = terms.reduce((n, item) => n + item.值 * item.数量, 0);
      const diff = total - sum;
      const tolerance = Number(r.容差mm || 20);
      if (Math.abs(diff) > tolerance) {
        out.push({
          标题: r.标题 || "分尺寸之和与总尺寸不符",
          算式: terms.map(item => item.部位 + " " + item.值 + (item.数量 === 1 ? "" : " × " + item.数量)).join(" + ") +
            " = " + sum + "，" + normalize(r.结果) + "实测 " + total + "，差 " + diff + " mm",
          说明: r.说明 || ("超出项目设置的 ±" + tolerance + "mm 容差，需要复核测量范围或原始记录。")
        });
      }
    });

    // 规则二：檐柱高应大于台基高
    const 柱 = val(实测, "檐柱高");
    const 台 = val(实测, "台基高");
    if (柱 && 台 && 柱 <= 台) {
      out.push({
        标题: "檐柱高不大于台基高",
        算式: "檐柱高 " + 柱 + "，台基高 " + 台,
        说明: "数值关系不合理，请复核两项实测的测量起止点。"
      });
    }

    return out;
  }

  return { run, normalize };
})();
