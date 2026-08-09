/* 状态层：所有可变数据都在这里，视图只读它、只通过方法改它。
   订阅式更新：任何改动后 emit()，各视图重画。 */
window.Store = (function () {
  const LS_PREFIX = "gujian-wt-state:";
  const LEGACY_LS = "gujian-wt-state";
  const MIGRATION_LS = "gujian-wt-state-migrated-v1";
  let subs = [];
  let S = null;
  let currentId = null;
  let projectList = [];
  let lastBusinessSignature = "";

  function copy(value) { return JSON.parse(JSON.stringify(value)); }
  function stateKey(id) { return LS_PREFIX + id; }

  function hydrateProjectList(list) {
    return copy(list || []).map(meta => {
      try {
        const saved = JSON.parse(localStorage.getItem(stateKey(meta.id)) || "null");
        if (!saved || typeof saved !== "object") return meta;
        const step = ProjectData.steps().find(x => x.视图 === saved.当前视图);
        meta.当前步骤 = step ? step.id : (saved.当前步骤 || meta.当前步骤);
        meta.待办 = (saved.存疑 || []).filter(q => !q.已解决).length +
          (saved.检查问题 || []).filter(q => q.处理 === "pending").length;
        meta.状态 = saved.步骤状态 && saved.步骤状态.delivery === "done" ? "已交付"
          : (saved.实测 || []).some(x => x.状态 === "measured") ? "进行中" : "资料待补";
      } catch (e) {}
      return meta;
    });
  }

  function formalResource() {
    const raw = DATA.资源 && DATA.资源.正式图;
    if (raw && typeof raw === "object") return copy(raw);
    return { path: raw || "", sourceProjectId: DATA.项目.id, generationVersion: "legacy-preview",
      generatedAt: "", parametersHash: "", status: "preview" };
  }

  function fresh() {
    const state = {
      项目Id: DATA.项目.id,
      存档版本: "1.0",
      当前步骤: "task",
      当前视图: "start",
      已进入项目: false,
      项目列表: copy(projectList),
      退回记录: [],
      主图: null,            // 用户上传照片后指向那张图
      构件来源: "演示预置",
      实测来源: "演示预置",
      选中构件: null,
      步骤状态: {            // idle 未开始 / running 进行中 / stop 等待人决定 / done 完成
        task: "idle", materials: "idle", datum: "idle", parts: "idle",
        condition: "idle", style: "idle", drawing: "idle", delivery: "idle"
      },
      解锁到: 0,             // 已解锁的步骤序号
      任务卡: copy(DATA.任务卡),
      人员: copy(DATA.人员),
      资料: copy(DATA.资料),
      实测: copy(DATA.实测),
      构件: copy(DATA.构件),
      存疑: copy(DATA.存疑),
      现状: copy(DATA.现状),
      图纸样式: copy(DATA.图纸样式),
      检查问题: copy(DATA.检查问题),
      检查已运行: false,
      交付: copy(DATA.交付),
      正式图资源: formalResource(),
      消息: [],
      修改记录: copy(DATA.修改记录 || []),
      构件库: copy(DATA.构件库 || []),
      排除记录: copy(DATA.排除记录 || []),
      状态条: { 标题: "可以开始", 说明: "说明任务或选择一个项目", 类型: "idle" },
      引用: null,            // 当前框选引用 {构件, 框, 图}
      降级: false,           // 是否已选择无实测基准出草图
      真实调用: false
    };
    const workflow = DATA.导入工作流;
    if (workflow && typeof workflow === "object") {
      if (workflow.当前步骤) state.当前步骤 = workflow.当前步骤;
      if (workflow.步骤状态) state.步骤状态 = copy(workflow.步骤状态);
      if (Number.isFinite(Number(workflow.解锁到))) state.解锁到 = Number(workflow.解锁到);
      state.检查已运行 = !!workflow.检查已运行;
      if (Array.isArray(workflow.退回记录)) state.退回记录 = copy(workflow.退回记录);
    }
    return state;
  }

  function load() {
    const base = fresh();
    let loadedVersion = null;
    try {
      let raw = localStorage.getItem(stateKey(currentId));
      // 旧存档只复制一次到高都项目，保留旧键便于回退。
      if (!raw && currentId === "gaodu" && !localStorage.getItem(MIGRATION_LS)) {
        const legacy = localStorage.getItem(LEGACY_LS);
        if (legacy) {
          raw = legacy;
          localStorage.setItem(stateKey(currentId), legacy);
        }
        localStorage.setItem(MIGRATION_LS, new Date().toISOString());
      }
      const saved = raw ? JSON.parse(raw) : null;
      loadedVersion = saved && saved.存档版本;
      S = saved && typeof saved === "object" ? Object.assign({}, base, saved) : base;
    } catch (e) { S = base; }
    if (!S || !S.步骤状态) S = base;
    migrateLoadedState(S, base, loadedVersion);
    S.项目Id = currentId;
    S.项目列表 = copy(projectList);
    if (!S.正式图资源) S.正式图资源 = formalResource();
    // 旧版本存档没有这两个字段，补上
    if (!S.构件库) S.构件库 = [];
    if (!S.排除记录) S.排除记录 = [];
    // 旧存档沿用新版界面用语，避免刷新后继续出现“助手识别”等旧文字。
    if (S.状态条 && S.状态条.标题 === "工作助手") S.状态条.标题 = "可以开始";
    const 更新文字 = value => typeof value === "string"
      ? value.replaceAll("助手识别", "AI 识别")
        .replaceAll("人员确认", "人工确认")
        .replaceAll("采纳助手建议", "采纳 AI 建议")
      : value;
    (S.消息 || []).forEach(m => {
      m.text = 更新文字(m.text);
      if (m.card) {
        m.card.title = 更新文字(m.card.title);
        m.card.body = 更新文字(m.card.body);
        (m.card.options || []).forEach(o => {
          o.label = 更新文字(o.label);
          o.sub = 更新文字(o.sub);
        });
      }
    });
    // 旧版点击未开始步骤会反复写入提示，清理这些导航噪声并合并连续重复消息。
    const 导航提示 = /^「.+」还没有开始。这里先显示待处理内容，完成前一步后会自动更新。$/;
    const 整理后 = [];
    (S.消息 || []).forEach(m => {
      if (导航提示.test(m.text || "")) return;
      const 上条 = 整理后[整理后.length - 1];
      const 纯文本重复 = 上条 && 上条.who === m.who && 上条.text === m.text &&
        !上条.card && !m.card && !上条.process && !m.process && !上条.edits && !m.edits;
      if (!纯文本重复) 整理后.push(m);
    });
    S.消息 = 整理后.slice(-40);
    lastBusinessSignature = businessSignature(S);
    save();
  }

  function migrateLoadedState(state, base, loadedVersion) {
    // 旧版把演示预置尺寸和构件写成 measured。只迁移仍标为演示来源的存档，
    // 用户上传草图形成的实测状态保持不变。
    if (DATA.项目.验证性质 === "demo-proxy" && state.实测来源 !== "用户上传的草图") {
      [state.实测, state.构件, state.现状].forEach(list => (list || []).forEach(item => {
        if (item.状态 === "measured") {
          item.状态 = "demo";
          item.可用于正式交付 = false;
        }
      }));
    }
    if (DATA.项目.验证性质 === "demo-proxy") {
      const baseline = base.任务卡.实测基准;
      const current = state.任务卡 && state.任务卡.实测基准;
      if (baseline && (!current || ["missing", "demo", "缺"].includes(current.来源))) {
        state.任务卡.实测基准 = copy(baseline);
      }
      const baselineMaterial = base.资料.find(x => x.id === "m7");
      const savedMaterial = state.资料.find(x => x.id === "m7");
      if (baselineMaterial && savedMaterial && !["human", "ai"].includes(savedMaterial.状态)) {
        Object.assign(savedMaterial, copy(baselineMaterial));
      }
    }
    if (loadedVersion === "1.0") return;
    state.正式图资源 = formalResource();
    state.存档版本 = "1.0";
    if (!Array.isArray(state.修改记录)) state.修改记录 = [];
    state.修改记录.push({ 动作: "迁移存档", 对象: DATA.项目.id,
      说明: "保留旧存档并迁移来源枚举、项目资源和代理验证边界",
      人: "系统", 时间: new Date().toLocaleString("zh-CN", { hour12: false }) });
  }
  function save() {
    if (!S || !currentId) return false;
    if (S.存储错误) delete S.存储错误;
    try {
      localStorage.setItem(stateKey(currentId), JSON.stringify(S));
      return true;
    } catch (e) {
      S.存储错误 = "浏览器没有保存本次修改，请立即导出结构化工作包。";
      return false;
    }
  }
  function reset() {
    try { localStorage.removeItem(stateKey(currentId)); } catch (e) {}
    S = fresh();
    lastBusinessSignature = businessSignature(S);
    save(); emit();
  }

  function init(bundle, list) {
    projectList = hydrateProjectList(list);
    ProjectData.activate(bundle);
    currentId = DATA.项目.id;
    load();
    return S;
  }

  async function switchProject(id) {
    if (!id || id === currentId) return S;
    if (window.API && API.hasPending && API.hasPending()) {
      throw new Error("AI 正在处理当前项目，请等本次处理完成后再切换项目。");
    }
    const bundle = await ProjectData.load(id);
    save();
    ProjectData.activate(bundle);
    currentId = DATA.项目.id;
    projectList = hydrateProjectList(ProjectData.list());
    load();
    emit();
    return S;
  }

  async function importProject(file) {
    if (window.API && API.hasPending && API.hasPending()) {
      throw new Error("AI 正在处理当前项目，请等本次处理完成后再导入。");
    }
    const result = await ProjectData.importFile(file);
    projectList = hydrateProjectList(ProjectData.list());
    await switchProject(result.bundle.项目.id);
    log("导入项目", result.bundle.项目.id, "从本地 JSON 导入为独立项目");
    emit();
    return result;
  }

  function exportCurrent() { return ProjectData.buildExport(S); }
  function downloadCurrent() {
    const bundle = exportCurrent();
    ProjectData.download(bundle);
    log("导出项目", DATA.项目.id, "导出结构化项目数据包");
    emit();
  }

  function get() { return S; }
  function sub(fn) { subs.push(fn); }

  /* 视图级订阅。视图会被反复创建，用全局 sub 会不断累积，
     切换十次就有十个回调在跑。这里单独存一份，切视图时清掉。 */
  let viewSubs = [];
  function subView(fn) { viewSubs.push(fn); }
  function clearViewSubs() { viewSubs = []; }

  function emit() {
    const signature = businessSignature(S);
    if (lastBusinessSignature && signature !== lastBusinessSignature && S.正式图资源 &&
        S.正式图资源.status !== "stale") {
      S.正式图资源.status = "stale";
      S.正式图资源.invalidatedAt = new Date().toISOString();
    }
    if (lastBusinessSignature && signature !== lastBusinessSignature) {
      S.检查已运行 = false;
      S.检查失效时间 = new Date().toISOString();
    }
    lastBusinessSignature = signature;
    const meta = S.项目列表 && S.项目列表.find(p => p.id === currentId);
    if (meta) {
      const step = ProjectData.steps().find(x => x.视图 === S.当前视图);
      meta.当前步骤 = step ? step.id : S.当前步骤;
      meta.待办 = S.存疑.filter(q => !q.已解决).length + S.检查问题.filter(q => q.处理 === "pending").length;
      meta.状态 = S.步骤状态.delivery === "done" ? "已交付"
        : S.实测.some(x => x.状态 === "measured") ? "进行中" : "资料待补";
    }
    save();
    subs.forEach(f => { try { f(S); } catch (e) { console.error(e); } });
    viewSubs.forEach(f => { try { f(S); } catch (e) { console.error(e); } });
  }

  function businessSignature(state) {
    if (!state) return "";
    return JSON.stringify({
      任务卡: state.任务卡, 实测: state.实测, 构件: state.构件,
      现状: state.现状, 图纸样式: state.图纸样式
    });
  }

  // ===== 消息 =====
  function say(who, text, extra) {
    const last = S.消息[S.消息.length - 1];
    if (!extra && last && last.who === who && last.text === text && Date.now() - last.t < 3000) {
      return last;
    }
    S.消息.push(Object.assign({ who, text, t: Date.now() }, extra || {}));
    emit();
    return S.消息[S.消息.length - 1];
  }
  function updateLast(patch) {
    const m = S.消息[S.消息.length - 1];
    if (m) Object.assign(m, patch);
    emit();
  }

  // ===== 状态条 =====
  function status(标题, 说明, 类型) {
    S.状态条 = { 标题, 说明: 说明 || "", 类型: 类型 || "idle" };
    emit();
  }

  // ===== 步骤 =====
  function stepIndex(id) { return DATA.步骤.findIndex(s => s.id === id); }
  function setStep(id, st) {
    S.步骤状态[id] = st;
    if (st === "done") {
      const i = stepIndex(id);
      if (i + 1 > S.解锁到) S.解锁到 = i + 1;
    }
    emit();
  }
  function goto(viewId) {
    if (S.当前视图 !== viewId) S.引用 = null;   // 框选的位置只在当前视图有效，切走就作废
    S.当前视图 = viewId;
    emit();
  }

  // ===== 构件操作 =====
  function findPart(no) { return S.构件.find(p => p.编号 === no); }
  function nextPartNo() {
    const nums = S.构件.map(p => parseInt(p.编号.replace(/\D/g, ""), 10)).filter(n => !isNaN(n));
    return "P" + String((nums.length ? Math.max.apply(null, nums) : 0) + 1).padStart(2, "0");
  }
  function addPart(p, 原因) {
    const 编号 = p.编号 || nextPartNo();
    const np = Object.assign({ 编号, 置信: "中", 状态: "human", 尺寸: "", 依据: "" }, p, { 编号 });
    S.构件.push(np);
    log("新增构件", 编号, 原因 || "人工补充", { before: null, after: copy(np) });
    emit();
    return np;
  }
  function editPart(no, patch, 原因) {
    const p = findPart(no);
    if (!p) return null;
    const before = copy(p);
    const 原来是AI = p.状态 === "ai" || p.状态 === "demo";
    Object.assign(p, patch);
    p.状态 = patch.状态 || "human";
    log("修改构件", no, 原因 || "人工修正", { before, after: copy(p) });
    // AI 给的结果被人改了，记一笔，用于算直接采用率
    if (原来是AI && window.Metrics && !/采纳 AI 建议/.test(原因 || "")) Metrics.adopt(no, "修改");
    emit();
    return p;
  }
  function removePart(no, 原因) {
    const i = S.构件.findIndex(p => p.编号 === no);
    if (i < 0) return;
    const p = S.构件[i];
    S.构件.splice(i, 1);
    // 界面上说"记入排除记录"，这里就要真的记，识别时会回传给模型
    S.排除记录.push({ 编号: no, 名称: p.名称, 类别: p.类别,
      原因: 原因 || "人工判定不存在",
      时间: new Date().toLocaleString("zh-CN", { hour12: false }) });
    log("删除构件", no, 原因 || "人工判定不存在", { before: copy(p), after: null });
    if ((p.状态 === "ai" || p.状态 === "demo") && window.Metrics) Metrics.adopt(no, "删除");
    if (S.选中构件 === no) S.选中构件 = null;
    emit();
  }
  function selectPart(no) { S.选中构件 = no; emit(); }

  // ===== 存疑处理 =====
  function resolveQuestion(id, 结论, 理由, 人) {
    const q = S.存疑.find(x => x.id === id);
    if (!q) return;
    const before = copy(q);
    q.结论 = 结论; q.理由 = 理由; q.处理人 = 人 || "李工"; q.已解决 = true;
    if (q.构件) {
      const p = findPart(q.构件);
      if (p) { p.状态 = "human"; p.置信 = "高"; p.人工结论 = 结论; }
    }
    log("处理存疑", q.构件 || q.id, q.标题 + " 判定为：" + 结论 + "；理由：" + 理由,
      { before, after: copy(q) });
    emit();
  }
  function toLibrary(item) {
    S.构件库.push(Object.assign({ 时间: new Date().toISOString().slice(0, 10) }, item));
    emit();
  }

  // ===== 修改记录 =====
  function log(动作, 对象, 说明, change) {
    S.修改记录.push(Object.assign({
      动作, 对象, 说明,
      人: "李工",
      时间: new Date().toLocaleString("zh-CN", { hour12: false })
    }, change || {}));
  }

  // ===== 引用（框选） =====
  function setRef(ref) { S.引用 = ref; emit(); }
  function clearRef() { S.引用 = null; emit(); }

  return {
    init, switchProject, importProject, exportCurrent, downloadCurrent,
    activeProjectId: () => currentId,
    get, sub, subView, clearViewSubs, emit, reset, save,
    say, updateLast, status,
    setStep, goto, stepIndex,
    findPart, addPart, editPart, removePart, selectPart, nextPartNo,
    resolveQuestion, toLibrary, log,
    setRef, clearRef
  };
})();
