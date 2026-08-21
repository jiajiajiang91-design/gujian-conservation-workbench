// 08 演示项目定义表 3 的七步演示路径。任一格演不出内容即为演示不成立，
// 因此把"哪一格看哪份数据"写成一份可执行的清单，构建完的包逐格核对。
//
// 这里只判断有没有内容，不判断内容对不对。内容质量由质量基准那套标准管。

export interface DemoCellSource {
  readonly stepZh: string;
  readonly viewZh: string;
  // 项目包里支撑这一格的数据位置。任一条非空即算有内容。
  readonly dataPaths: readonly string[];
}

export const DEMO_MATRIX_STEPS: readonly DemoCellSource[] = [
  { stepZh: "一", viewZh: "任务卡", dataPaths: ["snapshot.taskDefinitions"] },
  { stepZh: "二", viewZh: "资料清单", dataPaths: ["snapshot.evidences"] },
  { stepZh: "三", viewZh: "实测基准", dataPaths: ["snapshot.facts", "snapshot.measurements"] },
  { stepZh: "四", viewZh: "构件清单", dataPaths: ["snapshot.geometrySpecs[].objects", "snapshot.entities"] },
  { stepZh: "五", viewZh: "三维模型", dataPaths: ["snapshot.geometryRevisions"] },
  { stepZh: "六", viewZh: "图纸与检查", dataPaths: ["artifacts", "checkRuns"] },
  { stepZh: "七", viewZh: "交付包", dataPaths: ["deliveries"] },
];

type Unknown = Record<string, unknown>;

function readPath(root: Unknown, path: string): unknown[] {
  // 支持 a.b、a[].c 两种写法，后者对数组逐项取下一段再摊平
  let current: unknown[] = [root];
  for (const rawSegment of path.split(".")) {
    const spread = rawSegment.endsWith("[]");
    const segment = spread ? rawSegment.slice(0, -2) : rawSegment;
    const next: unknown[] = [];
    for (const item of current) {
      if (item === null || typeof item !== "object") continue;
      const value = (item as Unknown)[segment];
      if (value === undefined || value === null) continue;
      next.push(value);
    }
    current = spread ? next.flatMap((item) => (Array.isArray(item) ? item : [item])) : next;
  }
  return current;
}

function isPopulated(value: unknown): boolean {
  if (Array.isArray(value)) return value.length > 0;
  if (value === null || value === undefined) return false;
  if (typeof value === "string") return value.trim().length > 0;
  return true;
}

export interface DemoMatrixCell {
  readonly stepZh: string;
  readonly viewZh: string;
  readonly filled: boolean;
  readonly counts: Readonly<Record<string, number>>;
}

// 对一个已导出的项目包内容逐格核对。传入的是包里 project.json 解析后的对象。
export function evaluateDemoMatrix(projectPackage: unknown): DemoMatrixCell[] {
  const root = (projectPackage ?? {}) as Unknown;
  return DEMO_MATRIX_STEPS.map((step) => {
    const counts: Record<string, number> = {};
    let filled = false;
    for (const path of step.dataPaths) {
      const values = readPath(root, path);
      const total = values.reduce<number>(
        (sum, value) => sum + (Array.isArray(value) ? value.length : isPopulated(value) ? 1 : 0),
        0,
      );
      counts[path] = total;
      if (total > 0) filled = true;
    }
    return { stepZh: step.stepZh, viewZh: step.viewZh, filled, counts };
  });
}
