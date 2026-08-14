import { ProjectCommandService, type ProjectHead, type ProjectSummary } from "@gujian/application";
import { EvidenceIngestionService, IndexedDbProjectRepository, LocalAuthorization, ProjectPackageService, WorkflowService } from "@gujian/infrastructure";

import { ModelRunClient } from "./model-run-client";
import { CadJobClient } from "./cad-job-client";
import { DrawingJobClient } from "./drawing-job-client";
import { DeliveryService } from "./delivery-service";

export const projectRepository = new IndexedDbProjectRepository();
export const projectCommands = new ProjectCommandService({
  repository: projectRepository,
  authorization: new LocalAuthorization(),
});
export const projectPackages = new ProjectPackageService(projectRepository);
export const evidenceIngestion = new EvidenceIngestionService(projectRepository);
export const modelRuns = new ModelRunClient({ repository: projectRepository, commands: projectCommands });
export const cadJobs = new CadJobClient({ repository: projectRepository, commands: projectCommands });
export const drawingJobs = new DrawingJobClient({ repository: projectRepository, commands: projectCommands });
export const deliveries = new DeliveryService({ repository: projectRepository, commands: projectCommands });
export const workflow = new WorkflowService(projectRepository);

const ACTOR_KEY = "gujian-workbench-v3:local-actor-id";

export function localActorId(): string {
  const existing = localStorage.getItem(ACTOR_KEY);
  if (existing) return existing;
  const created = crypto.randomUUID();
  localStorage.setItem(ACTOR_KEY, created);
  return created;
}

export async function createLocalProject(input: {
  name: string;
  buildingName: string;
  locationText: string;
}): Promise<ProjectHead> {
  const projectId = crypto.randomUUID();
  const actorId = localActorId();
  const now = new Date().toISOString();
  await projectCommands.execute({
    commandType: "CreateProject",
    commandId: crypto.randomUUID(),
    projectId,
    actorId,
    expectedRevisionId: null,
    issuedAt: now,
    payload: {
      project: {
        id: projectId,
        name: input.name,
        status: "active",
        locationText: input.locationText || null,
        createdAt: now,
      },
      building: {
        id: crypto.randomUUID(),
        projectId,
        name: input.buildingName,
        periodText: null,
        addressText: input.locationText || null,
        status: "existing",
      },
    },
  });
  const head = await projectRepository.getProjectHead(projectId);
  if (!head) throw new Error("项目创建后未能读取");
  return head;
}

export async function listLocalProjects(): Promise<readonly ProjectSummary[]> {
  return projectRepository.listProjects();
}
