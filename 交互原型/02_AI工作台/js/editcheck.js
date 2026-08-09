/* 修改建议的合理性校验。夹在 AI 提议和人工确认之间的第三道防线。
   实测中模型建议把屋面檐口高从 5200mm 改成 1200mm，还标了"把握高"。
   人未必每条都算得过来，所以这类明显不合理的改动由程序先标出来。 */
window.EditCheck = (function () {

  function nums(s) {
    return (String(s).match(/\d+(\.\d+)?/g) || []).map(Number).filter(n => n > 0);
  }
  function maxNum(s) { const a = nums(s); return a.length ? Math.max.apply(null, a) : null; }

  /* 返回警告数组，空数组表示没查出问题 */
  function run(edit, state) {
    const w = [];
    const 旧 = maxNum(edit.原值), 新 = maxNum(edit.新值);

    // 一、数值变化幅度过大
    if (旧 && 新 && 旧 !== 新) {
      const 比 = 新 / 旧;
      if (比 < 0.5) w.push("数值缩小到原来的 " + Math.round(比 * 100) + "%，幅度较大");
      else if (比 > 2) w.push("数值放大到原来的 " + Math.round(比 * 100) + "%，幅度较大");
    }

    // 二、几何关系：檐口高必须大于檐柱高
    if (edit.对象 === "构件" && /檐口高/.test(edit.新值)) {
      const 柱 = (state.实测.find(d => d.部位 === "檐柱高" && d.状态 === "measured") || {}).数值;
      if (柱 && 新 && 新 <= 柱) {
        w.push("檐口高 " + 新 + "mm 不大于实测檐柱高 " + 柱 + "mm，几何上不成立");
      }
    }

    // 三、台基高不应超过檐柱高
    if (edit.对象 === "构件" && /台基/.test(edit.名称 || "")) {
      const 柱 = (state.实测.find(d => d.部位 === "檐柱高" && d.状态 === "measured") || {}).数值;
      if (柱 && 新 && 新 >= 柱) w.push("台基高不应达到或超过檐柱高 " + 柱 + "mm");
    }

    // 四、去掉"（估）"标记但没有对应实测支持
    if (/（估）|\(估\)/.test(edit.原值) && !/（估）|\(估\)/.test(edit.新值)) {
      const 有实测 = state.实测.some(d => d.状态 === "measured" && 新 && Math.abs(d.数值 - 新) < 1);
      if (!有实测) w.push("去掉了估算标记，但实测记录里没有这个数值");
    }

    // 五、改成的值与某项实测同数但部位不同，可能是张冠李戴
    if (edit.对象 === "构件" && 新) {
      const 同数 = state.实测.filter(d => d.状态 === "measured" && Math.abs(d.数值 - 新) < 1);
      if (同数.length && !同数.some(d => (edit.名称 || "").includes(d.部位.replace(/高|宽|面阔/g, "")))) {
        w.push("这个数值与实测项「" + 同数[0].部位 + "」相同，确认不是套错部位");
      }
    }

    return w;
  }

  return { run };
})();
