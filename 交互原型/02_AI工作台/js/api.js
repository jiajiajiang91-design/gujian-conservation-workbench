/* 浏览器只提交任务类型和业务输入。模型选择、供应商参数与密钥均由服务端处理。 */
window.API = (function () {
  let service = { checked: false, configured: false, limits: null, tasks: [], providers: [] };
  let pendingRequests = 0;
  const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

  async function init() {
    try { localStorage.removeItem("gujian-wt-key"); } catch (e) { /* 文件预览模式可能禁用存储 */ }
    try {
      const resp = await fetch(CFG.API_STATUS, { cache: "no-store" });
      if (!resp.ok) throw new Error("STATUS_" + resp.status);
      const data = await resp.json();
      service = {
        checked: true,
        configured: Boolean(data.configured),
        architecture: data.architecture || "",
        limits: data.limits || null,
        tasks: Array.isArray(data.tasks) ? data.tasks : [],
        providers: Array.isArray(data.providers) ? data.providers : []
      };
    } catch (e) {
      service = { checked: true, configured: false, limits: null, tasks: [], providers: [] };
    }
    return service;
  }

  function isReady() { return Boolean(service.configured); }
  function getStatus() { return JSON.parse(JSON.stringify(service)); }
  function taskInfo(taskId) { return service.tasks.find(task => task.id === taskId) || null; }

  function headerMeta(resp) {
    const encodedGroup = resp.headers.get("x-ai-task-group") || "";
    let group = encodedGroup;
    try { group = decodeURIComponent(encodedGroup); } catch (e) { /* 保留原值 */ }
    return {
      taskId: resp.headers.get("x-ai-task") || "",
      taskGroup: group,
      provider: resp.headers.get("x-ai-provider") || "",
      model: resp.headers.get("x-ai-model") || ""
    };
  }

  async function postInner(taskId, body, onRetry) {
    if (!isReady()) throw new Error("AI_SERVICE_UNAVAILABLE");
    const send = () => fetch(CFG.API_PROXY, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(Object.assign({}, body, { task_id: taskId }))
    });
    const delays = [2000, 5000, 9000];
    let retries = 0;
    for (let i = 0; i <= delays.length; i++) {
      let resp;
      try { resp = await send(); }
      catch (e) {
        if (i < delays.length) {
          retries++;
          onRetry && onRetry(retries, "网络异常");
          await sleep(delays[i]);
          continue;
        }
        throw new Error("网络请求失败，请检查网络后重试");
      }
      if (resp.ok) return { resp, retries };
      const txt = await resp.text();
      const localLimit = resp.headers.get("x-rate-limit-reason");
      const notConfigured = resp.status === 503 && /AI 服务尚未配置/.test(txt);
      if ([429, 500, 502, 503, 504].includes(resp.status) && !localLimit && !notConfigured && i < delays.length) {
        retries++;
        onRetry && onRetry(retries, resp.status === 429 ? "服务繁忙" : "服务错误 " + resp.status);
        await sleep(delays[i]);
        continue;
      }
      throw new Error(friendly(resp.status, txt));
    }
    throw new Error("服务持续繁忙，请稍后重试");
  }

  async function post(taskId, body, onRetry) {
    pendingRequests++;
    try { return await postInner(taskId, body, onRetry); }
    finally { pendingRequests = Math.max(0, pendingRequests - 1); }
  }

  function hasPending() { return pendingRequests > 0; }

  function friendly(status, txt) {
    let detail = txt;
    try { detail = JSON.parse(txt).error || txt; } catch (e) { /* 上游可能返回纯文本 */ }
    if (status === 401) return "在线服务认证失败，请联系维护人员";
    if (status === 403) return "当前页面没有使用在线服务的权限";
    if (status === 413) return "上传内容超过服务端大小限制";
    if (status === 429) return detail || "本次演示的访问次数已达上限，稍后再试";
    if (status === 503 && /尚未配置/.test(detail)) return "在线服务尚未连接，请联系维护人员";
    if (status === 400 && /图片|image/i.test(txt)) return "当前任务的在线模型不能处理这份图片，请联系维护人员检查任务路由";
    return "服务返回错误 " + status + "：" + String(detail).slice(0, 160);
  }

  function cleanJson(text) {
    const value = String(text || "").trim().replace(/^```json?\s*/i, "").replace(/```\s*$/, "");
    if (!value) throw new Error("这次没有返回内容，请稍后重试");
    return JSON.parse(value);
  }

  function modelText(data) { return data.choices?.[0]?.message?.content || ""; }

  function record(step, taskId, t0, data, resp, retries) {
    if (!window.Metrics) return;
    const meta = Object.assign({}, headerMeta(resp), data.gujian_meta || {});
    Metrics.record({
      step,
      taskId,
      seconds: Math.round((Date.now() - t0) / 1000),
      usage: data.usage || meta.usage || {},
      meta,
      retries: Math.max(retries || 0, (meta.attempts || 1) - 1)
    });
  }

  async function health() {
    const { resp } = await post("service.health", {
      messages: [{ role: "user", content: "Reply with exactly: OK" }]
    });
    const data = await resp.json();
    return { text: String(modelText(data)).slice(0, 30), meta: data.gujian_meta || headerMeta(resp) };
  }

  /* 流式问答。隐藏推理过程不作为业务证据，只用信号提示正在分析。 */
  async function chat(history, onDelta, opts) {
    opts = opts || {};
    const taskId = opts.taskId || "assistant.answer";
    const t0 = Date.now();
    const { resp, retries } = await post(taskId, {
      stream: true,
      messages: [{ role: "system", content: CFG.SYSTEM }].concat(history)
    }, opts.onRetry);
    const reader = resp.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "", full = "", reasoning = "", usage = null, meta = headerMeta(resp);
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split("\n");
      buffer = lines.pop();
      for (const line of lines) {
        const raw = line.trim();
        if (!raw.startsWith("data:")) continue;
        const payload = raw.slice(5).trim();
        if (!payload || payload === "[DONE]") continue;
        try {
          const event = JSON.parse(payload);
          if (event.gujian_meta) { meta = event.gujian_meta; continue; }
          if (event.usage) usage = event.usage;
          const delta = event.choices?.[0]?.delta || {};
          const text = delta.content || "";
          const thought = delta.reasoning_content || "";
          if (thought) { reasoning += thought; onDelta && onDelta("", full, reasoning); }
          if (text) { full += text; onDelta && onDelta(text, full, reasoning); }
        } catch (e) { /* 忽略不完整分片 */ }
      }
    }
    if (opts.record !== false && window.Metrics) {
      Metrics.record({
        step: opts.step || "自由问答",
        taskId,
        seconds: Math.round((Date.now() - t0) / 1000),
        usage: usage || meta.usage || {},
        meta,
        retries: Math.max(retries, (meta.attempts || 1) - 1)
      });
    }
    if (!full.trim()) full = "这次没有返回完整内容，请稍后重试。";
    return { text: full, think: reasoning };
  }

  async function recognize(dataUrl, context, opts) {
    opts = opts || {};
    const taskId = "component.recognize";
    const t0 = Date.now();
    const { resp, retries } = await post(taskId, {
      messages: [{ role: "user", content: [
        { type: "image_url", image_url: { url: dataUrl } },
        { type: "text", text: CFG.visionPrompt(context) }
      ]}]
    }, opts.onRetry);
    const data = await resp.json();
    record(opts.step || "构件识别", taskId, t0, data, resp, retries);
    return { parsed: cleanJson(modelText(data)), usage: data.usage, meta: data.gujian_meta };
  }

  async function proposeEdits(context, instruction, onRetry) {
    const taskId = "edits.propose";
    const t0 = Date.now();
    const { resp, retries } = await post(taskId, {
      messages: [
        { role: "user", content: context },
        { role: "assistant", content: "收到，我已经读到工作区当前的完整数据。" },
        { role: "user", content: CFG.editPrompt(instruction) }
      ]
    }, onRetry);
    const data = await resp.json();
    record("修改建议", taskId, t0, data, resp, retries);
    return cleanJson(modelText(data));
  }

  async function visionTask(dataUrl, prompt, opts) {
    opts = opts || {};
    if (!opts.taskId) throw new Error("视觉任务缺少 taskId");
    const t0 = Date.now();
    const { resp, retries } = await post(opts.taskId, {
      max_tokens: opts.maxTokens,
      messages: [{ role: "user", content: [
        { type: "image_url", image_url: { url: dataUrl } },
        { type: "text", text: prompt }
      ]}]
    }, opts.onRetry);
    const data = await resp.json();
    record(opts.step || "视觉任务", opts.taskId, t0, data, resp, retries);
    return cleanJson(modelText(data));
  }

  async function jsonTask(prompt, opts) {
    opts = opts || {};
    if (!opts.taskId) throw new Error("结构化任务缺少 taskId");
    const t0 = Date.now();
    const { resp, retries } = await post(opts.taskId, {
      max_tokens: opts.maxTokens,
      messages: [{ role: "user", content: prompt }]
    }, opts.onRetry);
    const data = await resp.json();
    record(opts.step || "未命名", opts.taskId, t0, data, resp, retries);
    return cleanJson(modelText(data));
  }

  async function dispatch(systemDescription, userText, tools) {
    const taskId = "intent.route";
    const t0 = Date.now();
    const { resp, retries } = await post(taskId, {
      messages: [
        { role: "system", content: systemDescription },
        { role: "user", content: userText }
      ],
      tools
    });
    const data = await resp.json();
    record("意图分发", taskId, t0, data, resp, retries);
    const call = (data.choices?.[0]?.message?.tool_calls || [])[0];
    if (!call?.function) return { name: null, args: {} };
    let args = {};
    try { args = JSON.parse(call.function.arguments || "{}"); } catch (e) { /* 按无参处理 */ }
    return { name: call.function.name, args };
  }

  function readImage(file, maxEdge) {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onerror = reject;
      reader.onload = () => {
        const image = new Image();
        image.onerror = reject;
        image.onload = () => resolve(resizeImage(image, maxEdge));
        image.src = reader.result;
      };
      reader.readAsDataURL(file);
    });
  }

  function urlToDataUrl(url, maxEdge) {
    return new Promise((resolve, reject) => {
      const image = new Image();
      const sameOrigin = !/^https?:\/\//i.test(url) || url.indexOf(location.origin) === 0;
      if (!sameOrigin) image.crossOrigin = "anonymous";
      image.onerror = () => reject(new Error("图片读取失败：" + url + "。请通过本地服务或部署地址访问。"));
      image.onload = () => resolve(resizeImage(image, maxEdge));
      image.src = url;
    });
  }

  function resizeImage(image, maxEdge) {
    const limit = maxEdge || 1024;
    const scale = Math.min(1, limit / Math.max(image.width, image.height));
    const canvas = document.createElement("canvas");
    canvas.width = Math.round(image.width * scale);
    canvas.height = Math.round(image.height * scale);
    canvas.getContext("2d").drawImage(image, 0, 0, canvas.width, canvas.height);
    return canvas.toDataURL("image/jpeg", 0.82);
  }

  return {
    init, isReady, getStatus, taskInfo, hasPending, health,
    chat, recognize, proposeEdits, jsonTask, visionTask, dispatch, readImage, urlToDataUrl
  };
})();
