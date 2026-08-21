/* 编排层：决定下一步做什么、什么时候停下来问人、出错退回哪一步。
   这是本形态与传统后台差别的根本，传统后台没有这一层，由用户点下一步驱动。 */
window.Orchestrator = (function () {

  const S = () => Store.get();
  let busy = false;
  let pendingSym = null;   // 框选补录后"按同样做法补遮挡处"的待执行内容
  let pendingLib = null;   // 存疑判定后等用户确认是否入构件库的内容

  // ===== 工具 =====
  async function think(标题, 说明, ms) {
    Store.status(标题, 说明 || "", "busy");
    await UI.sleep(ms == null ? 700 : ms);
  }
  function idle(标题, 说明) { Store.status(标题 || "可以继续", 说明 || "说明下一项任务", "idle"); }
  function stopAt(标题, 说明) { Store.status(标题, 说明, "stop"); }

  /* AI 处理记录只写入真实发生的请求和流式响应事件，不展示模型隐藏思维链。 */
  function processStep(msg, label, detail, state) {
    if (!msg) return;
    if (!msg.process) msg.process = [];
    const last = msg.process[msg.process.length - 1];
    const item = {
      label: label,
      detail: detail || "",
      state: state || "running",
      time: new Date().toLocaleTimeString("zh-CN", { hour12: false })
    };
    if (last && last.label !== label && last.state === "running") last.state = "done";
    if (last && last.label === label) Object.assign(last, item);
    else msg.process.push(item);
    msg.processing = item.state === "running";
    Store.emit();
  }

  function ask(key, title, body, options, type) {
    Store.say("ai", "", { card: { key, title, body, options, type: type || "stop" } });
  }

  // ===== 主线推进 =====

  /* 第一句话必须真的送进模型。
     此前这里忽略 userText 直接走剧本，用户说上海外滩也会回答高都玉皇庙，那是假的。 */
  async function start(userText) {
    if (busy) return;
    busy = true;
    Store.setStep("task", "running");

    if (!API.isReady()) {
      Store.say("ai", "在线识别服务尚未连接，暂时不能读取这项新任务。" +
        "你可以先选择一个内置项目体验流程，页面会清楚标出哪些内容是示例。", {
        card: { key: "no-key", title: "接下来怎么走",
          options: [
            { label: "体验当前项目", sub: "使用当前选择的代理验证资料", value: "demo" },
            { label: "检查在线服务", sub: "查看当前连接状态", value: "setkey" }
          ], type: "" } });
      Metrics.fallback("立项理解", "AI 服务未配置");
      busy = false;
      return;
    }

    // 真实调用：让模型从这句话里提取任务要素
    Store.status("正在整理任务要求", "提取对象、成果和时间要求", "busy");
    const 占位 = Store.say("ai", "", { process: [], processing: true });
    processStep(占位, "正在提交任务说明", "AI 将读取对象、成果和时间要求", "running");
    let 理解 = null;
    try {
      const 项目表 = S().项目列表.map(p =>
        "- id=" + p.id + "：" + p.名称 + "（" + p.地点 + "，" + p.成果 + "）").join("\n");
      理解 = await API.jsonTask(CFG.intakePrompt(userText, 项目表), {
        step: "立项理解",
        taskId: "intake.extract",
        onRetry: (n, why) => processStep(占位, "正在重试请求", why + "，第 " + n + " 次", "running")
      });
    } catch (e) {
      占位.text = "这次没有读懂任务：" + String(e.message || e).slice(0, 140) +
        "\n\n请换一种说法，或在左下角检查在线服务。系统不会自行补猜缺少的信息。";
      processStep(占位, "处理未完成", String(e.message || e).slice(0, 80), "error");
      Metrics.fail("立项理解", e.message || e);
      Store.emit(); idle(); busy = false; return;
    }

    // 模型说的话直接给用户，不再由我编
    占位.text = 理解.对用户说的话 || "我理解了你的要求。";
    processStep(占位, "任务要求已返回", "已收到 AI 提取的结构化结果", "done");
    Store.emit();

    // 模型偶尔把 null 写成字符串 "null"，两种都当没匹配上
    const 匹配预判 = 理解.匹配到的已有项目;
    const 已有项目 = S().项目列表.find(p => p.id === 匹配预判);
    const 是本机项目 = !!已有项目;
    const 有数据 = 是本机项目;
    if (已有项目 && 已有项目.id !== Store.activeProjectId()) {
      await Store.switchProject(已有项目.id);
      Store.say("sys", "已切换到匹配的已有项目「" + 已有项目.名称 + "」。");
    }

    /* 新项目必须从空任务卡开始。
       否则用户建立新项目时会残留当前示例的规范和交付格式，
       两个项目的信息混在一张卡上，来源标签也救不了。 */
    if (!是本机项目) {
      const 空卡 = {};
      ["成果类型", "比例", "适用规范", "交付格式", "附带材料", "工期", "精度要求"].forEach(k => {
        空卡[k] = { 值: "待确认", 来源: "unknown", 出处: "尚未提供" };
      });
      空卡["实测基准"] = { 值: "待确认", 来源: "unknown", 出处: "尚未提供" };
      S().任务卡 = 空卡;
      // 其余业务数据也不能沿用演示项目的
      S().新项目 = { 对象: 理解.对象 || "", 地点: 理解.地点 || "" };
    }

    // 把模型提取到的要素写进任务卡，标为 AI 实时生成
    const 卡 = S().任务卡;
    const put = (k, v, 出处) => {
      if (v && String(v).trim()) 卡[k] = { 值: String(v).trim(), 来源: "ai", 出处: 出处 || "你的口述" };
    };
    put("成果类型", 理解.成果类型);
    put("比例", 理解.比例);
    put("工期", 理解.工期);
    if (理解.其他要求) put("其他要求", 理解.其他要求);

    S().立项理解 = 理解;
    Store.log("立项理解", 理解.对象 || userText.slice(0, 20), "从你的说明中整理：" +
      JSON.stringify({ 对象: 理解.对象, 成果: 理解.成果类型, 比例: 理解.比例 }));
    Store.goto("task");

    if (!有数据) {
      // 诚实告知：本机没有这个项目的资料，不能假装读过
      Store.say("ai",
        "当前没有找到「" + (理解.对象 || "这个项目") + "」的资料。\n\n" +
        "当前可直接打开的内置项目是：" + S().项目列表.map(p => p.名称).join("、") + "。" +
        "我可以先保留你刚才说的要求，或等你上传自己的项目资料。", {
        card: { key: "no-project", title: "接下来怎么走",
          options: [
            { label: "用当前项目继续演示", sub: "其余内容保持代理验证数据", value: "demo" },
            { label: "上传自己的照片和资料", sub: "把文件拖到右侧输入区", value: "upload" }
          ], type: "stop" } });
      stopAt("等你决定", "本机没有该项目资料");
      busy = false;
      return;
    }

    // 匹配上已有项目：读取该项目任务书
    await readBrief();
    busy = false;
  }

  /* AI 服务不可用时的演示路径。流程仍能走完，但结果必须标明为预置数据。 */
  async function demoIntake() {
    Store.goto("task");
    await think("正在读取演示资料", "使用当前项目的代理验证数据", 800);
    const card = S().任务卡;
    Store.say("ai", "（示例资料）当前项目是「" + DATA.项目.名称 + "」，成果为" +
      ((card.成果类型 && card.成果类型.值) || DATA.项目.成果) + "，比例" +
      ((card.比例 && card.比例.值) || "未确定") + "，适用规范为" +
      ((card.适用规范 && card.适用规范.值) || "未确定") + "。以上内容是页面预置示例，不是本次识别结果。");
    await UI.sleep(300);
    Store.setStep("task", "stop");
    stopAt("等你决定", S().实测.some(d => d.状态 === "measured") ? "请确认任务范围" : "缺少正式实测基准");
    ask("datum-missing",
      "有一件事需要你先定",
      "资料里没有实测尺寸记录。没有实测基准，尺寸只能按照片比例估算，出来的图不能作为正式测绘成果。",
      [
        { label: "我有实测记录，现在传给你", sub: "推荐。有基准才能出正式成果", value: "upload" },
        { label: "先出一版草图", sub: "全图标注为估算，不能正式交付", value: "draft" },
        { label: "暂停任务，安排补测", sub: "任务挂起", value: "pause" }
      ]);
  }

  /* 真实读任务书，不再用写死的任务卡 */
  async function readBrief() {
    Store.status("正在读任务书", "提取成果、精度、规范和交付要求", "busy");
    const 占位 = Store.say("ai", "正在读取委托任务书。");
    try {
      const r = await API.jsonTask(CFG.briefPrompt(DATA.任务书原文), {
        step: "读任务书", taskId: "brief.extract_text"
      });
      const 卡 = S().任务卡;
      ["成果类型", "比例", "适用规范", "交付格式", "附带材料"].forEach(k => {
        const v = r[k];
        if (v && v.值) 卡[k] = { 值: v.值, 来源: "ai", 出处: v.出处 || "任务书" };
      });
      if (r.精度要求 && r.精度要求.值) {
        卡["精度要求"] = { 值: r.精度要求.值, 来源: "ai", 出处: r.精度要求.出处 || "任务书" };
      }
      // 模型偶尔会把提示词里的字段说明原样抄回来，这类回声不显示给用户
      const 缺 = (r.遗漏项 || [])
        .filter(x => x && typeof x === "string" && !/必须知道的|例如|填空|字段/.test(x))
        .slice(0, 3);
      const 已填 = Object.keys(卡).filter(k => 卡[k].来源 === "ai").length;
      占位.text = "任务书读完了，" + 已填 + " 项要求已经填进任务卡，每项都标了出自第几条，可以点开原文核对。" +
        (缺.length ? "\n\n任务书里没写清楚的：" + 缺.join("；") + "。" : "");
      Store.log("读任务书", "委托任务书", "从任务书提取要求并填入任务要求");
    } catch (e) {
      占位.text = "读任务书失败：" + String(e.message || e).slice(0, 120) +
        "。任务卡里保留的是演示预置内容，已标为演示数据。";
      Metrics.fail("读任务书", e.message || e);
      Metrics.fallback("读任务书", "调用失败，回退演示数据");
    }
    Store.emit();

    await UI.sleep(400);
    Store.setStep("task", "stop");
    stopAt("等你决定", "缺少实测基准");
    ask("datum-missing",
      "有一件事需要你先定",
      "资料里没有实测尺寸记录。没有实测基准，尺寸只能按照片比例估算，这样出来的图不能作为正式测绘成果，只能标注为草图。",
      [
        { label: "我有实测记录，现在传给你", sub: "推荐。有基准才能出正式成果", value: "upload" },
        { label: "先出一版草图", sub: "全图标注为估算，不能正式交付", value: "draft" },
        { label: "暂停任务，安排补测", sub: "任务挂起", value: "pause" }
      ]);
  }

  async function afterDatum() {
    Store.setStep("task", "done");
    Store.setStep("materials", "running");
    Store.goto("materials");

    // 真实调用：让模型判断资料够不够，不再用写死的缺口说明
    Store.status("正在检查资料", "判断覆盖范围与缺口", "busy");
    const m占位 = Store.say("ai", "正在检查资料是否齐全。");
    if (API.isReady()) {
      try {
        const 清单 = S().资料.map(x =>
          "- [" + x.类型 + "] " + x.名称 + "：" + (x.说明 || "") +
          (x.可用 ? "" : "（不存在）")).join("\n");
        const 目标 = DATA.项目.成果 + "，比例 " + ((S().任务卡.比例 && S().任务卡.比例.值) || "未确定");
        const r = await API.jsonTask(CFG.materialsPrompt(清单, 目标), {
          step: "资料判断", taskId: "materials.assess"
        });
        S().资料判断 = r;
        m占位.text = (r.说明 || "") +
          (r.缺口 && r.缺口.length
            ? "\n\n缺口：" + r.缺口.map(c => c.缺什么 + "（" + c.不补的后果 + "）").join("；")
            : "");
        Store.log("资料判断", "资料清单", "资料核对结果：" + (r.够用 ? "够用" : "有缺口"));
      } catch (e) {
        m占位.text = "这次没有完成资料检查：" + String(e.message || e).slice(0, 100) + "。现已改用示例说明。";
        Metrics.fail("资料判断", e.message || e);
        Metrics.fallback("资料判断", "调用失败");
      }
    } else {
      const photos = S().资料.filter(x => x.类型 === "照片" && x.可用).length;
      const gaps = S().资料.filter(x => !x.可用 || x.状态 === "missing").length;
      m占位.text = "（示例资料）当前有 " + photos + " 张可用照片、" + gaps + " 项资料缺口。";
      Metrics.fallback("资料判断", "AI 服务未配置");
    }
    Store.emit();
    Store.setStep("materials", "done");

    Store.setStep("datum", "running");
    Store.goto("datum");

    // 真实调用：解析手写草图，不再写死"3 个数字不知道量哪里"
    Store.status("正在识别手写草图", "读取数值并匹配部位", "busy");
    const d占位 = Store.say("ai", "正在读取草图上的尺寸。");
    if (API.isReady()) {
      try {
        const r = await API.jsonTask(CFG.sketchPrompt(DATA.草图转写), {
          step: "草图解析", taskId: "sketch.extract_text"
        });
        applySketch(r);
        d占位.text = (r.说明 || "") + "\n\n" +
          "能确定部位的 " + (r.已识别 || []).length + " 项已经填进基准表。" +
          ((r.无法确定 || []).length
            ? "还有 " + r.无法确定.length + " 个数字草图上没标部位，我不替你猜，请在左边逐条指认。"
            : "");
        Store.log("草图解析", "手写草图", "从草图识别出 " + (r.已识别 || []).length + " 项");
      } catch (e) {
        d占位.text = "这次没有读出草图尺寸：" + String(e.message || e).slice(0, 100) + "。现已改用示例结果。";
        Metrics.fail("草图解析", e.message || e);
        Metrics.fallback("草图解析", "调用失败");
      }
    } else {
      d占位.text = "（示例资料）当前尺寸记录共 " + S().实测.length + " 项，其中 " +
        S().实测.filter(x => x.状态 === "unknown").length + " 项没有确定部位。";
      Metrics.fallback("草图解析", "AI 服务未配置");
    }
    Store.emit();

    // 程序核对，不是我算的
    const chk = window.DatumCheck.run(S().实测);
    if (chk.length) {
      await UI.sleep(700);
      Store.say("ai",
        "自动核对实测数据时发现一处不一致：" + chk[0].算式 + "。\n\n" +
        chk[0].说明 + "这项结果按项目声明的固定公式计算，可以重复验证。",
        { card: { key: "datum-conflict", title: "尺寸不一致，怎么处理", type: "risk",
          options: [
            { label: "先按通面阔建立基准，标注差值待复核", value: "keep" },
            { label: "暂停，等现场复核后再继续", value: "hold" }
          ] } });
    }

    Store.setStep("datum", "stop");
    stopAt("等你确认", S().实测.filter(x => x.状态 === "unknown").length +
      " 个尺寸部位不明，" + chk.length + " 处尺寸矛盾");
  }

  /* 识别上下文：把已确认判断和排除记录喂回模型，同样的错误不再重犯。
     这是"改一次以后一直记得"在识别环节的落点。 */
  function visionCtx(base) {
    const s = S();
    let c = base || "";
    if (s.构件库 && s.构件库.length) {
      c += "\n已由专业人员确认的判断，直接按结论处理，不要另行判断：" +
        s.构件库.map(x => x.构件 + " 为" + x.结论).join("；") + "。";
    }
    if (s.排除记录 && s.排除记录.length) {
      c += "\n以下内容此前被人工判定为误识别，已排除，不要再输出同类结果：" +
        s.排除记录.map(x => x.名称).join("、") + "。";
    }
    return c;
  }

  /* note 为用户提出的疑问。带疑问时即使识别数据源设为本地，也做一次真实调用，
     因为"带着疑问重看"只有模型能做。 */
  async function runRecognize(note) {
    Store.setStep("datum", "done");
    Store.setStep("parts", "running");
    Store.goto("parts");

    const 真实 = API.isReady() && (S().真实调用 || !!note);
    if (真实) {
      Store.say("ai", "正在重新识别构件，请稍候。" +
        (note ? "我会带着你的疑问重点核对：" + note : ""));
      await think("正在识别构件", "读取主图并定位构件", 300);
      try {
        const mainImage = ProjectData.resolveResource(DATA.资源.主图);
        if (!mainImage) throw new Error("当前项目没有可用主图");
        const context = DATA.项目.名称 + "，" + (DATA.项目.地点 || "地点未确定") + "。" +
          S().现状.slice(0, 5).map(x => x.部位 + "：" + x.内容).join("；");
        const url = await API.urlToDataUrl(mainImage, 1024);
        const r = await API.recognize(url, visionCtx(context +
          (note ? "。用户特别提醒：" + note + "，请重点核对相关部位并在存疑项里回应" : "")));
        const list = (r.parsed.构件 || []).map((c, i) => ({
          编号: c.编号 || ("A" + (i + 1)),
          名称: c.名称, 类别: c.类别,
          框: c.位置框 || [0.4, 0.4, 0.6, 0.6],
          置信: c.置信度 || "中", 状态: "ai",
          尺寸: "", 依据: (c.依据 || "") + "（由本次照片识别，位置框需人工核对）"
        }));
        if (list.length) {
          S().构件 = list;
          Store.say("ai", "识别出 " + list.length + " 个构件。请重点核对图上的位置框是否贴合构件边界。");
        }
      } catch (e) {
        Store.say("ai", "这次没有完成照片识别：" + String(e.message || e).slice(0, 120) + "。现已改用核对过的示例结果继续。");
      }
    } else {
      await think("正在识别构件", "读取主图，定位构件与材料", 1600);
    }

    const S0 = S();
    Store.say("ai",
      (真实 ? "" : "（示例资料）以下构件清单为页面预置并经过核对的识别结果。\n\n") +
      "识别完成，正立面共 " + S0.构件.length + " 个构件，已经按台基、柱额、铺作、屋顶分组，" +
      "每个都标了在照片上的位置、来源和当前判断。\n\n" +
      "有 " + S0.存疑.filter(q => !q.已解决).length + " 项证据不足，已经排在清单最上面，需要你判断。" +
      "系统不会按常见形制自动补齐照片中没有证据的构件。");
    Store.setStep("parts", "stop");
    stopAt("等你判断", S0.存疑.filter(q => !q.已解决).length + " 项存疑");
    Store.say("sys", "提示：在右边照片上按住拖动可以框选位置，松开后直接在下面说明问题，例如「这里漏了一个雀替」。");
  }

  async function afterParts() {
    Store.setStep("parts", "done");
    Store.setStep("condition", "running");
    Store.goto("condition");
    await think("正在整理现状记录", "空间关系与可见残损", 1100);
    const uncertain = S().现状.filter(x => x.状态 === "unknown" || x.状态 === "missing");
    Store.say("ai", "现状记录整理好了，共 " + S().现状.length + " 项；其中 " + uncertain.length +
      " 项仍待复查或缺少资料。照片外观判断不能替代现场病害调查和材料检测。");
    Store.setStep("condition", "done");

    Store.setStep("style", "running");
    Store.goto("style");
    await UI.sleep(600);
    Store.say("ai", "出图前请确认构件画法、标注方式、图签和附表。完成左侧设置后即可生成图纸。");
    Store.setStep("style", "stop");
    stopAt("等你选定", "图纸样式未确认");
    ask("style-ready", "出图设置确认好了吗", "左侧选好画法、标注、图签和附表后，就可以生成图纸。",
      [{ label: "就用默认样式，开始出图", value: "go" }, { label: "我先改一下", value: "wait" }]);
  }

  async function runDrawing() {
    Store.setStep("style", "done");
    Store.setStep("drawing", "running");
    Store.goto("drawing");
    await think("正在出图", "按构件资料和出图设置绘制", 1500);
    Store.say("ai", "图纸已按当前 " + S().构件.length +
      " 个构件的资料生成。修改资料后重新出图，图纸会同步更新。");

    await think("正在检查", "几何关系、图层、标注、规范符合性", 1300);
    // 检查结果按当前数据实时算，不是预置的
    S().检查问题 = window.CheckRules.run(S());
    S().检查已运行 = true;
    const auto = S().检查问题.filter(c => c.处理 === "auto");
    const pend = S().检查问题.filter(c => c.处理 === "pending");

    let 话 = "检查完了，共 " + S().检查问题.length + " 项。";
    if (auto.length) 话 += auto.length + " 项我已经自动处理：" +
      auto.map(c => c.标题).join("；") + "。这类问题结果唯一，可以再次验证。";
    if (pend.length) 话 += "\n\n还有 " + pend.length + " 项需要你决定，左边逐条列了，每条都写了在哪、为什么。";
    else 话 += "\n\n没有需要你决定的问题。";
    const 检占位 = Store.say("ai", 话);

    /* 检查解释：检查是程序算的，模型只负责把结果翻译成处理说明并排优先级。
       此前这一步只有模板拼接，README 却写成真实调用，言行不一。 */
    if (pend.length && API.isReady()) {
      Store.status("正在整理检查说明", "把检查结果改写成处理建议", "busy");
      try {
        const 摘要 = pend.map(c => "- " + c.id + " [" + c.类型 + "] " + c.标题 +
          "：" + c.说明 + "（位置：" + (c.位置 || "未指明") + "）").join("\n");
        const r = await API.jsonTask(CFG.checkExplainPrompt(摘要), {
          step: "检查解释", taskId: "check.explain"
        });
        const 逐条 = (r.逐条 || []).filter(x => x && x.编号 && pend.some(c => c.id === x.编号));
        if (r.总结 || 逐条.length) {
          检占位.text = 话 + "\n\n" + (r.总结 || "") +
            (r.先处理 ? "\n建议先处理：" + r.先处理 : "") +
            (逐条.length ? "\n" + 逐条.map(x => "· " + x.编号 + "　" + x.一句话).join("\n") : "");
          Store.emit();
        }
      } catch (e) {
        // 模板说明已经给出，解释失败不阻断流程
        Metrics.fail("检查解释", e.message || e);
      }
    }

    if (pend.length) {
      Store.setStep("drawing", "stop");
      stopAt("等你决定", pend.length + " 个检查问题");
    } else {
      await afterDrawing();
    }
  }

  async function afterDrawing() {
    Store.setStep("drawing", "done");
    Store.setStep("delivery", "running");
    Store.goto("delivery");

    // 真实调用：交付说明的限制条件由模型按当前数据起草，不再写死
    Store.status("正在整理交付文件", "起草限制条件说明", "busy");
    const 占位 = Store.say("ai", "正在整理交付文件并起草说明。");
    if (API.isReady()) {
      try {
        const r = await API.jsonTask(CFG.deliveryPrompt(buildContext()), {
          step: "交付说明", taskId: "delivery.draft"
        });
        if (r.限制条件 && r.限制条件.length) {
          S().交付.限制条件 = r.限制条件;
          S().交付.限制条件来源 = "ai";
        }
        占位.text = (r.说明 || "交付文件已经准备好。") +
          "\n\n共 " + S().交付.文件.length + " 个文件。根据当前资料起草了 " +
          (r.限制条件 || []).length + " 条，都指到具体部位或构件，你核对后做三级确认。";
        Store.log("交付说明", "限制条件", "根据当前资料起草 " + (r.限制条件 || []).length + " 条");
      } catch (e) {
        占位.text = "这次没有完成交付说明：" + String(e.message || e).slice(0, 100) + "。现已改用示例文本。";
        S().交付.限制条件来源 = "demo";
        Metrics.fail("交付说明", e.message || e);
        Metrics.fallback("交付说明", "调用失败");
      }
    } else {
      S().交付.限制条件来源 = "demo";
      占位.text = "（示例资料）6 个交付文件已经准备好，限制条件使用页面预置文本。";
      Metrics.fallback("交付说明", "AI 服务未配置");
    }
    Store.emit();
    Store.setStep("delivery", "stop");
    stopAt("等你签发", "三级确认未完成");
  }

  // ===== 选项回调 =====
  async function onChoice(key, value, label) {
    if (key === "datum-missing") {
      if (value === "upload") {
        Store.say("user", "上周现场量过，尺寸记在纸上拍了照，我传给你。");
        /* 先更新资料清单再做资料判断，否则模型读到的还是"实测记录缺失"，
           前一句刚说有记录，下一句又说没有，状态自相矛盾。 */
        const m7 = S().资料.find(x => x.类型 === "实测");
        if (m7) {
          m7.可用 = true;
          m7.文件 = "手写尺寸草图.jpg";
          m7.说明 = "用户补交的手写尺寸草图，转写内容见实测基准";
          m7.状态 = "human";
        }
        S().任务卡.实测基准 = { 值: "手写草图，待解析", 来源: "human", 出处: "用户补交" };
        await afterDatum();
      } else if (value === "draft") {
        S().降级 = true;
        Store.say("ai", "明白。这一版全部尺寸会标注为照片估算，图上和交付说明中都会写明不能作为正式测绘成果。" +
          "正式交付包在这种状态下是锁住的，只能导出草图。");
        await afterDatum();
      } else {
        Store.say("ai", "任务已挂起。补测完成后随时告诉我继续。");
        idle("任务挂起", "等待补测");
      }
      return;
    }
    if (key === "datum-conflict") {
      if (value === "keep") {
        const conflict = window.DatumCheck.run(S().实测)[0];
        const detail = conflict ? conflict.算式 : "按当前项目尺寸关系标注待复核";
        Store.log("处理尺寸矛盾", "尺寸关系", detail);
        Store.say("ai", "已保留当前记录，并把这处尺寸关系标为待复核：" + detail + "。正式交付前必须回到原始记录确认。");
      } else {
        Store.say("ai", "任务挂起。现场复核完这项尺寸后告诉我继续。");
        idle("任务挂起", "等待现场复核面阔");
      }
      return;
    }
    if (key === "style-ready") {
      if (value === "go") await runDrawing();
      else { Store.say("ai", "好，你改完告诉我。"); idle("等你调整样式"); }
      return;
    }
    if (key === "question") {
      // 存疑项处理在 openQuestion 里单独走
      return;
    }
  }

  // ===== 存疑项处理 =====
  function openQuestion(id) {
    const q = S().存疑.find(x => x.id === id);
    if (!q || q.已解决) return;
    Store.say("ai", q.标题 + "。" + q.问题, {
      card: {
        key: "q:" + id,
        title: "需要你判断",
        body: q.构件 ? "涉及构件 " + q.构件 + "，判断人应为" + q.需要 : "判断人应为" + q.需要,
        options: q.选项.map((o, i) => ({ label: o, value: i })),
        type: "stop"
      }
    });
    if (q.构件) Store.selectPart(q.构件);
  }

  async function resolveQ(id, idx, label) {
    const q = S().存疑.find(x => x.id === id);
    if (!q) return;

    const 判断人 = q.需要 === "专业复核人" ? "王工" : "李工";
    const 理由 = await UI.askText({
      title: "写下判断理由",
      desc: q.标题 + "　→　判定为「" + label + "」\n判断人：" + 判断人 +
            "。这条理由会进入责任记录，交付后可被接收方查到。",
      placeholder: "例如：现场对照三张不同角度照片，栱昂层次可数，确认为五踩",
      required: true,
      okLabel: "确认判定"
    });
    // 点取消就什么都不做，存疑项保持未处理
    if (理由 === null) {
      Store.say("sys", "已取消，" + q.标题 + " 仍未判定。");
      return;
    }

    Store.resolveQuestion(id, label, 理由, 判断人);
    Store.say("ai", "记下了：" + q.标题 + " 判定为「" + label + "」，判断人 " + 判断人 + "，理由已写入记录。");

    if (q.构件 && 理由.length > 2) {
      // 先问后写。此前是先写入再发问，用户选"不存"也已经存了，卡片形同虚设
      pendingLib = { 构件: q.构件, 结论: label, 理由: 理由 };
      Store.say("ai", "这条判断要不要存进项目构件库？存了以后本项目其他建筑出现同样形制我就直接按这个处理。", {
        card: { key: "lib:" + id, title: "存入构件库", options: [
          { label: "存入", value: 1 }, { label: "这次不用", value: 0 }], type: "" }
      });
    }

    const 剩 = S().存疑.filter(x => !x.已解决).length;
    if (!剩) {
      Store.say("ai", "存疑项都处理完了，我继续往下走。");
      await afterParts();
    } else {
      stopAt("等你判断", "还有 " + 剩 + " 项存疑");
    }
  }

  /* 退回处理。只重做受影响的部分，不重跑全流程。
     退回定位靠问题指向的对象：指向构件就回构件清单，指向尺寸就回实测基准。 */
  function openReturn(来源) {
    const 选项 = [
      { 标签: "某个构件认错了或漏了", 目标: "parts", 说明: "回构件清单，只改这个构件及其相邻关系，图纸局部重画" },
      { 标签: "某项尺寸不对", 目标: "datum", 说明: "回实测基准，改完重算换算尺寸，构件识别结果保留" },
      { 标签: "图纸表达不符合规范", 目标: "style", 说明: "回图纸样式，改画法或标注方式后重出图，对象数据不动" },
      { 标签: "资料不全需要补拍", 目标: "materials", 说明: "回资料清单，补采后只重跑受影响部位" }
    ];
    Store.say("ai",
      "退回处理。先说清楚是哪一类问题，我只把受影响的部分退回去重做，已经确认过的不动。",
      { card: { key: "ret:" + 来源, title: "退回原因是哪一类", type: "risk",
        options: 选项.map((o, i) => ({ label: o.标签, sub: o.说明, value: i })) } });
    stopAt("等你说明", "退回原因未确认");
  }

  async function doReturn(来源, idx) {
    const 表 = [
      { 目标: "parts", 步骤: "parts", 名: "构件清单" },
      { 目标: "datum", 步骤: "datum", 名: "实测基准" },
      { 目标: "style", 步骤: "style", 名: "图纸样式" },
      { 目标: "materials", 步骤: "materials", 名: "资料清单" }
    ];
    const t = 表[idx] || 表[0];
    const 原因 = await UI.askText({
      title: "写下退回原因",
      desc: "退回到「" + t.名 + "」。前面已确认的环节会保留，只有这一步及之后需要重做。\n" +
            "原因会进入责任记录，说明这次返工是谁提出的、为什么。",
      placeholder: "例如：P07 雀替位置偏了约 15cm，与右侧对称构件对不上",
      required: true,
      okLabel: "确认退回"
    });
    if (原因 === null) { Store.say("sys", "已取消退回，流程不变。"); idle(); return; }

    S().退回记录.push({ 来源, 目标: t.名, 原因, 人: "王工",
      时间: new Date().toLocaleString("zh-CN", { hour12: false }) });
    Store.log("退回", t.名, "从" + 来源 + "退回；原因：" + 原因);

    // 只把目标环节及其之后置为未完成，之前的保留
    const 序 = DATA.步骤.findIndex(s => s.id === t.步骤);
    DATA.步骤.forEach((s, i) => {
      if (i === 序) S().步骤状态[s.id] = "stop";
      else if (i > 序) S().步骤状态[s.id] = "idle";
    });
    S().解锁到 = Math.max(S().解锁到, 序);
    Store.goto(t.目标);
    Store.say("ai", "已退回到" + t.名 + "。" +
      "前面 " + 序 + " 个环节的结果保留，不用重做。改完这里之后，后面的环节会按新数据重新走一遍。" +
      "这次退回已记入责任记录。");
    stopAt("退回处理中", "在" + t.名 + "修改");
  }

  // ===== 意图分发 =====
  /* 助手可执行的动作清单。模型判断用户这句话对应哪个动作，
     清单之外的动作不存在，停靠点、退回和签发不在清单内，始终由状态机与人控制。
     动作定义见 13-6 第九节。 */
  const 动作清单 = [
    { type: "function", function: { name: "start_task",
      description: "用户在交代要新建或发起一个测绘任务，通常会说明对象、地点、成果类型、比例或资料位置。只是提问、查询或核对数据时不要选这个",
      parameters: { type: "object", properties: {} } } },
    { type: "function", function: { name: "goto_view",
      description: "切换中栏工作区视图。用户想看某类内容时调用",
      parameters: { type: "object", properties: {
        view: { type: "string",
          enum: ["task", "materials", "datum", "parts", "condition", "style", "drawing", "delivery"],
          description: "task任务卡 materials资料清单 datum实测基准 parts构件清单 condition现状记录 style图纸样式 drawing出图与检查 delivery交付包" }
      }, required: ["view"] } } },
    { type: "function", function: { name: "propose_edits",
      description: "用户要求修改、修正、补全、推测工作区数据（构件、实测尺寸、现状记录）时调用。系统会生成待用户逐条确认的修改卡片，不直接改数据",
      parameters: { type: "object", properties: {
        instruction: { type: "string", description: "用户的修改要求，保留原话" }
      }, required: ["instruction"] } } },
    { type: "function", function: { name: "continue_flow",
      description: "用户要求继续、往下走、推进流程时调用",
      parameters: { type: "object", properties: {} } } },
    { type: "function", function: { name: "recognize_again",
      description: "用户要求重新识别构件，或对识别结果提出疑问、要求带着疑问重看照片时调用",
      parameters: { type: "object", properties: {
        note: { type: "string", description: "用户的疑问或要求，例如某个部位可能识别错了" }
      } } } },
    { type: "function", function: { name: "answer",
      description: "用户在提问、核对数据、讨论或闲聊，需要文字回答时调用。拿不准就选这个",
      parameters: { type: "object", properties: {} } } }
  ];

  /* 返回 true 表示已处理；返回 false 时退回关键词匹配。 */
  async function modelDispatch(text) {
    const st = S().步骤状态;
    const sys = "你是古建测绘工作台的意图分发器。根据用户这句话选择一个工具调用，不要输出文字。\n" +
      "任务是否已建立：" + (st.task === "idle" ? "否" : "是") +
      "。当前视图：" + S().当前视图 +
      "。流程状态：" + DATA.步骤.map(x => x.名 + "=" + st[x.id]).join("，") +
      "。未决存疑 " + S().存疑.filter(q => !q.已解决).length + " 项。\n" +
      "任务未建立且用户在交代新任务时选 start_task；用户只是提问或查数据时选 answer，即使任务未建立。拿不准一律选 answer。";
    let r;
    try {
      r = await API.dispatch(sys, text, 动作清单);
    } catch (e) {
      Metrics.fail("意图分发", e.message || e);
      return false;
    }
    switch (r.name) {
      case "start_task":
        await start(text);
        return true;
      case "goto_view": {
        const v = Workspace.VIEWS[r.args.view] ? r.args.view : null;
        if (!v || v === "start") return false;
        Store.goto(v);
        Store.say("ai", "切到" + Workspace.VIEWS[v].名 + "了。");
        return true;
      }
      case "propose_edits":
        await proposeEdits(r.args.instruction || text);
        return true;
      case "continue_flow":
        await continueFlow();
        return true;
      case "recognize_again":
        await runRecognize(r.args.note || text);
        return true;
      case "answer":
        await freeChat(text);
        return true;
      default:
        return false;
    }
  }

  /* 推进到下一个能走的环节。停靠事项没清完就拒绝并说明，不绕过任何闸门。 */
  async function continueFlow() {
    const st = S().步骤状态;
    if (st.parts === "stop") {
      const 剩 = S().存疑.filter(q => !q.已解决).length;
      if (剩) {
        Store.say("ai", "还有 " + 剩 + " 项存疑没定。这些定不了我不能往下走，会把没依据的内容画进正式图。");
        return;
      }
      await afterParts(); return;
    }
    if (st.style === "stop") { await runDrawing(); return; }
    if (st.drawing === "stop") {
      Store.goto("drawing");
      Store.say("ai", "出图检查还有待决定的问题，左边逐条处理完就能继续。");
      return;
    }
    if (st.drawing === "done" && st.delivery !== "done") { await afterDrawing(); return; }
    if (st.task === "idle") {
      Store.say("ai", "任务还没建立。先说明要做什么项目，或者点新建测绘任务。");
      return;
    }
    Store.say("ai", "当前停在等待你处理的环节，左栏待办里列了具体事项，处理完我就继续。");
  }

  // ===== 用户说话 =====
  async function userSay(text) {
    Store.say("user", text);
    const ref = S().引用;

    /* 第一句话不再必定建任务。AI 服务可用时交给意图分发判断是交代任务还是提问，
       此前问一句"当前有多少构件"也会清空任务卡进入立项流程。 */
    const 首句未建任务 = S().消息.filter(m => m.who === "user").length === 1 &&
                        S().步骤状态.task === "idle";
    if (首句未建任务 && !API.isReady()) {
      await start(text);
      return;
    }

    // 框选修正
    if (ref) {
      await handleRefEdit(text, ref);
      return;
    }

    // 说的是修正的话，但没有先框选：提示怎么做，不要白白调一次模型
    if (/漏了|少了|不是|错了|没有构件|挡住|遮挡|这里|这个/.test(text) &&
        /雀替|替木|檐柱|金柱|额枋|平板枋|斗栱|椽|飞椽|正脊|垂脊|脊刹|吻兽|台基|踏步|板门|直棂窗|隔扇|墙体|彩画|构件/.test(text)) {
      if (S().当前视图 !== "parts") {
        Store.goto("parts");
        Store.say("ai", "我切到构件清单了。要改哪一处，先在右边照片上按住拖一个框把位置圈出来，松开后再说这句话，我才知道你指的是哪里。");
      } else {
        Store.say("ai", "先在右边照片上按住拖一个框把位置圈出来，松开后再说这句话。不然我只知道有个雀替，不知道它在哪。");
      }
      return;
    }

    /* AI 服务可用时由模型判断这句话该做什么，关键词匹配只作为分发失败的退路。
       此前这里全靠正则，换个说法就失灵，AI 听不懂用户要干什么。 */
    if (API.isReady()) {
      if (await modelDispatch(text)) return;
      // 分发调用失败时，第一句话退回原来的立项行为
      if (首句未建任务) { await start(text); return; }
    }

    // 关键词匹配：AI 服务不可用时的路径，也是意图分发失败的退路
    if (/继续|往下|接着/.test(text) && S().步骤状态.parts === "stop") {
      const 剩 = S().存疑.filter(q => !q.已解决).length;
      if (剩) { Store.say("ai", "还有 " + 剩 + " 项存疑没定。这些定不了我不能往下走，会把没依据的内容画进正式图。"); return; }
      await afterParts(); return;
    }
    if (/出图|开始画|画图/.test(text) && S().步骤状态.style === "stop") { await runDrawing(); return; }
    if (/交付|组包/.test(text) && S().步骤状态.drawing === "done") { await afterDrawing(); return; }

    // 视图跳转
    const jump = [["任务", "task"], ["资料", "materials"], ["实测|尺寸", "datum"], ["构件", "parts"],
                  ["现状", "condition"], ["样式", "style"], ["图纸|检查", "drawing"], ["交付", "delivery"]];
    for (const [re, v] of jump) {
      if (new RegExp("(看|去|打开|切到).*(" + re + ")").test(text)) {
        Store.goto(v);
        Store.say("ai", "切到" + Workspace.VIEWS[v].名 + "了。");
        return;
      }
    }

    // 让 AI 提出可一键应用的修改。祈使句才触发，疑问句仍走问答。
    const 要动手 = /(改正确|改过来|修正|按你说的改|帮我改|都改|应用修改|自动改|一键|填上|补上|补全|你来定|帮我定|帮我推测|来推测|推测.{0,6}(数值|尺寸|部位)|给出.{0,4}(数值|结果))/.test(text);
    const 是提问 = /(吗|呢|\?|？|为什么|是不是|能不能|可不可以|合理|符合)/.test(text);
    if (要动手 && !是提问) {
      await proposeEdits(text);
      return;
    }

    // 自由问答：调真实模型
    await freeChat(text);
  }

  /* AI 提议、人确认。模型只输出修改方案，改不改由用户逐条决定。 */
  async function proposeEdits(instruction) {
    if (!API.isReady()) {
      Store.say("ai", "在线识别服务尚未连接，暂时不能生成修改建议。请先在“服务与数据”中检查连接。");
      return;
    }
    Store.status("正在检查数据", "查找与实测或规则矛盾的项", "busy");
    const 占位 = Store.say("ai", "正在核对构件清单和实测记录。");
    try {
      const r = await API.proposeEdits(buildContext(), instruction, (n, why) => {
        占位.text = "正在核对构件清单和实测记录。\n（" + why + "，正在重试 " + n + "）";
        Store.status("正在检查数据", why + "，重试中", "busy");
        Store.emit();
      });
      const 丢弃 = [];
      const 有效 = [];

      (r.修改 || []).forEach(e => {
        if (!e || e.新值 == null) return;
        const v = resolveTarget(e);
        if (!v.ok) { 丢弃.push(v.why); return; }
        const 新值 = String(e.新值).split(/[|｜]/)[0].trim();
        if (String(v.原值) === 新值) return;              // 没变化的不提
        const item = { 对象: v.对象, 编号: v.编号, 名称: v.名称, 字段: v.字段,
          原值: String(v.原值), 新值, 理由: e.理由 || "", 把握: e.把握 || "中" };
        item.警告 = window.EditCheck.run(item, S());   // 程序再核一道，不看模型自称的把握
        有效.push(item);
      });

      占位.text = "";
      if (!有效.length) {
        占位.text = (r.说明 || "我没有找到有依据可以直接改的项。") +
          "\n\n需要现场复核才能确定的项我不会替你改。" +
          (丢弃.length ? "\n\n有 " + 丢弃.length + " 条建议指向不存在的构件或字段，我没有采用。" : "");
        Store.emit(); idle(); return;
      }

      const 有警告 = 有效.filter(e => e.警告 && e.警告.length).length;
      占位.text = (r.说明 || "核对完了。") + "\n\n下面 " + 有效.length +
        " 条可以逐条应用，也可以全部应用。改动都会记入修改历史。" +
        (有警告 ? "\n其中 " + 有警告 + " 条在自动核对时发现问题，已标出来，建议先看这几条。" : "") +
        (丢弃.length ? "\n另有 " + 丢弃.length + " 条指向不存在的构件或字段，已丢弃。" : "");
      占位.edits = 有效;
      Store.emit();
      stopAt("等你确认", 有效.length + " 条修改建议待确认" + (有警告 ? "，" + 有警告 + " 条有疑问" : ""));
    } catch (e) {
      占位.text = "这次没有生成修改建议：" + String(e.message || e).slice(0, 160);
      Store.emit();
      idle();
    }
  }

  /* 把模型给的一条建议解析到具体数据上，解析不了就丢弃并说明原因 */
  const 字段表 = { 构件: ["名称", "类别", "尺寸", "依据"], 实测: ["部位", "数值"], 现状: ["内容", "依据"] };

  function resolveTarget(e) {
    const 编号 = String(e.编号 || "").trim();
    // 模型有时把字段选项原样写回，例如 "尺寸|数据来源"，取第一个合法的
    const 候选 = String(e.字段 || "").split(/[|｜\/，,、]/).map(s => s.trim());
    let 对象 = String(e.对象 || "").trim();

    // 没写对象类型时按编号形态猜：P 开头是构件，d 开头是实测，其余当现状
    if (!字段表[对象]) {
      if (/^P\d+/i.test(编号)) 对象 = "构件";
      else if (/^d\d+/i.test(编号)) 对象 = "实测";
      else 对象 = "现状";
    }
    const 字段 = 候选.find(s => 字段表[对象].includes(s));
    if (!字段) return { ok: false, why: 编号 + "（字段不可改）" };

    if (对象 === "构件") {
      const p = Store.findPart(编号);
      if (!p) return { ok: false, why: 编号 + "（构件不存在）" };
      return { ok: true, 对象, 编号, 名称: p.名称, 字段, 原值: p[字段] == null ? "" : p[字段] };
    }
    if (对象 === "实测") {
      const d = S().实测.find(x => x.id === 编号 || x.部位 === 编号);
      if (!d) return { ok: false, why: 编号 + "（实测项不存在）" };
      return { ok: true, 对象, 编号: d.id, 名称: d.部位 + " " + d.数值 + d.单位, 字段,
               原值: d[字段] == null ? "" : d[字段] };
    }
    const c = S().现状.find(x => x.部位 === 编号 || (x.部位 + x.项目) === 编号);
    if (!c) return { ok: false, why: 编号 + "（现状项不存在）" };
    return { ok: true, 对象, 编号: c.部位, 名称: c.部位 + " " + c.项目, 字段,
             原值: c[字段] == null ? "" : c[字段] };
  }

  /* 应用一条修改。按对象类型分发，改完把状态提为人工确认。 */
  function applyEdit(msgIndex, editIndex) {
    const m = S().消息[msgIndex];
    if (!m || !m.edits) return;
    const e = m.edits[editIndex];
    if (!e || e.状态) return;

    if (e.对象 === "构件") {
      const patch = {}; patch[e.字段] = e.新值;
      Store.editPart(e.编号, patch, "采纳 AI 建议：" + e.理由);
    } else if (e.对象 === "实测") {
      const d = S().实测.find(x => x.id === e.编号);
      if (d) {
        d[e.字段] = e.字段 === "数值" ? (parseFloat(e.新值) || d.数值)
                  : e.字段 === "部位" ? window.DatumCheck.normalize(e.新值)
                  : e.新值;
        d.状态 = "measured";
        d.说明 = "采纳 AI 建议：" + e.理由;
        Store.log("修改实测", e.编号, e.字段 + " 改为 " + e.新值 + "；" + e.理由);
      }
    } else {
      const c = S().现状.find(x => x.部位 === e.编号);
      if (c) {
        c[e.字段] = e.新值;
        c.状态 = "human";
        Store.log("修改现状", e.编号, e.字段 + " 改为 " + e.新值 + "；" + e.理由);
      }
    }
    e.状态 = "已应用";
    Metrics.adopt(e.编号 + " " + e.字段, "采用");
    // 数据变了，同一批次里还没处理的条目要重算警告，否则显示的是过时判断
    m.edits.forEach(x => { if (!x.状态) x.警告 = window.EditCheck.run(x, S()); });
    Store.emit();
  }
  function ignoreEdit(msgIndex, editIndex) {
    const m = S().消息[msgIndex];
    if (!m || !m.edits) return;
    const e = m.edits[editIndex];
    if (!e || e.状态) return;
    e.状态 = "已忽略";
    Metrics.adopt(e.编号 + " " + e.字段, "忽略");
    Store.log("忽略建议", e.编号, e.字段 + " 建议改为 " + e.新值 + "，人工判断不采纳");
    Store.emit();
  }
  function applyAllEdits(msgIndex, 只应用无疑问的) {
    const m = S().消息[msgIndex];
    if (!m || !m.edits) return;
    let n = 0, 跳过 = 0;
    const 涉及 = new Set();
    m.edits.forEach((e, i) => {
      if (e.状态) return;
      if (只应用无疑问的 && e.警告 && e.警告.length) { 跳过++; return; }
      applyEdit(msgIndex, i); n++; 涉及.add(e.对象);
    });
    // 改完切到能看见变化的那个视图，否则用户不知道改哪了
    const 视图映射 = { 构件: "parts", 实测: "datum", 现状: "condition" };
    const 主要 = 视图映射[Array.from(涉及)[0]];
    if (主要 && S().当前视图 !== 主要) Store.goto(主要);
    Store.say("ai", "已应用 " + n + " 条修改，全部记入修改历史，每条都能查到理由和应用时间。" +
      (跳过 ? "有疑问的 " + 跳过 + " 条我没动，留着你自己判断。" : "") +
      (主要 ? "已经切到" + (Workspace.VIEWS[主要] || {}).名 + "，改动都在里面。" : ""));
    idle();
  }

  async function freeChat(text) {
    if (!API.isReady()) {
      Store.say("ai", "在线识别服务尚未连接，目前只能体验示例流程，不能回答项目中的新问题。");
      return;
    }
    Store.status("正在整理回答", "核对当前项目资料", "busy");
    const ctx = buildContext();
    const msgs = S().消息.filter(m => (m.who === "user" || m.who === "ai") && m.text && m.text.trim());
    const hist = msgs.slice(-7).map(m => ({ role: m.who === "user" ? "user" : "assistant", content: m.text }));
    // 数据快照插在最后一条提问之前，保证模型回答时紧邻的上文就是当前完整数据
    hist.splice(hist.length - 1, 0,
      { role: "user", content: ctx },
      { role: "assistant", content: "收到，我已经读到工作区当前的完整数据。" });

    const msg = Store.say("ai", "", { process: [], processing: true });
    processStep(msg, "正在提交问题", "已附带当前项目资料", "running");
    let 已收到分析 = false;
    let 已开始回答 = false;
    try {
      const r = await API.chat(hist, (d, full, think) => {
        msg.text = full;
        if (think && !已收到分析) {
          已收到分析 = true;
          processStep(msg, "AI 正在分析", "已收到模型返回的分析信号", "running");
        }
        if (d && !已开始回答) {
          已开始回答 = true;
          processStep(msg, "AI 正在回答", "回答内容正在逐步返回", "running");
        } else {
          Store.emit();
        }
      }, { step: "自由问答" });
      msg.text = r.text;
      msg.think = null;
      processStep(msg, "回答已接收", "内容已完整返回", "done");

      // 回答里给出了具体的值或改法时，主动问要不要写进数据。
      // 不主动问，用户就只能自己去表格里手动改，那就退回成后台系统了。
      if (looksActionable(r.text)) {
        msg.card = { key: "offer-apply", title: "要我把这些写进数据吗",
          body: "我可以逐条列出改哪一项、改成什么、依据是什么，你确认后再生效。",
          options: [{ label: "好，生成修改清单", value: 1 }, { label: "先不用", value: 0 }],
          type: "" };
        msg.srcText = r.text;
      }
      Store.emit();
    } catch (e) {
      msg.text = "这次没有完成回答：" + String(e.message || e).slice(0, 150);
      processStep(msg, "处理未完成", String(e.message || e).slice(0, 80), "error");
    }
    idle();
  }

  /* 判断助手的回答是不是"给出了可落地的改法"。
     命中就主动问要不要应用，避免用户只拿到一段文字却要自己手动改。 */
  function looksActionable(t) {
    if (!t || t.length < 12) return false;
    const 有值 = /\d{2,}\s*(mm|毫米|cm|米|m\b)/.test(t) || /→|改为|应为|应改|建议改|实际是|判断为|对应/.test(t);
    const 有对象 = /P\d{2}|构件|尺寸|部位|实测|清单|现状/.test(t);
    const 只是拒绝 = /无法|不能确定|需要现场|待复核|没有依据|不建议/.test(t) && !/建议改|应为|改为/.test(t);
    return 有值 && 有对象 && !只是拒绝;
  }

  /* 把模型解析出的草图结果写回实测表。
     能确定部位的标 measured，说不准的保持 unknown 交给人指认。 */
  function applySketch(r) {
    const 表 = S().实测;
    (r.已识别 || []).forEach(x => {
      if (!x.部位 || !x.数值) return;
      // 模型原词不直接进正式字段，先映射到标准部位名，核对规则才认得
      const 位 = window.DatumCheck.normalize(x.部位);
      const hit = 表.find(d => d.数值 === Number(x.数值) || d.部位 === 位);
      if (hit) { hit.部位 = 位; hit.状态 = "ai"; hit.说明 = x.依据 || "从草图转写中识别，尚未核对原始记录"; }
      else 表.push({ id: "d" + (表.length + 1), 部位: 位, 数值: Number(x.数值),
        单位: "mm", 方式: "草图转写", 状态: "ai", 说明: x.依据 || "从草图转写中识别，尚未核对原始记录" });
      }, { step: "自由问答", taskId: "assistant.answer" });
    (r.无法确定 || []).forEach(x => {
      const hit = 表.find(d => d.数值 === Number(x.数值));
      if (hit) {
        hit.状态 = "unknown";
        hit.说明 = x.为什么不确定 || "草图未标注部位";
        hit.候选 = x.可能是 || [];
      }
    });
  }

  /* 工作区完整数据快照。助手能回答什么，取决于这里给了什么。
     只给摘要会让它答"未收到数据"，所以构件、实测、存疑、检查全部带上。 */
  function buildContext() {
    const s = S();
    const 状态名 = { measured: "现场实测", ai: "AI 识别", program: "程序生成", rule: "程序生成",
      human: "人工确认", demo: "示例资料", unknown: "待确认", missing: "资料缺失" };
    const L = [];

    L.push("【工作区当前数据】以下是系统里的真实数据，回答时直接引用，不要说没有收到。");
    L.push("");

    /* 数量、状态、来源这类确定事实由程序统计好给模型，模型只负责组织语言。
       实测它自己数会数错：37 个构件全标 AI 实时，它答成 34 个模型加 3 个人工。 */
    const 计 = {};
    s.构件.forEach(p => { const k = 状态名[p.状态] || p.状态; 计[k] = (计[k] || 0) + 1; });
    L.push("== 自动统计（数量与来源以本节为准，直接引用，不要自行计数） ==");
    L.push("构件共 " + s.构件.length + " 项：" +
      Object.keys(计).map(k => k + " " + 计[k] + " 项").join("，") + "。");
    L.push("实测记录共 " + s.实测.length + " 项，其中实测依据 " +
      s.实测.filter(d => d.状态 === "measured").length + " 项，待确认 " +
      s.实测.filter(d => d.状态 === "unknown").length + " 项。");
    L.push("存疑项共 " + s.存疑.length + " 项，未处理 " +
      s.存疑.filter(q => !q.已解决).length + " 项。存疑项是待判定的问题清单，不是构件的来源分类。");
    L.push("检查问题共 " + s.检查问题.length + " 项，待决定 " +
      s.检查问题.filter(c => c.处理 === "pending").length + " 项。");
    L.push("修改记录共 " + s.修改记录.length + " 条。");
    L.push("");
    L.push("== 项目 ==");
    L.push(DATA.项目.名称 + "，" + DATA.项目.地点 + "，" + DATA.项目.保护级别);
    L.push("成果：" + DATA.项目.成果 + "，比例：" + ((s.任务卡.比例 && s.任务卡.比例.值) || "未确定") +
      "，规范：" + ((s.任务卡.适用规范 && s.任务卡.适用规范.值) || "未确定"));
    L.push("精度要求：" + ((s.任务卡.精度要求 && s.任务卡.精度要求.值) || "未确定"));
    L.push("验证性质：" + (DATA.项目.验证性质 || "未标记") +
      (DATA.项目.可对外正式交付 === false ? "，不可对外正式交付" : ""));
    L.push("当前所在步骤：" + ((DATA.步骤.find(x => x.视图 === s.当前视图) || {}).名 || s.当前视图));

    L.push("");
    L.push("== 尺寸记录（只有标为现场实测的项可以作为正式尺寸基准）==");
    s.实测.forEach(d => {
      L.push("- " + d.部位 + "：" + d.数值 + d.单位 + "，" + d.方式 + "，" + (状态名[d.状态] || d.状态) +
        (d.说明 ? "，" + d.说明 : ""));
    });

    L.push("");
    L.push("== 构件清单（共 " + s.构件.length + " 项）==");
    L.push("格式：编号 | 名称 | 类别 | 尺寸 | 数据来源 | 识别把握 | 判断依据");
    s.构件.forEach(p => {
      L.push([p.编号, p.名称, p.类别, p.尺寸 || "未给出",
        状态名[p.状态] || p.状态, p.置信,
        (p.人工结论 ? "已判定：" + p.人工结论 + "。" : "") + (p.依据 || "")].join(" | "));
    });

    L.push("");
    L.push("== 存疑项 ==");
    if (!s.存疑.length) L.push("无");
    s.存疑.forEach(q => {
      L.push("- " + q.标题 + (q.构件 ? "（" + q.构件 + "）" : "") + "：" + q.问题 +
        (q.已解决 ? " 【已判定：" + q.结论 + "，判断人 " + q.处理人 + "，理由：" + (q.理由 || "未填") + "】" : " 【未处理】"));
    });

    L.push("");
    L.push("== 现状记录 ==");
    s.现状.forEach(c => L.push("- " + c.部位 + " " + c.项目 + "：" + c.内容 + "（" + (状态名[c.状态] || c.状态) + "，依据：" + c.依据 + "）"));

    L.push("");
    L.push("== 检查问题 ==");
    if (!s.检查问题.length) L.push("无");
    s.检查问题.forEach(c => {
      L.push("- [" + c.类型 + "] " + c.标题 + "：" + c.说明 +
        (c.处理 === "auto" ? " 【已自动修复】" : c.处理 === "resolved" ? " 【已决定：" + c.结论 + "】" : " 【待你决定】"));
    });

    if (s.选中构件) {
      const p = Store.findPart(s.选中构件);
      if (p) L.push("", "== 用户当前选中 ==", p.编号 + " " + p.名称 + "，" + (p.尺寸 || "未给出尺寸"));
    }

    L.push("");
    L.push("== 已知限制 ==");
    (s.交付.限制条件 || []).forEach(item => L.push("- " + item));
    s.现状.filter(x => x.状态 === "unknown" || x.状态 === "missing")
      .forEach(item => L.push("- " + item.部位 + "：" + item.内容));
    L.push("- 标注为 AI 识别、示例资料、待确认或资料缺失的尺寸不是现场实测值");

    return L.join("\n");
  }

  // ===== 框选修正 =====
  /* 四类动作的执行体。规则命中和模型解析两条路都走这里，行为一致。 */
  function refDelete(ref, text) {
    Store.removePart(ref.命中, "人工框选后指出该位置无构件：" + text);
    Store.say("ai", "已删除 " + ref.命中 + "，并记入本项目排除记录。");
  }
  function refRename(ref, 新名, text) {
    const old = Store.findPart(ref.命中);
    Store.editPart(ref.命中, { 名称: 新名, 置信: "高" }, "人工改正：" + text);
    Store.say("ai", "已把 " + ref.命中 + " 从「" + old.名称 + "」改为「" + 新名 + "」，原判断和修改理由都记下了。");
  }
  function refOcclude(ref, text) {
    const p = Store.addPart({ 名称: "不可见部位", 类别: "墙体", 框: ref.框, 置信: "低", 状态: "unknown",
      依据: "人工标记：" + text }, "人工标记遮挡区域");
    Store.say("ai", "已把这块标记为不可见部位（" + p.编号 + "）。按规范，现状图不能绘制未经确认的内容，" +
      "这块会在图上标注说明，也进了补拍清单。");
  }
  function refAdd(名称, ref, text) {
    const 对称 = findSymmetric(ref.框, 名称);
    const p = Store.addPart({
      名称, 类别: guessCat(名称), 框: ref.框, 置信: 对称 ? "中" : "低", 状态: "human",
      尺寸: 对称 ? (对称.尺寸 || "") : "",
      依据: "人工框选补充：" + text + (对称 ? "；尺寸按对称构件 " + 对称.编号 + " 推算" : "")
    }, "人工框选补充");
    Store.selectPart(p.编号);
    // 存下待执行内容：用户点"是"时要真的补录，不能只嘴上说补了
    const 区 = DATA.遮挡区域;
    pendingSym = 区 && Array.isArray(区.框) ? { 名称, 类别: guessCat(名称), 参照: p.编号, 尺寸: p.尺寸 || "" } : null;
    let 回 = "找到了，位置在你框的这块。我按「" + 名称 + "」补录了 " + p.编号 + "。";
    if (对称) 回 += "右边有一个对称的 " + 对称.编号 + "，尺寸我按对称关系推算，标为推测值等你确认。";
    if (pendingSym) {
      回 += "\n\n项目数据还标记了「" + 区.部位 + "」遮挡区域。要不要按同样做法补一项推测记录？";
      Store.say("ai", 回, { card: { key: "sym", title: "要不要按同样做法补上遮挡处",
        options: [{ label: "是，按同样做法补", value: 1 }, { label: "不确定，保持存疑", value: 0 }], type: "" } });
    } else Store.say("ai", 回);
  }

  async function handleRefEdit(text, ref) {
    Store.clearRef();
    Store.status("正在处理修正", "定位到对应构件", "busy");
    await UI.sleep(500);

    const 删除 = /没有|不存在|删掉|删除|多了/.test(text);
    const 认错 = /不是|错了|应该是|其实是/.test(text);
    const 遮挡 = /挡|看不清|遮/.test(text);

    if (ref.命中 && 删除) { refDelete(ref, text); idle(); return; }

    let 规则没懂 = false;
    if (ref.命中 && 认错) {
      const m = text.match(/(?:是|应该是|其实是)\s*([^\s，。,.]{2,8})/);
      if (m) { refRename(ref, m[1], text); idle(); return; }
      规则没懂 = true;   // 听出是认错，但没提取到新名称，交给模型
    }
    if (!规则没懂 && 遮挡) { refOcclude(ref, text); idle(); return; }

    // 新增构件：从话里取名称
    let 名称 = null;
    const m2 = text.match(/(?:漏了|少了|还有|这是|加一?个)\s*(?:一个|个)?\s*([^\s，。,.]{2,8})/);
    if (m2) 名称 = m2[1];
    if (!名称) {
      for (const v of CFG.VOCAB) { if (text.includes(v)) { 名称 = v; break; } }
    }
    if (名称 && !规则没懂) { refAdd(名称, ref, text); idle(); return; }

    /* 规则没听懂时交给模型解析意图。
       此前这里只会让用户换个说法，README 写的"超出规则时模型介入"是空话。 */
    if (API.isReady()) {
      Store.status("正在理解你的说明", "核对框选位置和修改要求", "busy");
      try {
        const r = await API.jsonTask(CFG.refEditPrompt(text, ref.命中), {
          step: "框选理解", taskId: "selection.interpret"
        });
        const a = r.动作 || "";
        if (a === "删除" && ref.命中) refDelete(ref, text);
        else if (a === "改名" && ref.命中 && r.名称) refRename(ref, r.名称, text);
        else if (a === "遮挡") refOcclude(ref, text);
        else if (a === "新增" && r.名称) refAdd(r.名称, ref, text);
        else Store.say("ai", (r.说明 ? r.说明 + " " : "") +
          "我还是不确定你要改什么。可以说「这里漏了一个雀替」「这个不是雀替，是替木」或「这块被树挡住了」。");
      } catch (e) {
        Metrics.fail("框选理解", e.message || e);
        Store.say("ai", "解析失败：" + String(e.message || e).slice(0, 100) +
          "。可以换个说法，例如「这里漏了一个雀替」。");
      }
    } else {
      Store.say("ai", "我看到你框了这块位置，但没听清是什么问题。可以直接说「这里漏了一个雀替」或者「这块被树挡住了」。");
    }
    idle();
  }

  function findSymmetric(box, 名称) {
    const cx = (box[0] + box[2]) / 2;
    const mirror = 1 - cx;
    let best = null, bd = 0.12;
    S().构件.forEach(p => {
      if (p.名称 !== 名称) return;
      const pc = (p.框[0] + p.框[2]) / 2;
      const d = Math.abs(pc - mirror);
      if (d < bd) { bd = d; best = p; }
    });
    return best;
  }
  function guessCat(名称) {
    const map = { 雀替: "木装修", 替木: "木装修", 檐柱: "柱", 金柱: "柱", 额枋: "枋", 平板枋: "枋",
      斗栱: "铺作", 椽: "屋面木作", 飞椽: "屋面木作", 正脊: "屋面瓦饰", 吻兽: "屋面瓦饰",
      脊刹: "屋面瓦饰", 台基: "台基", 踏步: "台基", 板门: "门窗", 直棂窗: "门窗", 隔扇: "木装修" };
    return map[名称] || "木装修";
  }

  /* ===== 拖入文件 =====
     用户拖进来的是真实资料，必须真的处理并写进业务数据，
     而不是识别完报个数字就完了。 */
  async function onDrop(file) {
    const 名 = file.name || "文件";
    Store.say("user", "（拖入了 " + 名 + "）");

    if (!/^image\//.test(file.type)) {
      const 格式 = (名.split(".").pop() || "").toLowerCase();
      const 说明 = {
        pdf: "PDF 需要先转成图片。任务书可以直接用手机拍一张，或者截图后拖进来。",
        doc: "Word 文档请先另存为 PDF 再截图，或者把内容直接粘贴到对话框里。",
        docx: "Word 文档请先另存为 PDF 再截图，或者把内容直接粘贴到对话框里。",
        dwg: "DWG 是二进制格式，浏览器读不了。可以在 CAD 里导出图片或 DXF。",
        dxf: "DXF 的解析还没做，下一轮和 DXF 导出一起做。"
      }[格式] || "这个格式还没支持。";
      Store.say("ai", "收到 " + 名 + "，但我现在只能处理图片。" + 说明 +
        "\n\n可以处理的：jpg、png 的现场照片、手写尺寸草图照片、任务书照片或截图。");
      Metrics.fallback("文件处理", "不支持的格式 " + 格式);
      return;
    }

    if (!API.isReady()) {
      Store.say("ai", "图片已收到，但在线识别服务尚未连接。请检查连接后重新拖入。");
      Metrics.fallback("文件处理", "AI 服务未配置");
      return;
    }

    Store.status("正在读取图片", 名, "busy");
    const 占位 = Store.say("ai", "正在判断这份资料的类型。");
    let url;
    try {
      url = await API.readImage(file, 1400);
    } catch (e) {
      占位.text = "图片读取失败：" + String(e.message || e).slice(0, 100);
      Store.emit(); idle(); return;
    }

    // 第一步：先判断这是什么图，不要求用户自己说明
    let 分类;
    try {
      分类 = await API.visionTask(url, CFG.classifyPrompt(), {
        step: "资料分类", taskId: "material.classify_image"
      });
    } catch (e) {
      占位.text = "判断图片类型失败：" + String(e.message || e).slice(0, 120);
      Metrics.fail("资料分类", e.message || e);
      Store.emit(); idle(); return;
    }

    const 类 = 分类.类别 || "其他";
    占位.text = "看了一下，这是" + 类 + "。" + (分类.理由 || "") +
      ((分类.质量问题 || []).length ? "\n注意：" + 分类.质量问题.join("；") + "。" : "");
    Store.emit();

    try {
      if (/手写|草图/.test(类)) await 处理草图(url, 名);
      else if (/任务书|文档/.test(类)) await 处理任务书(url, 名);
      else if (/立面|细部|照片/.test(类)) await 处理照片(url, 名, 类);
      else {
        Store.say("ai", "这张图我判断为「" + 类 + "」，不属于测绘资料，没有写入项目。" +
          "如果我判断错了，直接告诉我它是什么。");
      }
    } catch (e) {
      Store.say("ai", "处理失败：" + String(e.message || e).slice(0, 150));
      Metrics.fail("文件处理", e.message || e);
    }
    idle();
  }

  /* 手写草图照片：真的从图上读数值，读完写进实测表并推动流程 */
  async function 处理草图(url, 名) {
    Store.status("正在读手写尺寸", 名, "busy");
    const 占位 = Store.say("ai", "正在读取草图上的尺寸。");
    const r = await API.visionTask(url, CFG.sketchImagePrompt(), {
      step: "草图识别", taskId: "sketch.extract_image"
    });

    // 真实数据覆盖演示数据
    const 新表 = [];
    (r.已识别 || []).forEach((x, i) => {
      if (!x.部位 || !x.数值) return;
      新表.push({ id: "u" + (i + 1), 部位: window.DatumCheck.normalize(x.部位), 数值: Number(x.数值),
        单位: x.单位 || "mm", 方式: "现场实测", 状态: "measured",
        说明: (x.依据 || "") + "（从你上传的草图中识别）" });
    });
    (r.无法确定 || []).forEach((x, i) => {
      新表.push({ id: "uu" + (i + 1), 部位: "待确认 " + (i + 1), 数值: Number(x.数值),
        单位: "mm", 方式: "现场实测", 状态: "unknown",
        说明: x.为什么不确定 || "草图上未标注部位", 候选: x.可能是 || [] });
    });

    if (!新表.length) {
      占位.text = "这张草图我没读出可用的尺寸。" +
        ((r.读不清 || []).length ? "看不清的部分：" + r.读不清.join("；") + "。" : "") +
        "换一张更清楚的，或者直接把数值打在对话框里。";
      Store.emit(); return;
    }

    S().实测 = 新表;
    S().实测来源 = "用户上传的草图";
    Store.log("导入实测", 名, "从上传的草图中读出 " + 新表.length + " 项");
    Metrics.adopt("草图 " + 名, "采用");

    const 确定 = 新表.filter(d => d.状态 === "measured").length;
    const 待定 = 新表.length - 确定;
    占位.text = (r.说明 || "读完了。") + "\n\n" +
      "写进实测表 " + 新表.length + " 项，其中 " + 确定 + " 项能确定部位，" +
      (待定 ? 待定 + " 项草图上没标部位，需要你指认。" : "全部可用。") +
      ((r.读不清 || []).length ? "\n看不清的：" + r.读不清.join("；") + "。" : "") +
      "\n\n这些数值替换了原来的演示数据，现在的基准来自你上传的草图。";
    Store.emit();

    Store.goto("datum");
    Store.setStep("materials", "done");
    Store.setStep("datum", 待定 ? "stop" : "done");
    if (待定) stopAt("等你指认", 待定 + " 个尺寸部位不明");
    else {
      Store.say("ai", "基准建立好了，可以往下走。");
      idle("基准已建立", "可以开始识别构件");
    }
  }

  /* 任务书照片：真的从图上提取要求，写进任务卡 */
  async function 处理任务书(url, 名) {
    Store.status("正在读任务书", 名, "busy");
    const 占位 = Store.say("ai", "正在读取这份任务书。");
    const r = await API.visionTask(url, CFG.briefImagePrompt(), {
      step: "任务书识别", taskId: "brief.extract_image"
    });

    const 卡 = S().任务卡;
    let n = 0;
    ["成果类型", "比例", "适用规范", "交付格式", "附带材料", "精度要求", "工期"].forEach(k => {
      const v = r[k];
      if (v && v.值 && String(v.值).trim()) {
        卡[k] = { 值: String(v.值).trim(), 来源: "ai", 出处: (v.出处 || "任务书") + "（你上传的）" };
        n++;
      }
    });
    if (r.对象 && r.对象.值) {
      S().新项目 = Object.assign(S().新项目 || {}, { 对象: r.对象.值 });
    }
    Store.log("导入任务书", 名, "从上传的任务书中读出 " + n + " 项要求");
    Metrics.adopt("任务书 " + 名, "采用");

    占位.text = "读完了，提取到 " + n + " 项要求，已经填进任务卡，每项都标了出处和来自你上传的文件。" +
      ((r.读不清 || []).length ? "\n看不清的：" + r.读不清.join("；") + "。" : "") +
      ((r.遗漏项 || []).length ? "\n任务书里没写的：" + r.遗漏项.slice(0, 3).join("；") + "。" : "");
    Store.emit();
    Store.goto("task");
    Store.setStep("task", "stop");
    stopAt("等你核对", "任务卡已按上传文件更新");
  }

  /* 现场照片：真的识别构件，结果写进构件清单并接上后续流程 */
  async function 处理照片(url, 名, 类) {
    Store.status("正在识别构件", 名 + "，约一分钟", "busy");
    const 占位 = Store.say("ai", "正在识别构件，预计需要约一分钟。");
    const r = await API.recognize(url, visionCtx((S().新项目 && S().新项目.对象) || "中国古建筑立面"));
    const list = (r.parsed.构件 || []).map((c, i) => ({
      编号: c.编号 || ("U" + String(i + 1).padStart(2, "0")),
      名称: c.名称 || "未命名", 类别: c.类别 || "木装修",
      框: Array.isArray(c.位置框) && c.位置框.length === 4 ? c.位置框 : [0.4, 0.4, 0.6, 0.6],
      置信: c.置信度 || "中", 状态: "ai", 尺寸: "",
      依据: (c.依据 || "") + "（从你上传的照片中识别，位置框需人工核对）"
    }));

    if (!list.length) {
      占位.text = "这张照片我没识别出构件。可能是拍摄角度或分辨率的问题，换一张正立面全景试试。";
      Store.emit(); return;
    }

    // 真实识别结果替换演示数据，并把这张照片设为主图
    S().构件 = list;
    S().主图 = url;
    S().构件来源 = "用户上传的照片";
    S().存疑 = (r.parsed.存疑项 || []).map((q, i) => ({
      id: "uq" + (i + 1), 构件: q.编号 || "", 标题: (q.问题 || "").slice(0, 24) || "存疑项",
      问题: q.问题 || "", 选项: ["按当前判断记录", "标为待现场复核"], 需要: "专业复核人"
    }));
    Store.log("导入识别", 名, "从上传照片识别出 " + list.length + " 个构件");
    Metrics.adopt("照片 " + 名, "采用");

    占位.text = "识别完成，" + list.length + " 个构件已经写进构件清单，主图换成了你上传的这张。\n\n" +
      (S().存疑.length ? "其中 " + S().存疑.length + " 项存疑，需要你判断。" : "") +
      "\n请在图上核对位置框是否贴合构件边界。";
    Store.emit();

    Store.goto("parts");
    Store.setStep("parts", S().存疑.length ? "stop" : "done");
    if (S().存疑.length) stopAt("等你判断", S().存疑.length + " 项存疑");
    else idle("识别完成", "可以继续往下走");
  }

  // 选项统一入口
  const _onChoice = onChoice;
  function onChoiceRouter(key, value, label) {
    // AI 服务不可用时的两个出口
    if (key === "no-key") {
      if (value === "setkey") { Settings.open(); return; }
      Store.say("ai", "接下来使用示例资料，页面会把这些内容标为“示例资料”。在线服务连接后，可以重新提交刚才的任务处理新资料。");
      Metrics.fallback("立项理解", "用户选择演示流程");
      return demoIntake();
    }
    // 本机没有该项目资料时的两个出口
    if (key === "no-project") {
      if (value === "upload") {
        Store.say("ai", "好。把照片、手写尺寸草图或任务书直接拖进这个对话框，我来识别。" +
          "支持 jpg、png 图片，包括拍下来的纸质任务书和草图。识别结果会直接进入构件清单和实测表。");
        Store.goto("materials");
        idle("等你上传资料", "拖文件进对话框");
        return;
      }
      Store.say("ai", "将使用当前项目「" + DATA.项目.名称 + "」的代理验证资料继续。你刚才说明的要求会保留并标明来源，其余内容仍标为示例资料。");
      return readBrief();
    }
    if (key === "offer-apply") {
      if (!value) { Store.say("ai", "好，那先放着。想改的时候告诉我。"); return; }
      // 把刚才那段回答作为依据，生成结构化的修改清单
      const src = (S().消息.slice().reverse().find(m => m.srcText) || {}).srcText || "";
      return proposeEdits("按你刚才这段判断，把能确定的项写进数据：\n" + src.slice(0, 1200));
    }
    if (key && key.startsWith("ret:")) return doReturn(key.slice(4), value);
    if (key && key.startsWith("q:")) return resolveQ(key.slice(2), value, label);
    if (key && key.startsWith("lib:")) {
      if (value && pendingLib) {
        Store.toLibrary(pendingLib);
        Store.say("ai", "已存入项目构件库，当前共 " + S().构件库.length +
          " 条。本项目其他建筑出现同样形制时按这条判断处理。");
      } else {
        Store.say("ai", "好，这次不存，判断只对当前构件生效。");
      }
      pendingLib = null;
      return;
    }
    if (key === "sym") {
      if (value && pendingSym) {
        const 区 = DATA.遮挡区域;
        if (!区 || !Array.isArray(区.框)) {
          Store.say("ai", "当前项目没有声明遮挡区域，未自动补录。");
          pendingSym = null;
          return;
        }
        const p = Store.addPart({
          名称: pendingSym.名称, 类别: pendingSym.类别,
          框: 区.框, 置信: "低", 状态: "unknown",
          尺寸: pendingSym.尺寸,
          依据: "按 " + pendingSym.参照 + " 对称做法推补，位于" + 区.部位 + "遮挡区域，未见实物，待补拍确认"
        }, "按对称做法推补遮挡处");
        Store.goto("parts");
        Store.selectPart(p.编号);
        Store.say("ai", "已按同样做法补录 " + p.编号 + "，位置在" + 区.部位 + "的遮挡区域，标为待确认。" +
          "出图检查会把它计入不可见部位，补拍确认前不会作为确定内容进图。");
      } else {
        Store.say("ai", "保持存疑。这几处会在图上标为不可见部位。");
      }
      pendingSym = null;
      return;
    }
    return _onChoice(key, value, label);
  }

  return { start, userSay, onChoice: onChoiceRouter, openQuestion, onDrop,
           runRecognize, afterParts, afterDrawing, runDrawing, idle,
           proposeEdits, applyEdit, ignoreEdit, applyAllEdits, openReturn };
})();
