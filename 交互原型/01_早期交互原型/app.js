const moduleSteps = [
  { label: "建立任务", page: 3 },
  { label: "整理资料", page: 6 },
  { label: "核对构件", page: 9 },
  { label: "记录现状", page: 12 },
  { label: "制作成果", page: 15 },
  { label: "检查成果", page: 17 },
  { label: "准备交付", page: 21 },
  { label: "后续复查", page: null }
];

const row = (main, state) => [main, state];
const panel = (title, rows, accent = false) => ({ title, rows, accent });
const action = (label, style, kind, target, left) => ({ label, style, kind, target, left });

const pages = [
  {
    active: 1,
    eyebrow: "开始使用",
    title: "欢迎使用",
    subtitle: "新建一个测绘任务，或继续已有项目。",
    topStatus: "准备开始",
    panels: [
      panel("开始新项目", [row("准备创建测绘任务", "可开始"), row("当前状态", "可继续"), row("负责人", "项目负责人")], true),
      panel("最近项目", [row("衡复风貌区 · 资料整理 68%", "进行中"), row("资料来源", "可查看"), row("下一步", "查看或新建项目")])
    ],
    work: { type: "simple", chips: [["可开始", "success"]], note: "查看最近项目，或开始一个新项目。" },
    actions: [action("查看项目", "primary", "go", 2, 1187)]
  },
  {
    active: 0,
    eyebrow: "项目首页",
    title: "我的项目",
    subtitle: "查看项目进度和待处理事项。",
    topStatus: "项目首页",
    panels: [
      panel("项目状态", [row("1 个进行中 · 2 个待确认", "进行中"), row("当前状态", "可继续"), row("负责人", "项目负责人")]),
      panel("待办事项", [row("待补资料 3 · 待复核 2", "待处理"), row("资料来源", "可查看"), row("下一步", "建立测绘任务")])
    ],
    work: { type: "simple", chips: [["进行中", "success"]], note: "继续前，请先处理待补资料和待复核事项。" },
    actions: [action("返回", "ghost", "go", 1, 1017), action("新建测绘任务", "primary", "go", 3, 1187)]
  },
  {
    active: 1,
    eyebrow: "建立任务 · 第 1 步",
    title: "新建测绘任务",
    subtitle: "填写测绘对象和需要提交的成果。",
    topStatus: "建立任务",
    panels: [
      panel("测绘对象", [row("衡复风貌区 · 某历史建筑", "已填写"), row("当前状态", "可继续"), row("负责人", "项目负责人")]),
      panel("需要提交的成果", [row("现状保护立面成果", "已选择"), row("资料来源", "可查看"), row("下一步", "设置成果要求")])
    ],
    work: {
      type: "inputChecks",
      inputs: [
        ["测绘对象", "衡复风貌区 · 某历史建筑", "后续资料和图纸都归到这个项目"],
        ["成果类型", "现状保护立面成果", "先制作现状保护立面图"]
      ],
      checks: ["同时提交图纸、构件清单和检查记录"]
    },
    actions: [action("返回", "ghost", "go", 2, 1017), action("设置成果要求", "primary", "go", 4, 1187)]
  },
  {
    active: 1,
    eyebrow: "建立任务 · 第 2 步",
    title: "设置成果要求",
    subtitle: "选择成果比例和精度，确认需要准备的资料。",
    topStatus: "建立任务",
    panels: [
      panel("适用规范", [row("上海 · 现行适用规范", "已选择"), row("当前状态", "可继续"), row("负责人", "项目负责人")]),
      panel("成果要求", [row("立面图 1:50 · 需要实测控制点", "已设置"), row("资料来源", "可查看"), row("下一步", "确认参与人员")])
    ],
    work: { type: "checks", checks: ["采用上海地区适用规范", "立面比例 1:50", "已准备实测控制点"], chips: [["还缺 1 项资料", "warning"]] },
    actions: [action("返回", "ghost", "go", 3, 1017), action("确认参与人员", "primary", "go", 5, 1187)]
  },
  {
    active: 1,
    eyebrow: "建立任务 · 第 3 步",
    title: "确认参与人员和检查要求",
    subtitle: "安排资料整理、专业复核和负责人确认。",
    topStatus: "建立任务",
    panels: [
      panel("参与人员", [row("资料整理人 · 专业复核人 · 负责人", "已确认"), row("当前状态", "可继续"), row("负责人", "项目负责人")]),
      panel("交付检查", [row("资料齐全 · 尺寸准确 · 版本正确 · 负责人确认", "已确认"), row("资料来源", "可查看"), row("下一步", "上传项目资料")])
    ],
    work: { type: "simple", chips: [["资料整理人已确定", "success"], ["专业复核人已确定", "success"], ["接收方待确认", "warning"]], note: "最终成果由指定负责人确认。" },
    actions: [action("返回", "ghost", "go", 4, 1017), action("上传项目资料", "primary", "go", 6, 1187)]
  },
  {
    active: 2,
    eyebrow: "整理资料 · 第 1 步",
    title: "上传项目资料",
    subtitle: "上传照片、实测记录、草图、图纸和相关文件。",
    topStatus: "整理资料",
    panels: [
      panel("已上传资料", [row("照片 86 · 图纸 4 · 实测表 2", "已上传"), row("当前状态", "可继续"), row("负责人", "资料管理员")]),
      panel("资料信息", [row("记录采集人、位置、时间和取得方式", "已填写"), row("资料来源", "可查看"), row("下一步", "检查资料是否齐全")])
    ],
    work: { type: "upload" },
    actions: [action("返回", "ghost", "go", 5, 1017), action("检查资料", "primary", "go", 7, 1187)]
  },
  {
    active: 2,
    eyebrow: "整理资料 · 第 2 步",
    title: "检查资料是否齐全",
    subtitle: "查看哪些立面或构件缺少照片、尺寸或授权文件。",
    topStatus: "整理资料",
    panels: [
      panel("资料齐全情况", [row("东、南、北立面齐全 · 西立面资料不足", "已检查"), row("当前状态", "可继续"), row("负责人", "资料管理员")]),
      panel("文件质量和使用权限", [row("模糊照片 2 · 重复文件 4 · 授权待确认 1", "待处理"), row("资料来源", "可查看"), row("下一步", "补齐缺少的资料")])
    ],
    work: { type: "simple", chips: [["资料齐全 86%", "success"], ["缺少 1 个立面", "danger"], ["授权待确认", "warning"], ["文件版本已整理", "info"]], note: "西立面的缺失内容已经列出，可直接查看需要补拍或补测的位置。" },
    actions: [action("返回", "ghost", "go", 6, 1017), action("处理缺少的资料", "primary", "go", 8, 1187)]
  },
  {
    active: 2,
    eyebrow: "整理资料 · 第 3 步",
    title: "补齐缺少的资料",
    subtitle: "先补拍、补测或补文件；无法补齐时说明原因。",
    topStatus: "整理资料",
    panels: [
      panel("缺少的资料", [row("西立面近景 · 檐口实测 · 授权文件", "待处理"), row("当前状态", "需处理"), row("负责人", "资料管理员")]),
      panel("处理方式", [row("安排补拍补测 / 说明无法补齐的原因", "待选择"), row("资料来源", "可查看"), row("下一步", "选择补拍或说明原因")])
    ],
    work: { type: "alert", title: "请先处理缺少的资料", note: "西立面关键构件缺少近景与实测，当前成果不能满足 1:50 精度。" },
    actions: [action("安排补拍补测", "danger", "capture", null, 1017), action("说明原因并继续", "primary", "go", 9, 1187)]
  },
  {
    active: 3,
    eyebrow: "核对构件 · 第 1 步",
    title: "核对识别出的构件",
    subtitle: "检查构件名称、数量、位置和对应照片。",
    topStatus: "核对构件",
    panels: [
      panel("识别到的构件", [row("门窗 18 · 柱 12 · 檐口 4 · 台基 1", "待核对"), row("当前状态", "可继续"), row("负责人", "资料管理员")]),
      panel("资料依据", [row("资料可确认 31 · 需要判断 6 · 待确认 3", "已整理"), row("资料来源", "可查看"), row("下一步", "处理待确认构件")])
    ],
    work: { type: "simple", chips: [["自动识别结果", "ai"], ["已找到对应资料", "success"], ["待确认 3", "warning"]], note: "确认构件名称和对应资料后，再保存到项目中。" },
    actions: [action("返回", "ghost", "go", 8, 1017), action("查看待确认内容", "primary", "go", 10, 1187)]
  },
  {
    active: 3,
    eyebrow: "核对构件 · 第 2 步",
    title: "处理需要人工确认的内容",
    subtitle: "优先检查缺少尺寸、信息冲突和无法确定的构件。",
    topStatus: "核对构件",
    panels: [
      panel("待确认内容", [row("缺少尺寸 2 · 信息冲突 5 · 其他待确认 7", "待确认"), row("当前状态", "可继续"), row("负责人", "资料管理员")]),
      panel("处理要求", [row("缺少尺寸或信息冲突时，需要专业人员确认", "需确认"), row("资料来源", "可查看"), row("下一步", "逐项确认构件信息")])
    ],
    work: { type: "simple", chips: [["优先处理 2", "danger"], ["其次处理 5", "warning"], ["其他待确认 7", "info"]], note: "缺少尺寸依据或构件信息冲突的内容，需要由专业人员确认。" },
    actions: [action("返回", "ghost", "go", 9, 1017), action("确认构件信息", "primary", "go", 11, 1187)]
  },
  {
    active: 3,
    eyebrow: "核对构件 · 第 3 步",
    title: "确认构件信息",
    subtitle: "修改识别结果，填写原因并选择依据。",
    topStatus: "核对构件",
    panels: [
      panel("当前构件", [row("二层西侧木窗（编号 W-017）", "待确认"), row("当前状态", "可继续"), row("负责人", "资料管理员")]),
      panel("修改记录", [row("构件类别 · 尺寸依据 · 对应资料", "已保存"), row("资料来源", "可查看"), row("下一步", "核对实测尺寸和照片")])
    ],
    work: { type: "inputChecks", inputs: [["修改原因", "遮挡导致窗型误判", "依据：西立面补拍照片和实测记录"]], checks: ["保存修改前后的内容", "记录依据和修改人"] },
    actions: [action("返回", "ghost", "go", 10, 1017), action("核对实测尺寸", "primary", "go", 12, 1187)]
  },
  {
    active: 4,
    eyebrow: "记录现状 · 第 1 步",
    title: "核对实测尺寸和照片",
    subtitle: "确认控制点、尺寸精度、照片角度和遮挡范围。",
    topStatus: "记录现状",
    panels: [
      panel("实测尺寸", [row("控制点 12 · 闭合差 3mm", "已核对"), row("当前状态", "可继续"), row("负责人", "资料管理员")]),
      panel("照片检查", [row("照片角度已校正 · 遮挡区域 2", "已完成"), row("资料来源", "可查看"), row("下一步", "记录构件位置和现状")])
    ],
    work: { type: "inputChips", inputs: [["尺度控制点", "CP-03 = 4120 mm", "测量人：周工 · 精度 ±3mm"]], chips: [["照片角度已校正", "success"], ["遮挡区域 2", "warning"], ["可见范围已标出", "info"]] },
    actions: [action("返回", "ghost", "go", 11, 1017), action("记录构件现状", "primary", "go", 13, 1187)]
  },
  {
    active: 4,
    eyebrow: "记录现状 · 第 2 步",
    title: "记录构件位置和现状",
    subtitle: "填写构件位置、连接关系、现场情况和待复查区域。",
    topStatus: "记录现状",
    panels: [
      panel("构件位置与关系", [row("建筑 / 立面 / 构件 / 部位", "已记录"), row("当前状态", "可继续"), row("负责人", "成果负责人")]),
      panel("现状记录", [row("现场可见 28 · 专业判断 9 · 待复查 3", "已保存"), row("资料来源", "可查看"), row("下一步", "制作前检查")])
    ],
    work: { type: "simple", chips: [["构件位置已记录", "success"], ["专业判断 9", "info"], ["待复查区域 3", "warning"]], note: "现场看到的情况、专业判断和待复查内容分别记录。" },
    actions: [action("返回", "ghost", "go", 12, 1017), action("检查能否制作成果", "primary", "go", 14, 1187)]
  },
  {
    active: 4,
    eyebrow: "制作前检查",
    title: "制作前检查",
    subtitle: "确认资料和构件信息齐全后，再制作成果。",
    topStatus: "可以制作",
    panels: [
      panel("检查结果", [row("已确认 39 · 待确认 0 · 暂不能继续 0", "已通过"), row("当前状态", "可继续"), row("负责人", "成果负责人")]),
      panel("人员确认", [row("图纸检查完成 · 专业人员已确认", "已确认"), row("资料来源", "可查看"), row("下一步", "设置图纸样式")])
    ],
    work: { type: "simple", chips: [["已确认 39", "success"], ["待确认 0", "success"], ["暂不能继续 0", "success"]], note: "檐口编号 E-004 已补充尺寸依据并重新检查，现在可以制作成果。" },
    actions: [action("查看已处理项", "danger", "resolved", null, 847), action("返回", "ghost", "go", 13, 1017), action("设置图纸样式", "primary", "go", 15, 1187)]
  },
  {
    active: 5,
    eyebrow: "制作成果 · 第 1 步",
    title: "设置图纸样式",
    subtitle: "选择构件画法、标注、图签和需要附带的表格。",
    topStatus: "制作成果",
    panels: [
      panel("构件画法", [row("木窗、檐口、台基画法已选择", "已选择"), row("当前状态", "可继续"), row("负责人", "成果负责人")]),
      panel("标注和附带文件", [row("尺寸、图签、构件清单、检查表", "已设置"), row("资料来源", "可查看"), row("下一步", "预览并导出成果")])
    ],
    work: { type: "inputChecks", inputs: [["成果比例", "1:50", "规范：上海地区适用版本"]], checks: ["生成构件清单", "生成检查材料"], chips: [["已沿用 84% 的常用设置", "ai"]] },
    actions: [action("返回", "ghost", "go", 14, 1017), action("制作成果", "primary", "go", 16, 1187)]
  },
  {
    active: 5,
    eyebrow: "制作成果 · 第 2 步",
    title: "预览并导出成果",
    subtitle: "检查图纸预览，并选择需要导出的文件格式。",
    topStatus: "制作成果",
    panels: [
      panel("图纸预览", [row("南立面 1:50 · 第 3 版（R03）", "已生成"), row("当前状态", "可继续"), row("负责人", "成果负责人")]),
      panel("导出文件", [row("图纸 DWG / PDF · 构件清单 · 项目数据", "已选择"), row("资料来源", "可查看"), row("下一步", "检查尺寸和位置")])
    ],
    work: { type: "preview", title: "南立面 · 1:50 · 第 3 版", note: "轴网 · 门窗 · 檐口 · 台基 · 标注已更新", chips: [["DWG 已生成", "success"], ["PDF 已生成", "success"], ["构件清单和项目数据", "info"]] },
    actions: [action("返回", "ghost", "go", 15, 1017), action("检查成果", "primary", "go", 17, 1187)]
  },
  {
    active: 6,
    eyebrow: "检查成果 · 第 1 步",
    title: "检查尺寸和位置",
    subtitle: "对照实测记录，检查尺寸、比例和构件位置。",
    topStatus: "检查成果",
    panels: [
      panel("位置检查", [row("轮廓偏差 0 · 位置冲突 1", "发现 1 项"), row("当前状态", "可继续"), row("负责人", "检查负责人")]),
      panel("尺寸检查", [row("超差 2 · 无依据尺寸 0", "需处理"), row("资料来源", "可查看"), row("下一步", "检查图纸内容")])
    ],
    work: { type: "simple", chips: [["位置冲突 1", "danger"], ["尺寸超差 2", "warning"], ["无实测依据尺寸 0", "success"]], note: "每个问题都能打开对应构件、图纸位置和实测依据。" },
    actions: [action("返回", "ghost", "go", 16, 1017), action("检查图纸内容", "primary", "go", 18, 1187)]
  },
  {
    active: 6,
    eyebrow: "检查成果 · 第 2 步",
    title: "检查图纸内容",
    subtitle: "检查图层、标注、版面和缺少的文件。",
    topStatus: "检查成果",
    panels: [
      panel("图纸检查", [row("图层 0 项 · 标注 0 项", "已通过"), row("当前状态", "可继续"), row("负责人", "检查负责人")]),
      panel("文件是否齐全", [row("文件 12 / 12 · 文件信息 12 / 12", "已通过"), row("资料来源", "可查看"), row("下一步", "进入审核")])
    ],
    work: { type: "simple", chips: [["图层命名 0", "success"], ["标注重叠 0", "success"], ["文件信息缺项 0", "success"]], note: "之前发现的 4 个问题已修改并重新检查，现在可以进入审核。" },
    actions: [action("查看已修改问题", "danger", "go", 19, 847), action("返回", "ghost", "go", 17, 1017), action("进入审核", "primary", "go", 20, 1187)]
  },
  {
    active: 6,
    eyebrow: "检查成果 · 修改问题",
    title: "修改检查出的问题",
    subtitle: "打开对应构件、图纸设置或交付信息进行修改。",
    topStatus: "检查成果",
    panels: [
      panel("待修改问题", [row("尺寸重叠 2 · 图层命名 1 · 文件信息 1", "需处理"), row("当前状态", "修改中"), row("负责人", "检查负责人")]),
      panel("需要修改的位置", [row("构件 2 · 图纸设置 1 · 交付信息 1", "已找到"), row("资料来源", "可查看"), row("下一步", "修改后重新检查")])
    ],
    work: { type: "issue", title: "二层西侧木窗：尺寸标注重叠（问题 032）", lines: ["位置：构件 W-017 / 标注设置 05 / 南立面第 3 版", "修改方法：调整标注位置，然后重新检查尺寸和图纸。"] },
    actions: [action("修改构件信息", "ghost", "go", 11, 847), action("修改图纸设置", "danger", "go", 15, 1017), action("重新检查", "primary", "go", 18, 1187)]
  },
  {
    active: 6,
    eyebrow: "检查成果 · 审核确认",
    title: "审核并确认成果",
    subtitle: "检查人员、专业复核人和负责人分别确认。",
    topStatus: "检查成果",
    panels: [
      panel("图纸检查", [row("自动检查完成 · 人工复核通过", "已通过"), row("检查状态", "可继续"), row("负责人", "检查负责人")]),
      panel("专业复核和负责人确认", [row("专业复核已确认 · 负责人待确认", "待确认"), row("资料来源", "可查看"), row("下一步", "设置交付内容")])
    ],
    work: { type: "simple", chips: [["图纸检查通过", "success"], ["专业复核已确认", "success"], ["负责人待确认", "warning"]], note: "最终成果由负责人确认；自动检查只用于辅助核对。" },
    actions: [action("返回", "ghost", "go", 18, 1017), action("确认成果并设置交付", "primary", "confirm", 21, 1187)]
  },
  {
    active: 7,
    eyebrow: "准备交付 · 第 1 步",
    title: "设置交付内容和查看权限",
    subtitle: "选择交付文件，并设置谁可以查看和导出。",
    topStatus: "准备交付",
    panels: [
      panel("交付内容", [row("图纸、构件清单、原始资料和检查记录", "已选择"), row("当前状态", "可继续"), row("负责人", "交付负责人")]),
      panel("查看和导出权限", [row("接收方可查看 · 导出需负责人同意", "已设置"), row("资料来源", "可查看"), row("下一步", "整理交付文件")])
    ],
    work: { type: "checks", checks: ["接收方可查看交付成果", "导出前需要负责人同意", "仅向有权限的人员显示原始资料"], note: "查看和导出设置会随交付文件一起保存。" },
    actions: [action("返回", "ghost", "go", 20, 1017), action("整理交付文件", "primary", "go", 22, 1187)]
  },
  {
    active: 7,
    eyebrow: "准备交付 · 第 2 步",
    title: "检查交付文件",
    subtitle: "确认文件齐全，并能找到对应的原始资料和修改记录。",
    topStatus: "准备交付",
    panels: [
      panel("交付文件清单", [row("图纸和附件 12 · 数据表 4 · 检查记录 3", "已整理"), row("当前状态", "可继续"), row("负责人", "交付负责人")]),
      panel("文件信息和来源", [row("第 3 版（R03）· 原始资料 96 · 修改记录 14", "已整理"), row("资料来源", "可查看"), row("下一步", "完成交付准备")])
    ],
    work: { type: "simple", chips: [["文件 12 / 12", "success"], ["数据表 4 / 4", "success"], ["检查记录 3 / 3", "success"], ["来源记录齐全", "info"]], note: "任一交付文件都能查看原始资料、构件版本、修改记录和负责人。" },
    actions: [action("返回", "ghost", "go", 21, 1017), action("完成交付准备", "primary", "go", 23, 1187)]
  },
  {
    active: 7,
    eyebrow: "准备交付",
    title: "成果已准备好",
    subtitle: "交付文件已经整理完成，等待接收方检查。",
    topStatus: "可以交付",
    panels: [
      panel("准备结果", [row("交付文件已经整理完成", "已完成"), row("当前状态", "可继续"), row("负责人", "交付负责人")]),
      panel("下一步", [row("接收方检查 · 现场项目验证", "待检查"), row("资料来源", "可查看"), row("下一步", "交给接收方检查")])
    ],
    work: { type: "completion", title: "交付文件已准备好", lines: ["已完成：建立任务、整理资料、核对构件、记录现状、制作成果、检查确认和整理交付。", "接下来由接收方检查文件，并在实际项目中核对是否满足需要。"] },
    actions: [action("查看交付文件", "ghost", "delivery", null, 1017), action("回到我的项目", "primary", "go", 2, 1187)]
  }
];

const stage = document.querySelector("#stage");
const toast = document.querySelector("#toast");
const modalRoot = document.querySelector("#modal-root");
const fileInput = document.querySelector("#file-input");

let currentPage = 1;
let toastTimer;
const savedState = JSON.parse(localStorage.getItem("heritageWorkbenchState") || "{}");

function escapeHTML(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

function saveState() {
  localStorage.setItem("heritageWorkbenchState", JSON.stringify(savedState));
}

function chipHTML([label, tone = "info"]) {
  return `<span class="status-chip ${escapeHTML(tone)}">${escapeHTML(label)}</span>`;
}

function sidebarHTML(page) {
  const steps = moduleSteps.map((step, index) => {
    const num = index + 1;
    const top = 109 + index * 60;
    const active = page.active === num ? " active" : "";
    const locked = !step.page ? " locked" : "";
    const target = step.page || "future";
    return `<button class="side-step${active}${locked}" style="top:${top}px" data-go="${target}" aria-current="${active ? "step" : "false"}">
      <span class="num mono">${num}</span><span class="label">${step.label}</span>
    </button>`;
  }).join("");

  return `<aside class="sidebar">
    <p class="sidebar-label">工作步骤</p>
    <button class="side-home${page.active === 0 ? " active" : ""}" data-go="2">我的项目</button>
    ${steps}
    <div class="future-note"><strong class="mono">后续功能</strong><span>比较不同时间的变化</span></div>
  </aside>`;
}

function panelHTML(item, side) {
  const rows = item.rows.map(([main, state]) => `<div class="panel-row">
    <span class="row-main">${escapeHTML(main)}</span><span class="row-state">${escapeHTML(state)}</span>
  </div>`).join("");
  return `<section class="panel ${side}${item.accent ? " accent" : ""}"><h2>${escapeHTML(item.title)}</h2>${rows}</section>`;
}

function inputHTML(pageNumber, item, index) {
  const [label, initial, helper] = item;
  const key = `p${pageNumber}-input-${index}`;
  const value = savedState[key] ?? initial;
  return `<div class="input-field">
    <label for="${key}">${escapeHTML(label)}</label>
    <input id="${key}" data-state-key="${key}" value="${escapeHTML(value)}">
    <small>${escapeHTML(helper)}</small>
  </div>`;
}

function checkboxHTML(pageNumber, label, index) {
  const key = `p${pageNumber}-check-${index}`;
  const checked = savedState[key] !== false;
  return `<button class="checkbox${checked ? " checked" : ""}" data-check-key="${key}" role="checkbox" aria-checked="${checked}">
    <span class="check-box">${checked ? "✓" : ""}</span><span>${escapeHTML(label)}</span>
  </button>`;
}

function workHTML(work, pageNumber) {
  if (work.type === "upload") {
    const count = savedState.uploadCount || 0;
    return `<section class="work-area"><h2>本页要做</h2>
      <button class="upload-zone" data-action="file"><strong>${count ? `已选择 ${count} 个文件` : "拖入文件或选择文件夹"}</strong><span>支持 JPG / PNG / PDF / DWG / XLSX / SHP</span></button>
      <button class="btn secondary work-upload-button" data-action="file">选择文件</button>
    </section>`;
  }

  if (work.type === "alert") {
    return `<section class="work-area"><h2>本页要做</h2><div class="blocking-alert"><strong>${escapeHTML(work.title)}</strong><span>${escapeHTML(work.note)}</span></div></section>`;
  }

  if (work.type === "preview") {
    return `<section class="work-area"><h2>本页要做</h2>
      <div class="drawing-preview"><strong>${escapeHTML(work.title)}</strong><span>${escapeHTML(work.note)}</span></div>
      <div class="preview-chips">${work.chips.map(chipHTML).join("")}</div>
    </section>`;
  }

  if (work.type === "issue") {
    return `<section class="work-area"><h2>本页要做</h2><div class="issue-queue"><strong>${escapeHTML(work.title)}</strong>${work.lines.map(line => `<span>${escapeHTML(line)}</span>`).join("")}</div></section>`;
  }

  if (work.type === "completion") {
    return `<section class="work-area"><h2>本页要做</h2><div class="completion"><strong>${escapeHTML(work.title)}</strong>${work.lines.map(line => `<span>${escapeHTML(line)}</span>`).join("")}</div></section>`;
  }

  if (work.type === "inputChecks" || work.type === "inputChips") {
    const inputs = (work.inputs || []).map((item, index) => inputHTML(pageNumber, item, index)).join("");
    const extras = work.type === "inputChecks"
      ? `<div class="checkboxes">${(work.checks || []).map((label, index) => checkboxHTML(pageNumber, label, index)).join("")}</div>`
      : `<div class="status-row" style="position:static;gap:26px">${(work.chips || []).map(chipHTML).join("")}</div>`;
    const aiChip = work.chips && work.type === "inputChecks" ? `<div class="status-row" style="left:927px">${work.chips.map(chipHTML).join("")}</div>` : "";
    return `<section class="work-area"><h2>本页要做</h2><div class="control-grid">${inputs}${extras}</div>${aiChip}</section>`;
  }

  if (work.type === "checks") {
    const checks = (work.checks || []).map((label, index) => checkboxHTML(pageNumber, label, index)).join("");
    const chip = work.chips?.length ? `<div class="status-row" style="left:897px">${work.chips.map(chipHTML).join("")}</div>` : "";
    return `<section class="work-area"><h2>本页要做</h2><div class="checkboxes">${checks}</div>${chip}${work.note ? `<p class="work-note">${escapeHTML(work.note)}</p>` : ""}</section>`;
  }

  return `<section class="work-area"><h2>本页要做</h2><div class="status-row">${(work.chips || []).map(chipHTML).join("")}</div>${work.note ? `<p class="work-note">${escapeHTML(work.note)}</p>` : ""}</section>`;
}

function actionsHTML(actions) {
  return actions.map((item, index) => `<button class="btn ${escapeHTML(item.style)}" style="left:${item.left}px" data-action-index="${index}">${escapeHTML(item.label)}</button>`).join("");
}

function render(pageNumber = currentPage) {
  currentPage = Math.max(1, Math.min(pages.length, Number(pageNumber) || 1));
  const page = pages[currentPage - 1];
  document.title = `${page.title}｜古建测绘成果工作台`;
  stage.innerHTML = `
    <header class="topbar">
      <div class="brand mono">古建测绘</div>
      <div class="product-name">古建测绘成果工作台</div>
      <div class="project-name">衡复风貌区 · 保护立面成果</div>
      <div class="page-count mono">${currentPage}/23</div>
    </header>
    ${sidebarHTML(page)}
    <p class="eyebrow mono">${escapeHTML(page.eyebrow)}</p>
    <h1 class="page-title">${escapeHTML(page.title)}</h1>
    <p class="page-subtitle">${escapeHTML(page.subtitle)}</p>
    ${panelHTML(page.panels[0], "left")}
    ${panelHTML(page.panels[1], "right")}
    ${workHTML(page.work, currentPage)}
    ${chipHTML([page.topStatus, "info"]).replace('class="status-chip', 'class="status-chip top-status')}
    ${actionsHTML(page.actions)}
  `;

  bindStageEvents(page);
  if (location.hash !== `#page=${currentPage}`) history.replaceState(null, "", `#page=${currentPage}`);
}

function bindStageEvents(page) {
  stage.querySelectorAll("[data-go]").forEach(button => {
    button.addEventListener("click", () => {
      if (button.dataset.go === "future") {
        showToast("后续复查将在后续版本开放");
        return;
      }
      go(Number(button.dataset.go));
    });
  });

  stage.querySelectorAll("[data-action-index]").forEach(button => {
    button.addEventListener("click", () => runAction(page.actions[Number(button.dataset.actionIndex)]));
  });

  stage.querySelectorAll("[data-action='file']").forEach(button => button.addEventListener("click", () => fileInput.click()));

  stage.querySelectorAll("[data-state-key]").forEach(input => {
    input.addEventListener("input", () => {
      savedState[input.dataset.stateKey] = input.value;
      saveState();
    });
  });

  stage.querySelectorAll("[data-check-key]").forEach(button => {
    button.addEventListener("click", () => {
      const key = button.dataset.checkKey;
      savedState[key] = !button.classList.contains("checked");
      saveState();
      render(currentPage);
    });
  });
}

function runAction(item) {
  switch (item.kind) {
    case "go":
      go(item.target);
      break;
    case "file":
      fileInput.click();
      break;
    case "capture":
      openModal("补拍补测安排", "已建立西立面补拍和檐口补测事项。完成后回到本页更新资料状态。", ["西立面关键构件近景", "檐口实测尺寸", "资料使用授权"]);
      break;
    case "resolved":
      openModal("已处理内容", "以下内容已补充依据并重新检查。", ["檐口编号 E-004", "西立面实测控制点", "构件与照片对应关系"]);
      break;
    case "confirm":
      savedState.ownerConfirmed = true;
      saveState();
      showToast("负责人已确认，操作记录已保存");
      window.setTimeout(() => go(item.target), 450);
      break;
    case "delivery":
      openModal("交付文件", "当前交付文件共 19 项，以下内容均已关联来源、版本、修改记录和负责人。", ["图纸和附件 12 项", "数据表 4 项", "检查记录 3 项"]);
      break;
  }
}

function go(pageNumber) {
  currentPage = Math.max(1, Math.min(pages.length, pageNumber));
  location.hash = `page=${currentPage}`;
  render(currentPage);
}

function showToast(message) {
  window.clearTimeout(toastTimer);
  toast.textContent = message;
  toast.classList.add("show");
  toastTimer = window.setTimeout(() => toast.classList.remove("show"), 2200);
}

function openModal(title, text, items = []) {
  modalRoot.innerHTML = `<div class="modal-backdrop" role="presentation">
    <section class="modal" role="dialog" aria-modal="true" aria-labelledby="modal-title">
      <h2 id="modal-title">${escapeHTML(title)}</h2>
      <p>${escapeHTML(text)}</p>
      ${items.length ? `<ul>${items.map(item => `<li>${escapeHTML(item)}</li>`).join("")}</ul>` : ""}
      <button class="btn primary" data-close-modal>关闭</button>
    </section>
  </div>`;
  modalRoot.querySelector("[data-close-modal]").addEventListener("click", closeModal);
  modalRoot.querySelector(".modal-backdrop").addEventListener("click", event => {
    if (event.target.classList.contains("modal-backdrop")) closeModal();
  });
}

function closeModal() {
  modalRoot.innerHTML = "";
}

function fitStage() {
  const scale = Math.min(window.innerWidth / 1440, window.innerHeight / 900);
  stage.style.transform = `scale(${scale})`;
}

fileInput.addEventListener("change", () => {
  savedState.uploadCount = fileInput.files.length;
  saveState();
  showToast(`已选择 ${fileInput.files.length} 个文件`);
  render(currentPage);
});

window.addEventListener("resize", fitStage);
window.addEventListener("hashchange", () => {
  const match = location.hash.match(/page=(\d+)/);
  if (match) render(Number(match[1]));
});

window.addEventListener("keydown", event => {
  if (event.key === "Escape") closeModal();
  if (["INPUT", "TEXTAREA"].includes(document.activeElement?.tagName)) return;
  if (event.key === "ArrowLeft" && currentPage > 1) go(currentPage - 1);
  if (event.key === "ArrowRight" && currentPage < pages.length) go(currentPage + 1);
});

if ("serviceWorker" in navigator && location.protocol.startsWith("http")) {
  navigator.serviceWorker.register("./sw.js").catch(() => {});
}

const initial = Number((location.hash.match(/page=(\d+)/) || [])[1]) || 1;
fitStage();
render(initial);
