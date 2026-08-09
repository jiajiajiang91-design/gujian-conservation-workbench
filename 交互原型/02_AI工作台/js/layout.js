/* 工作区布局偏好：只控制资料区与 AI 助手的显示方式，不改变业务数据。 */
window.LayoutPrefs = (function () {
  const KEY = "gujian-layout-prefs";
  const defaults = { evidence: "right", assistant: true };
  let state = load();

  function load() {
    try {
      const saved = JSON.parse(localStorage.getItem(KEY) || "null");
      return Object.assign({}, defaults, saved || {});
    } catch (_) {
      return Object.assign({}, defaults);
    }
  }

  function save() {
    try { localStorage.setItem(KEY, JSON.stringify(state)); } catch (_) { }
  }

  function apply() {
    const app = document.getElementById("app");
    const work = document.getElementById("work");
    if (app) app.classList.toggle("assistant-collapsed", !state.assistant);
    if (work) {
      work.classList.remove("evidence-right", "evidence-bottom", "evidence-hidden");
      work.classList.add("evidence-" + state.evidence);
    }
  }

  function setEvidence(value) {
    if (!["right", "bottom", "hidden"].includes(value)) return;
    state.evidence = value;
    save();
    apply();
    renderControls();
  }

  function toggleAssistant() {
    state.assistant = !state.assistant;
    save();
    apply();
    renderControls();
  }

  function renderControls() {
    const box = document.getElementById("layoutTools");
    if (!box) return;
    box.innerHTML =
      '<span class="layout-label">资料区</span>' +
      '<button class="layout-btn' + (state.evidence === "right" ? " active" : "") +
        '" data-evi="right" aria-label="资料区左右排列" title="资料区放在右侧">左右</button>' +
      '<button class="layout-btn' + (state.evidence === "bottom" ? " active" : "") +
        '" data-evi="bottom" aria-label="资料区上下排列" title="资料区放在下方">上下</button>' +
      '<button class="layout-btn' + (state.evidence === "hidden" ? " active" : "") +
        '" data-evi="hidden" aria-label="关闭资料区" title="关闭资料区">关闭</button>' +
      '<button class="layout-btn assistant-layout-btn' + (!state.assistant ? " active" : "") +
        '" id="layoutAssistant" aria-expanded="' + state.assistant + '" title="' +
        (state.assistant ? "收起 AI 助手" : "打开 AI 助手") + '">' +
        (state.assistant ? "AI 助手 ◀" : "AI 助手 ▶") + "</button>";

    box.querySelectorAll("button[data-evi]").forEach(btn => {
      btn.onclick = () => setEvidence(btn.dataset.evi);
      btn.setAttribute("aria-pressed", String(state.evidence === btn.dataset.evi));
    });
    box.querySelector("#layoutAssistant").onclick = toggleAssistant;
    apply();
  }

  function init() {
    apply();
    renderControls();
  }

  return { init, apply, renderControls, setEvidence, toggleAssistant };
})();
