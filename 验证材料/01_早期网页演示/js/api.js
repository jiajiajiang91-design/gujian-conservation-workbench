// 真实识别：浏览器直接调 Claude API（多模态）。API key 由用户在设置里填入，只存本机 localStorage。
window.API = (function () {
  const KEY = "gujian-demo-apikey";

  function getKey() { return localStorage.getItem(KEY) || ""; }
  function setKey(k) { k ? localStorage.setItem(KEY, k.trim()) : localStorage.removeItem(KEY); }

  // 识别提示词：要求返回与 demo 部件表同构的 JSON（口径与 poc 盲测一致）
  function buildPrompt(unit) {
    const dims = unit.实测尺寸.map(d => `${d.部位}/${d.名称}: ${d.数值}mm（${d.测量方式}）`).join("；") || "无实测尺寸";
    return `你是古建筑测绘工程师。识别照片中这座中国古建筑（${unit.年代}代，${unit.结构类型}，登记屋顶形式：${unit.屋顶形式}）正立面的可见部件。
已有实测尺寸：${dims}。无实测的尺寸按照片比例估算并在数值后加（估）。
只输出 JSON，不要其他文字，结构：
{"部件":[{"编号":"P01","名称":"","类别":"台基|柱|枋|铺作|屋面|屋面瓦饰|门窗|木装修|墙体|内部|环境陈设 之一","置信度":"高|中|低","尺寸":"","识别依据":""}],"核心尺寸":[{"名称":"","数值":""}],"形制说明":""}
识别不确定的部件置信度标中或低并在识别依据里说明原因。环境陈设类标注不入立面主体。`;
  }

  // photos: [{dataUrl, 打标}]。返回 {部件, 核心尺寸, 形制说明}
  async function recognize(unit, onStep) {
    const key = getKey();
    if (!key) throw new Error("NO_KEY");
    const imgs = unit.照片.filter(p => p.dataUrl);
    if (!imgs.length) throw new Error("NO_REAL_PHOTO");

    onStep && onStep("组装请求（" + imgs.length + " 张照片）");
    const content = [];
    imgs.slice(0, 4).forEach(p => {
      const m = p.dataUrl.match(/^data:(image\/\w+);base64,(.+)$/);
      if (!m) return;
      content.push({ type: "text", text: "照片打标：" + p.打标 });
      content.push({ type: "image", source: { type: "base64", media_type: m[1], data: m[2] } });
    });
    content.push({ type: "text", text: buildPrompt(unit) });

    onStep && onStep("调用模型识别中（约 30 到 60 秒）");
    const resp = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-api-key": key,
        "anthropic-version": "2023-06-01",
        "anthropic-dangerous-direct-browser-access": "true"
      },
      body: JSON.stringify({
        model: "claude-sonnet-5",
        max_tokens: 4000,
        messages: [{ role: "user", content }]
      })
    });
    if (!resp.ok) {
      const t = await resp.text();
      throw new Error("API " + resp.status + ": " + t.slice(0, 300));
    }
    const data = await resp.json();
    const text = (data.content || []).filter(c => c.type === "text").map(c => c.text).join("");
    onStep && onStep("解析识别结果");
    const jsonStr = text.replace(/^```json?\s*/i, "").replace(/```\s*$/, "").trim();
    const parsed = JSON.parse(jsonStr);
    if (!Array.isArray(parsed.部件) || !parsed.部件.length) throw new Error("EMPTY_RESULT");
    parsed.部件.forEach((p, i) => {
      p.编号 = p.编号 || "P" + String(i + 1).padStart(2, "0");
      p.来源 = "AI识别";
      if (p.识别依据) p.提示 = p.识别依据;
    });
    return parsed;
  }

  // 本地图片读入并压缩到长边 1280，存 dataURL（控制 localStorage 体积）
  function readImage(file) {
    return new Promise((resolve, reject) => {
      const fr = new FileReader();
      fr.onerror = reject;
      fr.onload = () => {
        const img = new Image();
        img.onerror = reject;
        img.onload = () => {
          const max = 1280, sc = Math.min(1, max / Math.max(img.width, img.height));
          const cv = document.createElement("canvas");
          cv.width = Math.round(img.width * sc); cv.height = Math.round(img.height * sc);
          cv.getContext("2d").drawImage(img, 0, 0, cv.width, cv.height);
          resolve(cv.toDataURL("image/jpeg", 0.82));
        };
        img.src = fr.result;
      };
      fr.readAsDataURL(file);
    });
  }

  return { getKey, setKey, recognize, readImage };
})();
