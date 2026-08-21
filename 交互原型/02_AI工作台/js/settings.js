/* 日常用户只选择使用示例资料还是在线处理。模型路由属于维护与选型记录。 */
window.Settings = (function () {
  function open() {
    const modal = document.getElementById("modal");
    const body = document.getElementById("modalBody");
    const status = API.getStatus();
    const limits = status.limits;
    const statusText = status.configured
      ? "在线服务已连接。访问密钥只保存在服务器，任务由系统自动选择模型。"
      : "在线服务尚未连接。请由维护人员在服务器配置模型服务。";
    const limitText = limits
      ? "使用上限：每分钟 " + limits.perMinute + " 次，每位访客每日 " + limits.perDay +
        " 次；单个文件不超过 " + limits.maxRequestMB + "MB。"
      : "";

    body.innerHTML =
      '<div class="note"><b>在线服务</b><br>' + UI.esc(statusText) +
      (limitText ? "<br>" + UI.esc(limitText) : "") + "</div>" +
      "<label>资料处理方式</label>" +
      '<div style="margin-bottom:12px">' +
      '<label style="font-weight:400"><input type="radio" name="src" value="local"' +
      (!Store.get().真实调用 ? " checked" : "") + "> 使用已核对的示例结果（默认）</label>" +
      '<label style="font-weight:400"><input type="radio" name="src" value="live"' +
      (Store.get().真实调用 ? " checked" : "") + "> 在线处理新上传资料</label>" +
      '<div class="hint">在线结果仍需专业人员核对名称、位置和实测依据。</div></div>' +
      routingHTML(status) + metricsHTML(status) + baselineHTML(status) +
      '<div class="btn-row"><button class="btn" id="fSave">保存</button>' +
      '<button class="btn-line" id="fTest">测试连接</button>' +
      '<button class="btn-ghost" id="fClearM">清空使用记录</button>' +
      '<span class="hint" id="fMsg"></span></div>';

    modal.classList.remove("hidden");
    document.getElementById("modalTitle").textContent = "服务与数据";

    document.getElementById("fSave").onclick = () => {
      Store.get().真实调用 = document.querySelector('input[name="src"]:checked').value === "live";
      Store.emit();
      document.getElementById("fMsg").textContent = "已保存";
      setTimeout(close, 600);
    };

    document.getElementById("fClearM").onclick = async () => {
      const ok = await UI.askConfirm({
        title: "清空使用记录",
        desc: "模型调用、采用情况和人工基线会清零，项目资料不会改变。",
        okLabel: "确认清空"
      });
      if (!ok) return;
      Metrics.reset();
      open();
    };

    document.getElementById("fTest").onclick = async () => {
      const message = document.getElementById("fMsg");
      message.textContent = "正在检查连接…";
      try {
        await API.init();
        if (!API.isReady()) throw new Error("在线服务尚未连接");
        const result = await API.health();
        message.textContent = "连接正常，服务返回：" + (result.text || "可用");
      } catch (error) {
        message.textContent = "失败：" + String(error.message || error).slice(0, 80);
      }
    };

    const baselineButton = document.getElementById("fBaselineSave");
    if (baselineButton) baselineButton.onclick = () => {
      const taskId = document.getElementById("fBaselineTask").value;
      const kind = document.getElementById("fHumanKind").value;
      const minutes = Number(document.getElementById("fBaselineMinutes").value);
      if (!Metrics.humanTime(taskId, kind, minutes * 60)) {
        document.getElementById("fMsg").textContent = "请输入大于 0 的实测分钟数";
        return;
      }
      open();
    };
  }

  function routingHTML(status) {
    const tasks = (status.tasks || []).filter(task => task.id !== "service.health");
    if (!tasks.length) return "";
    const groups = {};
    tasks.forEach(task => {
      const key = task.group || "未分类";
      groups[key] = groups[key] || { tasks: [], routes: new Set(), priced: true };
      groups[key].tasks.push(task.label);
      groups[key].routes.add((task.provider || "未配置") + " / " + (task.modelLabel || task.model || "未配置"));
      groups[key].priced = groups[key].priced && task.pricingConfigured;
    });
    const rows = Object.keys(groups).map(group => {
      const item = groups[group];
      return "<tr><td>" + UI.esc(group) + "</td><td>" + UI.esc(item.tasks.join("、")) +
        "</td><td>" + UI.esc([...item.routes].join("；")) + "</td><td>" +
        (item.priced ? "已配置" : "待配置") + "</td></tr>";
    });
    return '<details class="card" style="margin-bottom:14px"><summary class="card-title">内部模型路由</summary>' +
      '<div class="hint" style="margin:8px 0">任务由服务端选择模型，普通用户不能改写。此表用于维护和选型核对。</div>' +
      UI.table(["任务类型", "业务步骤", "当前路由", "价格"], rows) + "</details>";
  }

  function metricsHTML() {
    const metrics = Metrics.summary();
    if (!metrics.调用数 && !metrics.处理总数) {
      return '<div class="card" style="margin-bottom:14px"><div class="card-title">任务度量</div>' +
        '<div class="hint">还没有在线处理记录。运行后将按任务和模型记录耗时、输入输出、重试、采用和费用。</div></div>';
    }
    const rows = Object.keys(metrics.按任务模型).map(key => {
      const group = metrics.按任务模型[key];
      const fees = Object.keys(group.费用).map(currency => group.费用[currency].toFixed(4) + " " + currency).join("；");
      const cost = group.已计价 === group.次数 ? (fees || "0") : (fees ? fees + "；部分待配置" : "待配置");
      return "<tr><td>" + UI.esc(group.步骤) + "</td><td>" + UI.esc(group.模型) + "</td><td>" +
        group.次数 + "</td><td>" + group.秒 + " 秒</td><td>" + group.输入 + " / " + group.输出 +
        "</td><td>" + group.重试 + "</td><td>" + cost + "</td></tr>";
    });
    const totalFees = Object.keys(metrics.费用).map(currency => metrics.费用[currency] + " " + currency).join("；");
    const costText = metrics.已计价调用 === metrics.调用数
      ? (totalFees || "0")
      : "已有 " + metrics.已计价调用 + "/" + metrics.调用数 + " 次完成计价；其余待配置官方价格";
    return '<div class="card" style="margin-bottom:14px"><div class="card-title">任务度量</div>' +
      '<dl class="kv"><dt>调用</dt><dd>' + metrics.调用数 + " 次，累计 " + metrics.总秒 +
      " 秒，平均 " + metrics.平均秒 + " 秒，重试 " + metrics.重试数 + " 次</dd>" +
      "<dt>输入与输出</dt><dd>输入 " + metrics.输入token + "，输出 " + metrics.输出token +
      "，缓存命中 " + metrics.缓存token + "</dd>" +
      "<dt>费用</dt><dd>" + UI.esc(costText) + "</dd>" +
      "<dt>结果处理</dt><dd>直接采用 " + metrics.采用 + "，人工改过 " + metrics.修改 +
      "，删除 " + metrics.删除 + "，忽略 " + metrics.忽略 +
      (metrics.处理总数 ? "；直接采用率 " + metrics.直接采用率 + "%" : "") + "</dd>" +
      "<dt>未完成</dt><dd>失败 " + metrics.失败数 + " 次，改用示例 " + metrics.降级数 + " 次</dd></dl>" +
      (rows.length ? '<div style="margin-top:10px">' +
        UI.table(["步骤", "模型", "次数", "耗时", "输入 / 输出", "重试", "费用"], rows) + "</div>" : "") +
      '<div class="hint" style="margin-top:8px">费用只采用带来源和生效日期的服务端价格。模型是否值得使用，还要结合人工修改量和质量检查。</div></div>';
  }

  function baselineHTML(status) {
    const tasks = (status.tasks || []).filter(task => !["service.health", "intent.route", "assistant.answer"].includes(task.id));
    if (!tasks.length) return "";
    const summary = Metrics.summary();
    const values = summary.人工耗时;
    const review = summary.核对耗时;
    const options = tasks.map(task => '<option value="' + UI.esc(task.id) + '">' + UI.esc(task.label) + "</option>").join("");
    const ids = [...new Set(Object.keys(values).concat(Object.keys(review)))];
    const recorded = ids.length
      ? ids.map(id => {
        const task = tasks.find(item => item.id === id);
        const parts = [];
        if (values[id]) parts.push("人工 " + Math.round(values[id] / 6) / 10 + " 分钟");
        if (review[id]) parts.push("AI 后核对 " + Math.round(review[id] / 6) / 10 + " 分钟");
        return (task ? task.label : id) + "：" + parts.join("，");
      }).join("；")
      : "尚未记录";
    return '<div class="card" style="margin-bottom:14px"><div class="card-title">人工用时</div>' +
      '<div class="hint" style="margin-bottom:8px">用同一份资料分别记录人工独立完成和 AI 后核对修改的时间，不能用估计值。</div>' +
      '<div class="btn-row"><select id="fHumanKind"><option value="baseline">人工独立完成</option><option value="review">AI 后核对修改</option></select>' +
      '<select id="fBaselineTask">' + options + '</select>' +
      '<input id="fBaselineMinutes" type="number" min="0.1" step="0.1" placeholder="实测分钟数">' +
      '<button class="btn-line" id="fBaselineSave">记录</button></div>' +
      '<div class="hint">已记录：' + UI.esc(recorded) + "</div></div>";
  }

  function close() { document.getElementById("modal").classList.add("hidden"); }
  return { open, close };
})();
