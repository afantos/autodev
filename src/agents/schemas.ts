import { z } from 'zod';

export const PlanTicketSchema = z.object({
  key: z.string().describe('Short local key like T1, T2 used for dependency references'),
  title: z.string(),
  objective: z.string(),
  problem: z.string().describe('User or business problem this ticket solves'),
  technicalContext: z.string().describe('Existing code, patterns and modules to use; why'),
  acceptanceCriteria: z.array(z.string()).min(1),
  testing: z.array(z.string()).min(1).describe('Concrete tests to write/run'),
  dependsOn: z.array(z.string()).describe('Keys of tickets that must be merged first'),
  priority: z.number().int().min(1).max(4).describe('1 urgent … 4 low'),
  complexity: z.number().int().min(1).max(5),
  relevantFiles: z.array(z.string()),
  security: z.string().describe('Security / architectural considerations, or "none"'),
  definitionOfDone: z.array(z.string()).min(1),
  parallelizable: z.boolean(),
});

export const PlanSchema = z.object({
  projectKey: z.string(),
  summary: z.string(),
  approach: z.string().describe('Proposed implementation approach grounded in the actual codebase'),
  reuse: z.array(z.string()).describe('Existing functionality to reuse, with file paths'),
  requirements: z.array(z.string()),
  risks: z.array(z.string()),
  openQuestions: z.array(z.object({ question: z.string(), options: z.array(z.string()), recommendation: z.string(), blocking: z.boolean() })),
  duplicates: z.array(z.object({ existingIdentifier: z.string(), relation: z.enum(['duplicate', 'overlaps', 'already_done', 'shared_dependency']), note: z.string() })),
  tickets: z.array(PlanTicketSchema).min(1),
});
export type Plan = z.infer<typeof PlanSchema>;
export type PlanTicket = z.infer<typeof PlanTicketSchema>;

export const CodingResultSchema = z.object({
  status: z.enum(['completed', 'blocked', 'failed']),
  summary: z.string().describe('What was implemented and how'),
  filesChanged: z.array(z.string()),
  testsAdded: z.array(z.string()),
  commandsRun: z.array(z.object({ command: z.string(), passed: z.boolean() })),
  decisions: z.array(z.string()).describe('Technical decisions taken, briefly'),
  knownLimitations: z.array(z.string()),
  blocker: z.string().optional().describe('If blocked/failed: what is needed'),
});
export type CodingResult = z.infer<typeof CodingResultSchema>;

export const AUTO_CATEGORIES = ['existing_component', 'architecture_pattern', 'approved_dependency', 'internal_structure', 'validation', 'test_organization', 'implementation_tradeoff'] as const;
export const HUMAN_CATEGORIES = ['product_behavior', 'billing_pricing', 'auth_policy', 'privacy_compliance', 'architecture_change', 'paid_service', 'destructive_data', 'production_deploy', 'feature_removal', 'new_dependency', 'other'] as const;

export const DecisionSchema = z.object({
  category: z.enum([...AUTO_CATEGORIES, ...HUMAN_CATEGORIES]),
  options: z.array(z.object({ name: z.string(), pros: z.array(z.string()), cons: z.array(z.string()) })).min(1),
  recommendation: z.string(),
  reasoning: z.string(),
  evidence: z.array(z.string()).describe('File paths, existing decisions, docs or URLs that support the recommendation'),
  confidence: z.number().min(0).max(1),
  requiresHuman: z.boolean(),
  significantArchitecture: z.boolean().describe('True if this deserves an ADR'),
});
export type Decision = z.infer<typeof DecisionSchema>;

export const ReviewSchema = z.object({
  outcome: z.enum(['approved', 'changes_requested', 'blocked', 'failed_validation']),
  summary: z.string(),
  acceptanceCriteria: z.array(z.object({ criterion: z.string(), met: z.boolean(), evidence: z.string() })),
  findings: z.array(z.object({
    severity: z.enum(['critical', 'major', 'minor', 'nit']),
    file: z.string(), line: z.number().int().optional(),
    issue: z.string(), suggestion: z.string(),
  })),
  followUps: z.array(z.object({ title: z.string(), description: z.string() })).describe('Out-of-scope improvements to propose as Backlog tickets'),
  blockingQuestion: z.string().optional(),
});
export type Review = z.infer<typeof ReviewSchema>;

export function jsonSchema(s: z.ZodType): Record<string, unknown> {
  const js = z.toJSONSchema(s, { target: 'draft-7' }) as Record<string, unknown>;
  delete js.$schema;
  return js;
}
