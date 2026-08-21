import type { Observation } from './project'
import type { FormalBlockerCode, FormalEligibility } from './provenance'

export interface EligibilityDecision {
  actorRole: string
}

export interface EligibilityContext {
  evidenceIds: ReadonlySet<string>
  modelRunIds: ReadonlySet<string>
  ruleRunIds: ReadonlySet<string>
  decisions: ReadonlyMap<string, EligibilityDecision>
  requiredRole?: string
}

export function evaluateFormalEligibility(
  fact: Observation,
  context: EligibilityContext,
  evaluatedAt: string,
  policyVersion = 'formal-v1',
): FormalEligibility {
  const blockers = new Set<FormalBlockerCode>()

  if (fact.producer.producerType === 'demo') blockers.add('DEMO_SOURCE')
  if (
    fact.evidenceRefs.length === 0 ||
    fact.evidenceRefs.some((evidenceRef) => !context.evidenceIds.has(evidenceRef))
  ) {
    blockers.add('EVIDENCE_MISSING')
  }
  if (fact.reviewStatus !== 'confirmed') blockers.add('REVIEW_REQUIRED')
  if (fact.dataStatus !== 'available') blockers.add('DATA_UNAVAILABLE')

  if (
    fact.producer.producerType === 'model' &&
    !context.modelRunIds.has(fact.producer.runId)
  ) {
    blockers.add('MODEL_RUN_MISSING')
  }
  if (
    fact.producer.producerType === 'rule' &&
    !context.ruleRunIds.has(fact.producer.ruleRunId)
  ) {
    blockers.add('RULE_INPUT_INELIGIBLE')
  }

  if (fact.observationType === 'measurement') {
    const originalIsPresent = context.evidenceIds.has(fact.originalEvidenceRef)
    if (!originalIsPresent) blockers.add('MEASUREMENT_RECORD_MISSING')
  }

  const decisionRefs = new Set(fact.reviewDecisionRefs)
  if (fact.producer.producerType === 'human') {
    decisionRefs.add(fact.producer.decisionId)
  }
  if (
    fact.reviewStatus === 'confirmed' &&
    fact.producer.producerType !== 'rule' &&
    decisionRefs.size === 0
  ) {
    blockers.add('REVIEW_REQUIRED')
  }
  if (
    context.requiredRole &&
    ![...decisionRefs].some(
      (decisionId) => context.decisions.get(decisionId)?.actorRole === context.requiredRole,
    )
  ) {
    blockers.add('ROLE_MISMATCH')
  }

  return {
    eligible: blockers.size === 0,
    blockerCodes: [...blockers],
    policyVersion,
    evaluatedAt,
  }
}
