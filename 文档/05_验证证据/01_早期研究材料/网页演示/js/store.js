// 状态管理。所有数据读写和状态机流转都经过这里，界面文件不直接碰 localStorage。
window.Store = (function () {
  const KEY = "gujian-demo-v1";

  // 状态机：合法流转表。改状态只能走 transition()，防止界面各写各的
  const 状态流转 = {
    "草稿":     ["校正中"],
    "校正中":   ["校正完成"],
    "校正完成": ["已出图", "校正中"],
    "已出图":   ["校正中"]        // 重开校正，版本号在出图时递增
  };

  let state = load();

  function load() {
    try {
      const raw = localStorage.getItem(KEY);
      if (raw) return JSON.parse(raw);
    } catch (e) { /* 数据损坏则重置 */ }
    return JSON.parse(JSON.stringify(window.SEED));
  }

  function save() { localStorage.setItem(KEY, JSON.stringify(state)); }

  function reset() { localStorage.removeItem(KEY); state = JSON.parse(JSON.stringify(window.SEED)); }

  function now() {
    const d = new Date();
    const p = n => String(n).padStart(2, "0");
    return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
  }

  return {
    reset,
    now,
    词表: () => state.词表 || window.SEED.词表,
    projects: () => state.项目,
    project: id => state.项目.find(p => p.id === id),
    units: prjId => state.单元.filter(u => u.项目id === prjId),
    unit: id => state.单元.find(u => u.id === id),

    addProject(名称, 委托方, 负责人) {
      const id = "prj-" + String(state.项目.length + 1).padStart(3, "0") + "-" + Date.now().toString(36);
      state.项目.push({ id, 名称, 委托方, 负责人, 创建日期: now().slice(0, 10), 单元: [] });
      save();
      return id;
    },

    addUnit(prjId, fields) {
      const id = "unit-" + Date.now().toString(36);
      state.单元.push(Object.assign({
        id, 项目id: prjId, 状态: "草稿", 图纸版本: 0,
        照片: [], 实测尺寸: [], 部件: [], 核心尺寸: [],
        立面图: "", 布局图: "",
        出图设置: { 视图: "正立面", 比例: "1:100", 图幅: "A3", 交付规范: "GB/T 50001 制图统一标准", 图号: "" },
        审计: null, 校正记录: [], 交付记录: []
      }, fields));
      const prj = state.项目.find(p => p.id === prjId);
      if (prj) prj.单元.push(id);
      save();
      return id;
    },

    // 状态机流转。返回 true=成功，false=非法流转（界面据此禁用按钮）
    transition(unitId, to) {
      const u = this.unit(unitId);
      if (!u) return false;
      const allowed = 状态流转[u.状态] || [];
      if (!allowed.includes(to)) return false;
      if (to === "已出图") {
        u.图纸版本 += 1;   // 版本号只在出图时递增（07 PRD R004/R005）
      }
      u.状态 = to;
      save();
      return true;
    },
    canGo(unitId, to) {
      const u = this.unit(unitId);
      return !!u && (状态流转[u.状态] || []).includes(to);
    },

    mutate(unitId, fn) {   // 通用改写入口：fn(unit) 里改字段，自动保存
      const u = this.unit(unitId);
      if (!u) return;
      fn(u);
      save();
    },

    // 校正动作统一走这里，自动记录（校正记录表是 08 过程漏斗的数据来源）
    correct(unitId, 部件编号, 动作, 内容) {
      this.mutate(unitId, u => {
        u.校正记录.push({ 时间: now(), 部件: 部件编号, 动作, 内容 });
      });
    }
  };
})();
