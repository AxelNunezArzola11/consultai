import { describe, expect, it } from "vitest";

import {
  DeliveryWorkflowInputSchema,
  DeliveryWorkflowResultSchema,
} from "@/workflows/schemas";

describe("delivery workflow schemas", () => {
  it("accepts a complete task input", () => {
    expect(DeliveryWorkflowInputSchema.parse({
      prUrl: "https://github.com/acme/app/pull/42",
      criteria: [],
      amountUsd: 125,
    })).toMatchObject({ amountUsd: 125 });
  });

  it("rejects malformed task input", () => {
    expect(() => DeliveryWorkflowInputSchema.parse({
      prUrl: "not-a-url",
      criteria: [],
      amountUsd: -1,
    })).toThrow();
  });

  it("validates the workflow result shape", () => {
    expect(() => DeliveryWorkflowResultSchema.parse({
      headSha: "abc",
      flags: [],
      objectiveResults: [],
      llm: {},
      policy: {},
    })).not.toThrow();
  });
});
