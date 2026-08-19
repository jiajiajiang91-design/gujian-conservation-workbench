import type { ProjectCommandService, ProjectHead } from "@gujian/application";
import type { ProjectDrivenGeometrySpec } from "@gujian/domain";

import { buildArtifactMatrix } from "../artifact-matrix-builder.js";
import type { CadJobClient } from "../cad-job-client.js";
import type { DeliveryService } from "../delivery-service.js";
import type { DrawingJobClient } from "../drawing-job-client.js";
import type { IndexedDbProjectRepository } from "../indexeddb-project-repository.js";
import { exportDemoProject, seedDemoProject, type DemoBuildResult } from "./build-demo-project.js";
import type { DemoProjectDefinition } from "./definitions.js";

// 演示项目的完整链路：从任务书一路跑到交付草案，走产品自身的命令服务与
// 真实作业进程，不为演示另做一套。08 演示项目定义要求每个环节都有产出，
// 任一环节空缺即为演示不成立。

export interface DemoPipeline {
  readonly commands: ProjectCommandService;
  readonly cadJobs: CadJobClient;
  readonly drawingJobs: DrawingJobClient;
  readonly deliveries: DeliveryService;
  // 几何来源由调用方决定：形制生成器产出，或由已验收成果翻译得到。
  // 返回 null 表示本项目本轮不出三维，链路在此停住但前面的环节照常保留。
  readonly geometrySpec: (head: ProjectHead) => ProjectDrivenGeometrySpec | null;
  readonly geometrySourceZh: string;
  readonly onStage?: (stageZh: string) => void;
  readonly onMatrix?: (matrix: ReturnType<typeof buildArtifactMatrix>) => void;
}

export interface FullDemoBuildInput {
  readonly definition: DemoProjectDefinition;
  readonly files: ReadonlyMap<string, Uint8Array>;
  readonly repository: IndexedDbProjectRepository;
  readonly pipeline: DemoPipeline;
}

export interface FullDemoBuildResult extends DemoBuildResult {
  readonly demoId: string;
  readonly artifactCount: number;
  readonly checkRunCount: number;
  readonly deliveryCount: number;
  readonly stagesCompleted: readonly string[];
}

export async function buildFullDemoProject(input: FullDemoBuildInput): Promise<FullDemoBuildResult> {
  const { definition, repository, pipeline } = input;
  const stages: string[] = [];
  const mark = (stageZh: string) => {
    stages.push(stageZh);
    pipeline.onStage?.(stageZh);
  };

  const seeded = await seedDemoProject({ definition, files: input.files, repository });
  mark("任务书、资料与尺寸事实");

  const readHead = async (): Promise<ProjectHead> => {
    const head = await repository.getProjectHead(seeded.projectId);
    if (!head) throw new Error("PROJECT_NOT_FOUND_AFTER_DEMO_COMMAND");
    return head;
  };

  let head = await readHead();
  const spec = pipeline.geometrySpec(head);
  if (!spec) {
    const partial = await exportDemoProject(repository, seeded);
    return {
      ...partial, demoId: definition.demoId,
      artifactCount: 0, checkRunCount: 0, deliveryCount: 0, stagesCompleted: stages,
    };
  }

  const geometry = await pipeline.cadJobs.startGeometry(
    head, seeded.actorId,
    () => { /* 进度由调用方通过 onStage 观察，这里不打断链路 */ },
    { mode: "providedSpec", geometrySpec: spec, sourceZh: pipeline.geometrySourceZh },
  );
  head = geometry.head;
  mark("三维模型");

  const boundSpec = head.snapshot.geometrySpecs.find((item) => item.id === geometry.revision.geometrySpecId);
  if (!boundSpec) throw new Error("GEOMETRY_SPEC_NOT_FOUND_IN_PROJECT");
  const matrix = buildArtifactMatrix(head, geometry.revision, boundSpec);
  pipeline.onMatrix?.(matrix);
  const drawn = await input.pipeline.drawingJobs.generate(
    head, seeded.actorId, geometry.revision, matrix,
    () => { /* 同上 */ },
  );
  head = drawn.head;
  mark("成组图纸与检查记录");

  await pipeline.deliveries.createProxyDraft(
    head, seeded.actorId, geometry.revision, drawn.artifacts, drawn.checkRun,
  );
  mark("代理交付草案");

  const exported = await exportDemoProject(repository, seeded);
  const final = await readHead();
  return {
    ...exported,
    demoId: definition.demoId,
    artifactCount: (await repository.getProjectArtifacts(seeded.projectId)).length,
    checkRunCount: (await repository.getProjectCheckRuns(seeded.projectId)).length,
    deliveryCount: (await repository.getProjectDeliveries(seeded.projectId)).length,
    geometryRevisionCount: final.snapshot.geometryRevisions.length,
    geometryObjectCount: boundSpec.objects.length,
    stagesCompleted: stages,
  };
}
