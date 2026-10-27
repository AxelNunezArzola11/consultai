import { task, type TaskContext } from "@renderinc/sdk/workflows";

import {
  fetchCheckRuns,
  fetchPRDetails,
  fetchPRFiles,
  fetchPRReviews,
  parsePrUrl,
  validateRepo,
} from "@/lib/delivery/github-client";
import {
  detectFlags,
  verifyObjectiveCriteria,
  type AcceptanceCriterion,
  type VerificationContext,
} from "@/lib/delivery/verifier";
import { runLlmStep } from "@/lib/delivery/llm-step";
import { evaluatePolicy, getAutoReleaseLimitUsd } from "@/lib/delivery/policy-engine";
import {
  CriterionResultsSchema,
  DeliveryWorkflowInputSchema,
  DeliveryWorkflowResultSchema,
  FlagsSchema,
  LlmStepResultSchema,
  PolicyOutputSchema,
  VerificationContextSchema,
  type DeliveryWorkflowInput,
} from "./schemas";

const fetchDeliveryContext = task(
  {
    name: "fetchDeliveryContext",
    retry: { maxRetries: 2, waitDurationMs: 1000, backoffScaling: 2 },
    timeoutSeconds: 60,
    plan: "flex",
  },
  async (_ctx: TaskContext, input: DeliveryWorkflowInput): Promise<VerificationContext> => {
    const parsed = DeliveryWorkflowInputSchema.parse(input);
    const prRef = parsePrUrl(parsed.prUrl);
    validateRepo(prRef.owner, prRef.repo);
    const [pr, files, reviews] = await Promise.all([
      fetchPRDetails(prRef.owner, prRef.repo, prRef.number),
      fetchPRFiles(prRef.owner, prRef.repo, prRef.number),
      fetchPRReviews(prRef.owner, prRef.repo, prRef.number),
    ]);
    const checkRuns = await fetchCheckRuns(prRef.owner, prRef.repo, pr.headSha);
    return VerificationContextSchema.parse({ pr, files, checkRuns, reviews, expectedAuthor: parsed.expectedAuthor });
  },
);

const runObjectiveChecks = task(
  { name: "runObjectiveChecks", timeoutSeconds: 30, plan: "flex" },
  async (_ctx: TaskContext, input: { criteria: AcceptanceCriterion[]; context: VerificationContext }) => {
    const parsedContext = VerificationContextSchema.parse(input.context);
    const results = verifyObjectiveCriteria(input.criteria, parsedContext);
    return CriterionResultsSchema.parse(results);
  },
);

const runFlags = task(
  { name: "runFlags", timeoutSeconds: 30, plan: "flex" },
  async (_ctx: TaskContext, context: VerificationContext) =>
    FlagsSchema.parse(detectFlags(VerificationContextSchema.parse(context))),
);

const runLlmEvaluation = task(
  {
    name: "runLlmEvaluation",
    retry: { maxRetries: 2, waitDurationMs: 1500, backoffScaling: 2 },
    timeoutSeconds: 90,
    plan: "flex",
  },
  async (
    _ctx: TaskContext,
    input: { criteria: AcceptanceCriterion[]; objectiveResults: ReturnType<typeof verifyObjectiveCriteria>; context: VerificationContext },
  ) => LlmStepResultSchema.parse(
    await runLlmStep(input.criteria, input.objectiveResults, VerificationContextSchema.parse(input.context)),
  ),
);

const runPolicy = task(
  { name: "runPolicy", timeoutSeconds: 30, plan: "flex" },
  async (_ctx: TaskContext, input: {
    criteriaResults: ReturnType<typeof verifyObjectiveCriteria>;
    flags: ReturnType<typeof detectFlags>;
    amountUsd: number;
    shaMatches: boolean;
  }) => PolicyOutputSchema.parse(evaluatePolicy({
    criteriaResults: input.criteriaResults,
    flags: input.flags,
    amountUsd: input.amountUsd,
    autoReleaseLimitUsd: getAutoReleaseLimitUsd(),
    shaMatches: input.shaMatches,
  })),
);

export const verifyDelivery = task(
  { name: "verifyDelivery", timeoutSeconds: 180, plan: "flex" },
  async (ctx: TaskContext, input: DeliveryWorkflowInput) => {
    const parsed = DeliveryWorkflowInputSchema.parse(input);
    const criteria = parsed.criteria as AcceptanceCriterion[];
    const context = await ctx.run(fetchDeliveryContext, parsed);
    const [objectiveResults, flags] = await Promise.all([
      ctx.run(runObjectiveChecks, { criteria, context }),
      ctx.run(runFlags, context),
    ]);
    const llm = await ctx.run(runLlmEvaluation, { criteria, objectiveResults, context });
    const policy = await ctx.run(runPolicy, {
      criteriaResults: objectiveResults,
      flags,
      amountUsd: parsed.amountUsd,
      shaMatches: true,
    });
    return DeliveryWorkflowResultSchema.parse({
      headSha: context.pr.headSha,
      flags,
      objectiveResults,
      llm,
      policy,
    });
  },
);
