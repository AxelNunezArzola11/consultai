import { z } from "zod";

import type { VerificationContext } from "@/lib/delivery/verifier";
import type { CriterionResult, PolicyFlag, PolicyOutput } from "@/lib/delivery/policy-engine";
import type { LlmStepResult } from "@/lib/delivery/llm-step";

const jsonValue = z.unknown();

export const DeliveryWorkflowInputSchema = z.object({
  prUrl: z.string().url(),
  expectedAuthor: z.string().optional(),
  criteria: z.array(z.unknown()),
  amountUsd: z.number().nonnegative(),
});
export type DeliveryWorkflowInput = z.infer<typeof DeliveryWorkflowInputSchema>;

export const VerificationContextSchema = z.custom<VerificationContext>(
  (value) => typeof value === "object" && value !== null,
  "Expected fetched GitHub verification context"
);
export const CriterionResultsSchema = z.custom<CriterionResult[]>(
  (value) => Array.isArray(value),
  "Expected criterion results"
);
export const FlagsSchema = z.custom<PolicyFlag[]>(
  (value) => Array.isArray(value),
  "Expected policy flags"
);
export const LlmStepResultSchema = z.custom<LlmStepResult>(
  (value) => typeof value === "object" && value !== null,
  "Expected LLM step result"
);
export const PolicyOutputSchema = z.custom<PolicyOutput>(
  (value) => typeof value === "object" && value !== null,
  "Expected policy output"
);

export const DeliveryWorkflowResultSchema = z.object({
  headSha: z.string(),
  flags: z.array(z.string()),
  objectiveResults: z.array(jsonValue),
  llm: jsonValue,
  policy: jsonValue,
});
export type DeliveryWorkflowResult = z.infer<typeof DeliveryWorkflowResultSchema>;
