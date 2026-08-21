/* 项目数据仓库。
   业务数据来自独立 JSON；这里只负责加载、校验、导入、导出和激活。 */
window.ProjectData = (function () {
  const INDEX_URL = "data/projects/index.json";
  const IMPORTS_KEY = "gujian-wt-imported-projects";
  const ACTIVE_KEY = "gujian-wt-active-project";
  const SCHEMA_VERSION = "1.0";
  const MAX_IMPORT_BYTES = 2 * 1024 * 1024;
  const ALLOWED_SOURCES = new Set(["demo", "ai", "program", "measured", "human", "unknown", "missing"]);
  const STEPS = [
    { id: "task", 名: "确认任务要求", 模块: "G1", 视图: "task" },
    { id: "materials", 名: "核对项目资料", 模块: "G2", 视图: "materials" },
    { id: "datum", 名: "确认实测尺寸", 模块: "G4", 视图: "datum" },
    { id: "parts", 名: "核对建筑构件", 模块: "G3", 视图: "parts" },
    { id: "condition", 名: "记录现状", 模块: "G4", 视图: "condition" },
    { id: "style", 名: "设置出图方式", 模块: "G5", 视图: "style" },
    { id: "drawing", 名: "生成并检查图纸", 模块: "G5G6", 视图: "drawing" },
    { id: "delivery", 名: "交付归档", 模块: "G7", 视图: "delivery" }
  ];

  let index = null;
  let imports = {};
  const cache = new Map();
  let activeId = null;
  let preferredId = null;

  function copy(value) { return JSON.parse(JSON.stringify(value)); }

  function readImports() {
    try {
      const parsed = JSON.parse(localStorage.getItem(IMPORTS_KEY) || "{}");
      imports = parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : {};
    } catch (e) { imports = {}; }
  }

  function saveImports() {
    try {
      localStorage.setItem(IMPORTS_KEY, JSON.stringify(imports));
    } catch (e) {
      throw new Error("浏览器空间不足，导入项目没有保存。请先导出现有项目并清理浏览器存储。");
    }
  }

  function requireObject(value, label, errors) {
    if (!value || typeof value !== "object" || Array.isArray(value)) errors.push(label + " 必须是对象");
  }

  function requireArray(value, label, errors) {
    if (!Array.isArray(value)) errors.push(label + " 必须是数组");
  }

  function duplicateValues(list, pick) {
    const seen = new Set();
    const duplicates = new Set();
    (list || []).forEach(item => {
      const value = pick(item);
      if (!value) return;
      if (seen.has(value)) duplicates.add(value);
      seen.add(value);
    });
    return Array.from(duplicates);
  }

  function validate(bundle) {
    const errors = [];
    if (!bundle || typeof bundle !== "object" || Array.isArray(bundle)) {
      return { ok: false, errors: ["项目数据顶层必须是对象"] };
    }
    if (bundle.schemaVersion !== SCHEMA_VERSION) {
      errors.push("schemaVersion 必须为 " + SCHEMA_VERSION);
    }
    requireObject(bundle.项目, "项目", errors);
    requireObject(bundle.资源, "资源", errors);
    requireObject(bundle.任务卡, "任务卡", errors);
    requireObject(bundle.图纸样式, "图纸样式", errors);
    requireObject(bundle.交付, "交付", errors);
    ["人员", "资料", "实测", "构件", "存疑", "现状", "检查问题"].forEach(k => requireArray(bundle[k], k, errors));
    if (bundle.尺寸关系 != null) requireArray(bundle.尺寸关系, "尺寸关系", errors);

    if (bundle.项目 && typeof bundle.项目 === "object") {
      if (!/^[a-z0-9][a-z0-9_-]{1,63}$/.test(bundle.项目.id || "")) {
        errors.push("项目.id 只能使用 2-64 位小写字母、数字、短横线或下划线");
      }
      if (typeof bundle.项目.名称 !== "string" || !bundle.项目.名称.trim()) errors.push("项目.名称 不能为空");
      if (typeof bundle.项目.成果 !== "string") errors.push("项目.成果 必须是字符串；尚未确认时可留空");
    }
    if (typeof bundle.任务书原文 !== "string") errors.push("任务书原文 必须是字符串");
    if (typeof bundle.草图转写 !== "string") errors.push("草图转写 必须是字符串");

    function inspectShape(value, path, depth) {
      if (depth > 12) return errors.push(path + " 嵌套层级超过 12");
      if (typeof value === "string" && value.length > 20000) errors.push(path + " 文本超过 20000 字符");
      if (!value || typeof value !== "object") return;
      if (Array.isArray(value)) {
        if (value.length > 5000) errors.push(path + " 数组超过 5000 项");
        return value.forEach((v, i) => inspectShape(v, path + "[" + i + "]", depth + 1));
      }
      const keys = Object.keys(value);
      if (keys.length > 200) errors.push(path + " 字段超过 200 个");
      keys.forEach(k => {
        if (["__proto__", "prototype", "constructor"].includes(k)) errors.push(path + " 包含不允许的字段 " + k);
        inspectShape(value[k], path + "." + k, depth + 1);
      });
    }
    inspectShape(bundle, "项目数据", 0);

    const safeId = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/;
    [
      [bundle.资料, "资料.id", x => x && x.id],
      [bundle.实测, "实测.id", x => x && x.id],
      [bundle.构件, "构件.编号", x => x && x.编号],
      [bundle.存疑, "存疑.id", x => x && x.id]
    ].forEach(([items, label, pick]) => (items || []).forEach((item, i) => {
      if (!safeId.test(String(pick(item) || ""))) errors.push(label + " 第 " + (i + 1) + " 项格式无效");
    }));

    const materialDup = duplicateValues(bundle.资料, x => x && x.id);
    const partDup = duplicateValues(bundle.构件, x => x && x.编号);
    if (materialDup.length) errors.push("资料.id 重复：" + materialDup.join("、"));
    if (partDup.length) errors.push("构件.编号 重复：" + partDup.join("、"));

    (bundle.资料 || []).forEach((item, i) => {
      if (!item || typeof item !== "object" || Array.isArray(item)) return errors.push("资料 第 " + (i + 1) + " 项必须是对象");
      ["类型", "文件", "名称", "用途", "说明", "来源", "状态"].forEach(k => {
        if (typeof item[k] !== "string") errors.push("资料 第 " + (i + 1) + " 项." + k + " 必须是字符串");
      });
      if (typeof item.可用 !== "boolean") errors.push("资料 第 " + (i + 1) + " 项.可用 必须是布尔值");
    });
    (bundle.实测 || []).forEach((item, i) => {
      if (!item || typeof item !== "object" || Array.isArray(item)) return errors.push("实测 第 " + (i + 1) + " 项必须是对象");
      if (typeof item.部位 !== "string" || typeof item.单位 !== "string" || typeof item.状态 !== "string") {
        errors.push("实测 第 " + (i + 1) + " 项缺少部位、单位或状态");
      }
      if (!Number.isFinite(Number(item.数值))) errors.push("实测 第 " + (i + 1) + " 项.数值 必须是有限数字");
    });
    (bundle.构件 || []).forEach((item, i) => {
      if (!item || typeof item !== "object" || Array.isArray(item)) return errors.push("构件 第 " + (i + 1) + " 项必须是对象");
      ["名称", "类别", "置信", "状态", "尺寸", "依据"].forEach(k => {
        if (typeof item[k] !== "string") errors.push("构件 第 " + (i + 1) + " 项." + k + " 必须是字符串");
      });
      const box = item.框;
      if (!Array.isArray(box) || box.length !== 4 || box.some(n => !Number.isFinite(Number(n)) || Number(n) < 0 || Number(n) > 1) ||
          Number(box[0]) > Number(box[2]) || Number(box[1]) > Number(box[3])) {
        errors.push("构件 第 " + (i + 1) + " 项.框 必须是 [0,1] 内的有效四点范围");
      }
      if (!["高", "中", "低"].includes(item.置信)) errors.push("构件 第 " + (i + 1) + " 项.置信 无效");
    });
    Object.entries(bundle.任务卡 || {}).forEach(([key, item]) => {
      if (!item || typeof item !== "object" || Array.isArray(item) || typeof item.值 !== "string" ||
          typeof item.来源 !== "string" || typeof item.出处 !== "string") {
        errors.push("任务卡." + key + " 必须包含字符串 值、来源、出处");
      }
    });
    if (bundle.交付 && typeof bundle.交付 === "object") {
      requireArray(bundle.交付.文件, "交付.文件", errors);
      requireArray(bundle.交付.限制条件, "交付.限制条件", errors);
      requireArray(bundle.交付.确认, "交付.确认", errors);
      requireObject(bundle.交付.权限, "交付.权限", errors);
    }

    Object.entries(bundle.资源 || {}).forEach(([key, value]) => {
      const path = value && typeof value === "object" && !Array.isArray(value) ? value.path : value;
      if (typeof path !== "string") return errors.push("资源." + key + " 必须是路径或资源对象");
      if (!/^assets\/[A-Za-z0-9_.-]+$/.test(path)) {
        errors.push("资源." + key + " 只能使用 assets/ 下的安全文件名");
      }
      if (value && typeof value === "object" && !Array.isArray(value)) {
        if (!["preview", "current", "stale"].includes(value.status)) errors.push("资源." + key + ".status 无效");
        if (typeof value.sourceProjectId !== "string") errors.push("资源." + key + ".sourceProjectId 缺失");
        if (typeof value.generationVersion !== "string") errors.push("资源." + key + ".generationVersion 缺失");
        if (typeof value.generatedAt !== "string") errors.push("资源." + key + ".generatedAt 缺失");
        if (typeof value.parametersHash !== "string") errors.push("资源." + key + ".parametersHash 缺失");
      }
    });

    (bundle.资料 || []).forEach((item, i) => {
      if (item && item.类型 === "照片" && item.文件 && !/^[A-Za-z0-9_.-]+$/.test(item.文件)) {
        errors.push("资料 第 " + (i + 1) + " 项照片文件名无效");
      }
    });

    const sourceErrors = [];
    function inspectSources(value, path) {
      if (!value || typeof value !== "object") return;
      if (!Array.isArray(value) && Object.prototype.hasOwnProperty.call(value, "状态") &&
          typeof value.状态 === "string" && !ALLOWED_SOURCES.has(value.状态) &&
          !["idle", "running", "stop", "done", "stale", "blocked", "resolved", "pending", "auto"].includes(value.状态)) {
        sourceErrors.push(path + ".状态=" + value.状态);
      }
      if (!Array.isArray(value) && Object.prototype.hasOwnProperty.call(value, "值") &&
          Object.prototype.hasOwnProperty.call(value, "来源") && !ALLOWED_SOURCES.has(value.来源)) {
        sourceErrors.push(path + ".来源=" + value.来源);
      }
      Object.entries(value).forEach(([k, v]) => inspectSources(v, path + "." + k));
    }
    ["任务卡", "资料", "实测", "构件", "现状"].forEach(k => inspectSources(bundle[k], k));
    if (sourceErrors.length) errors.push("存在未知来源状态：" + sourceErrors.slice(0, 5).join("、"));
    return { ok: errors.length === 0, errors };
  }

  function assertValid(bundle) {
    const result = validate(bundle);
    if (!result.ok) throw new Error("项目数据无效：\n" + result.errors.join("\n"));
    return bundle;
  }

  function summary(bundle, extra) {
    const t = bundle.任务卡 || {};
    return Object.assign({
      id: bundle.项目.id,
      name: bundle.项目.名称,
      名称: bundle.项目.名称,
      地点: bundle.项目.地点 || "",
      成果: bundle.项目.成果,
      比例: (t.比例 && t.比例.值) || "未确定",
      状态: bundle.实测.some(x => x.状态 === "measured") ? "进行中" : "资料待补",
      当前步骤: bundle.实测.some(x => x.状态 === "measured") ? "task" : "datum",
      待办: bundle.存疑.filter(x => !x.已解决).length,
      builtin: false
    }, extra || {});
  }

  async function fetchJson(url) {
    const response = await fetch(url, { cache: "no-store" });
    if (!response.ok) throw new Error("读取失败（" + response.status + "）：" + url);
    return response.json();
  }

  async function init() {
    index = await fetchJson(INDEX_URL);
    if (!index || index.schemaVersion !== SCHEMA_VERSION || !Array.isArray(index.projects)) {
      throw new Error("项目索引无效或版本不受支持");
    }
    readImports();
    try { preferredId = localStorage.getItem(ACTIVE_KEY); } catch (e) { preferredId = null; }
    if (!preferredId || !list().some(p => p.id === preferredId)) preferredId = index.defaultProjectId;
    await load(preferredId);
  }

  function list() {
    const builtin = (index ? index.projects : []).map(p => ({
      id: p.id,
      name: p.name,
      名称: p.name,
      地点: p.地点 || "",
      成果: p.成果 || "",
      比例: p.比例 || "未确定",
      状态: p.状态 || "进行中",
      当前步骤: p.当前步骤 || "task",
      待办: Number(p.待办 || 0),
      builtin: true
    }));
    const local = Object.values(imports).map(bundle => summary(bundle, { imported: true }));
    return builtin.concat(local);
  }

  async function load(id) {
    if (cache.has(id)) return copy(cache.get(id));
    if (imports[id]) {
      assertValid(imports[id]);
      cache.set(id, imports[id]);
      return copy(imports[id]);
    }
    const meta = (index ? index.projects : []).find(p => p.id === id);
    if (!meta) throw new Error("找不到项目：" + id);
    const bundle = assertValid(await fetchJson(meta.url));
    if (bundle.项目.id !== meta.id) throw new Error("项目索引与数据包 ID 不一致：" + meta.id);
    cache.set(id, bundle);
    return copy(bundle);
  }

  function activate(bundle) {
    assertValid(bundle);
    activeId = bundle.项目.id;
    preferredId = activeId;
    try { localStorage.setItem(ACTIVE_KEY, activeId); } catch (e) {}
    window.DATA = Object.assign(copy(bundle), { 步骤: copy(STEPS) });
    return window.DATA;
  }

  function resolveResource(value) {
    const path = value && typeof value === "object" ? value.path : value;
    return typeof path === "string" && /^assets\/[A-Za-z0-9_.-]+$/.test(path) ? path : "";
  }

  function allIds() {
    return new Set(list().map(p => p.id));
  }

  function uniqueCopyId(base) {
    const ids = allIds();
    let id = base + "-copy-" + Date.now().toString(36);
    let i = 2;
    while (ids.has(id)) id = base + "-copy-" + Date.now().toString(36) + "-" + i++;
    return id;
  }

  function normalizeImported(raw) {
    if (!raw || raw.packageType !== "gujian-project-export") return migrateLegacySources(raw);
    const original = raw.原始证据 || {};
    const current = raw.当前业务 || {};
    const audit = raw.审计 || {};
    return migrateLegacySources({
      schemaVersion: raw.schemaVersion,
      资源: copy(raw.资源 || {}),
      项目: copy(raw.项目 || {}),
      任务书原文: String(original.任务书原文 || ""),
      草图转写: String(original.草图转写 || ""),
      任务卡: copy(current.任务卡 || {}),
      人员: copy(current.人员 || []),
      资料: copy(current.资料 || original.资料 || []),
      实测: copy(current.实测 || []),
      构件: copy(current.构件 || []),
      存疑: copy(current.存疑 || []),
      遮挡区域: copy(current.遮挡区域 || {}),
      现状: copy(current.现状 || []),
      图纸样式: copy(current.图纸样式 || {}),
      检查问题: copy(current.检查问题 || []),
      交付: copy(current.交付 || {}),
      修改记录: copy(audit.修改记录 || []),
      构件库: copy(audit.构件库 || []),
      排除记录: copy(audit.排除记录 || []),
      导入工作流: copy(raw.工作流 || {})
      ,尺寸关系: copy((raw.项目规则 && raw.项目规则.尺寸关系) || [])
    });
  }

  function migrateLegacySources(value) {
    if (!value || typeof value !== "object") return value;
    Object.keys(value).forEach(key => {
      if ((key === "状态" || key === "来源") && value[key] === "rule") value[key] = "program";
      else migrateLegacySources(value[key]);
    });
    return value;
  }

  async function importFile(file) {
    if (!file) throw new Error("没有选择项目 JSON 文件");
    if (file.size > MAX_IMPORT_BYTES) throw new Error("项目 JSON 不能超过 2MB");
    let bundle;
    try { bundle = normalizeImported(JSON.parse(await file.text())); }
    catch (e) { throw new Error("文件不是有效的 JSON"); }
    assertValid(bundle);
    bundle = copy(bundle);
    if (allIds().has(bundle.项目.id)) {
      const oldName = bundle.项目.名称;
      const oldId = bundle.项目.id;
      bundle.项目.id = uniqueCopyId(bundle.项目.id);
      bundle.项目.名称 = oldName + "（导入副本）";
      bundle.项目.originProjectId = oldId;
    }
    imports[bundle.项目.id] = bundle;
    saveImports();
    cache.set(bundle.项目.id, bundle);
    return { bundle: copy(bundle), meta: summary(bundle, { imported: true }) };
  }

  function buildExport(state) {
    const resources = copy(DATA.资源 || {});
    if (state.正式图资源) resources.正式图 = copy(state.正式图资源);
    const bundle = {
      packageType: "gujian-project-export",
      schemaVersion: SCHEMA_VERSION,
      exportedAt: new Date().toISOString(),
      项目: copy(DATA.项目),
      资源: resources,
      项目规则: { 尺寸关系: copy(DATA.尺寸关系 || []) },
      原始证据: {
        任务书原文: DATA.任务书原文 || "",
        草图转写: DATA.草图转写 || "",
        资料: copy(DATA.资料 || [])
      },
      当前业务: {
        任务卡: copy(state.任务卡 || {}),
        人员: copy(state.人员 || []),
        资料: copy(state.资料 || []),
        实测: copy(state.实测 || []),
        构件: copy(state.构件 || []),
        存疑: copy(state.存疑 || []),
        遮挡区域: copy(DATA.遮挡区域 || {}),
        现状: copy(state.现状 || []),
        图纸样式: copy(state.图纸样式 || {}),
        检查问题: copy(state.检查问题 || []),
        交付: copy(state.交付 || {})
      },
      工作流: {
        当前步骤: state.当前步骤,
        步骤状态: copy(state.步骤状态 || {}),
        解锁到: state.解锁到,
        检查已运行: !!state.检查已运行,
        退回记录: copy(state.退回记录 || [])
      },
      审计: {
        修改记录: copy(state.修改记录 || []),
        构件库: copy(state.构件库 || []),
        排除记录: copy(state.排除记录 || [])
      },
      说明: "资源文件未嵌入 JSON；导入时只恢复结构化数据，图片仍需位于受支持的 assets/ 路径。"
    };
    assertValid(normalizeImported(bundle));
    return bundle;
  }

  function download(bundle) {
    assertValid(normalizeImported(bundle));
    const blob = new Blob([JSON.stringify(bundle, null, 2) + "\n"], { type: "application/json;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = bundle.项目.id + "_project.json";
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 0);
  }

  return {
    init, list, load, activate, validate, resolveResource, importFile, buildExport, download,
    defaultId: () => preferredId || (index && index.defaultProjectId),
    activeId: () => activeId,
    steps: () => copy(STEPS)
  };
})();
