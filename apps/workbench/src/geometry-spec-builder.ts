import type { ProjectHead } from "@gujian/application";
import {
  GeometryInterfaceSchema,
  ProjectDrivenGeometrySpecSchema,
  ProjectGeometryObjectSchema,
  type FactEnvelope,
  type ProjectDrivenGeometrySpec,
  type ProjectGeometryObject,
} from "@gujian/domain";
import { recordHash } from "@gujian/infrastructure";
import { z } from "zod";

export const EvidenceGeometryComponentValueSchema = ProjectGeometryObjectSchema.omit({
  id: true,
  parentId: true,
  producer: true,
  factRefs: true,
  evidenceRefs: true,
  unknownRefs: true,
}).extend({
  parentStableKey: z.string().min(1).max(200).nullable(),
  sourceLocation: z.string().min(1).max(500),
  evidenceRefs: z.array(z.string().min(1)).min(1).max(500),
  unknowns: z.array(z.object({
    reasonCode: z.string().min(1).max(120),
    description: z.string().min(1).max(2_000),
    requiredEvidence: z.array(z.string().min(1).max(300)).min(1).max(100),
    affectedStableKeys: z.array(z.string().min(1).max(200)).min(1).max(1_000),
    blocksProxyOutcome: z.boolean(),
    blocksFormalEligibility: z.boolean(),
  }).strict()).max(100),
}).strict();

export const EvidenceGeometryInterfaceValueSchema = GeometryInterfaceSchema.omit({
  id: true,
  fromObjectId: true,
  toObjectId: true,
  factRefs: true,
  evidenceRefs: true,
}).extend({
  fromStableKey: z.string().min(1).max(200),
  toStableKey: z.string().min(1).max(200),
  sourceLocation: z.string().min(1).max(500),
  evidenceRefs: z.array(z.string().min(1)).min(1).max(500),
}).strict();

interface ParsedFact<T> {
  fact: FactEnvelope;
  value: T;
}

function geometryFacts<T>(head: ProjectHead, prefix: string, schema: z.ZodType<T>): ParsedFact<T>[] {
  const latest = new Map<string, FactEnvelope>();
  for (const fact of head.snapshot.facts) {
    if (fact.field.startsWith(prefix) && fact.reviewStatus === "confirmed" && fact.dataStatus === "available") latest.set(fact.field, fact);
  }
  return [...latest.values()].map((fact) => ({ fact, value: schema.parse(fact.value) }));
}

function evidenceClosure(head: ProjectHead, fact: FactEnvelope, refs: readonly string[]): void {
  const projectEvidence = new Set(head.snapshot.evidences.map((item) => item.id));
  const envelopeEvidence = new Set(fact.evidenceRefs);
  const missingFromFact = refs.filter((ref) => !envelopeEvidence.has(ref));
  const missingFromProject = refs.filter((ref) => !projectEvidence.has(ref));
  if (missingFromFact.length) throw new Error(`GEOMETRY_FACT_EVIDENCE_CLOSURE_MISSING:${fact.field}:${missingFromFact.join(",")}`);
  if (missingFromProject.length) throw new Error(`GEOMETRY_PROJECT_EVIDENCE_MISSING:${fact.field}:${missingFromProject.join(",")}`);
}

export function geometryPrerequisites(head: ProjectHead): { ready: boolean; missing: string[]; facts: Map<string, FactEnvelope> } {
  const task = head.snapshot.taskDefinitions.find((item) => item.confirmedAt !== null);
  const componentFacts = geometryFacts(head, "geometry.component.", EvidenceGeometryComponentValueSchema);
  const facts = new Map(componentFacts.map(({ fact }) => [fact.field, fact]));
  const missing: string[] = [];
  if (!task?.artifactRequirements) missing.push("task.artifactRequirements");
  if (!componentFacts.length) missing.push("geometry.component.*");
  const availableTypes = componentFacts.map(({ value }) => value.componentType);
  for (const role of task?.artifactRequirements?.geometryTargetRoles ?? []) {
    if (!availableTypes.some((type) => type === role || type.startsWith(`${role}:`))) missing.push(`geometry.role.${role}`);
  }
  return { ready: missing.length === 0, missing, facts };
}

function priorIds(head: ProjectHead): Map<string, string> {
  const latest = head.snapshot.geometrySpecs.at(-1);
  return new Map(latest?.objects.map((item) => [item.stableKey, item.id]) ?? []);
}

export function buildProjectGeometrySpec(head: ProjectHead, ruleRunId: string): ProjectDrivenGeometrySpec {
  const prerequisite = geometryPrerequisites(head);
  if (!prerequisite.ready) throw new Error(`GEOMETRY_EVIDENCE_FACTS_MISSING:${prerequisite.missing.join(",")}`);
  const componentFacts = geometryFacts(head, "geometry.component.", EvidenceGeometryComponentValueSchema);
  const interfaceFacts = geometryFacts(head, "geometry.interface.", EvidenceGeometryInterfaceValueSchema);
  const previous = priorIds(head);
  const ids = new Map(componentFacts.map(({ value }) => [value.stableKey, previous.get(value.stableKey) ?? crypto.randomUUID()]));
  if (ids.size !== componentFacts.length) throw new Error("GEOMETRY_STABLE_KEYS_NOT_UNIQUE");
  const producer = { producerType: "rule" as const, ruleRunId };
  const unknowns: ProjectDrivenGeometrySpec["unknowns"] = [];

  const objects: ProjectGeometryObject[] = componentFacts.map(({ fact, value }) => {
    evidenceClosure(head, fact, value.evidenceRefs);
    const parentId = value.parentStableKey === null ? null : ids.get(value.parentStableKey);
    if (value.parentStableKey !== null && !parentId) throw new Error(`GEOMETRY_PARENT_COMPONENT_MISSING:${value.stableKey}:${value.parentStableKey}`);
    const localUnknowns = value.unknowns.map((unknown) => {
      const affectedRefs = unknown.affectedStableKeys.map((key) => ids.get(key)).filter((id): id is string => Boolean(id));
      if (affectedRefs.length !== unknown.affectedStableKeys.length) throw new Error(`GEOMETRY_UNKNOWN_AFFECTED_COMPONENT_MISSING:${value.stableKey}`);
      return {
        id: crypto.randomUUID(),
        subjectRef: ids.get(value.stableKey)!,
        reasonCode: unknown.reasonCode,
        description: unknown.description,
        requiredEvidence: unknown.requiredEvidence,
        affectedRefs,
        evidenceRefs: value.evidenceRefs,
        blocksProxyOutcome: unknown.blocksProxyOutcome,
        blocksFormalEligibility: unknown.blocksFormalEligibility,
      };
    });
    unknowns.push(...localUnknowns);
    if (/unknown/i.test(value.materialCode) && !localUnknowns.length) throw new Error(`GEOMETRY_UNKNOWN_MATERIAL_NOT_DECLARED:${value.stableKey}`);
    return {
      id: ids.get(value.stableKey)!,
      stableKey: value.stableKey,
      parentId: parentId ?? null,
      componentType: value.componentType,
      displayNameZh: value.displayNameZh,
      materialCode: value.materialCode,
      solid: value.solid,
      parameters: [
        ...value.parameters,
        {
          id: crypto.randomUUID(),
          name: "evidenceSourceLocation",
          valueType: "text" as const,
          value: value.sourceLocation,
          unit: "1" as const,
          basis: "human" as const,
          factRefs: [fact.id],
          evidenceRefs: value.evidenceRefs,
        },
      ],
      producer,
      factRefs: [fact.id],
      evidenceRefs: value.evidenceRefs,
      unknownRefs: localUnknowns.map((item) => item.id),
    };
  });

  const interfaces = interfaceFacts.map(({ fact, value }) => {
    evidenceClosure(head, fact, value.evidenceRefs);
    const fromObjectId = ids.get(value.fromStableKey);
    const toObjectId = ids.get(value.toStableKey);
    if (!fromObjectId || !toObjectId) throw new Error(`GEOMETRY_INTERFACE_COMPONENT_MISSING:${value.fromStableKey}:${value.toStableKey}`);
    return {
      id: crypto.randomUUID(),
      fromObjectId,
      toObjectId,
      interfaceType: value.interfaceType,
      fromSurface: value.fromSurface,
      toSurface: value.toSurface,
      direction: value.direction,
      maximumGapMm: value.maximumGapMm,
      maximumUnexpectedOverlapMm3: value.maximumUnexpectedOverlapMm3,
      minimumDeclaredOverlapMm3: value.minimumDeclaredOverlapMm3,
      factRefs: [fact.id],
      evidenceRefs: value.evidenceRefs,
    };
  });

  const spec: ProjectDrivenGeometrySpec = {
    schemaVersion: "2.0",
    id: crypto.randomUUID(),
    projectId: head.projectId,
    projectRevisionId: head.revisionId,
    buildingId: head.snapshot.buildings[0]!.id,
    inputHash: "0".repeat(64),
    coordinateSystem: { name: "项目局部坐标", axisOrder: "XYZ", upAxis: "Z", lengthUnit: "mm", origin: [0, 0, 0] },
    tolerances: { modellingMm: 0.01, interfaceMm: 0.5, tessellationMm: 0.5 },
    objects,
    interfaces,
    unknowns,
    createdAt: new Date().toISOString(),
  };
  return ProjectDrivenGeometrySpecSchema.parse({ ...spec, inputHash: recordHash({ ...spec, inputHash: "0".repeat(64) }) });
}
