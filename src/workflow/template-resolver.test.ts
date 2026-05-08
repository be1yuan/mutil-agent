import { describe, it, expect } from "vitest";
import { resolveTemplate } from "./template-resolver.js";
import type { StepResult } from "./types.js";

describe("resolveTemplate", () => {
  it("resolves simple variables", () => {
    const result = resolveTemplate("Hello ${name}!", { name: "World" }, new Map());
    expect(result).toBe("Hello World!");
  });

  it("resolves multiple variables", () => {
    const result = resolveTemplate("${a} and ${b}", { a: "foo", b: "bar" }, new Map());
    expect(result).toBe("foo and bar");
  });

  it("resolves ${steps.id.content}", () => {
    const steps = new Map<string, StepResult>();
    steps.set("explore", {
      stepId: "explore",
      status: "completed",
      result: { status: "success", content: "analysis result", steps: 5, cost: 0.5 },
    });

    const result = resolveTemplate(
      "Based on: ${steps.explore.content}",
      {},
      steps
    );
    expect(result).toBe("Based on: analysis result");
  });

  it("resolves ${steps.id.status}", () => {
    const steps = new Map<string, StepResult>();
    steps.set("s1", {
      stepId: "s1",
      status: "completed",
    });

    const result = resolveTemplate("Status: ${steps.s1.status}", {}, steps);
    expect(result).toBe("Status: completed");
  });

  it("resolves ${steps.id.cost}", () => {
    const steps = new Map<string, StepResult>();
    steps.set("s1", {
      stepId: "s1",
      status: "completed",
      result: { status: "success", steps: 3, cost: 1.234 },
    });

    const result = resolveTemplate("Cost: ${steps.s1.cost}", {}, steps);
    expect(result).toBe("Cost: 1.234");
  });

  it("leaves unknown variables as-is", () => {
    const result = resolveTemplate("Hello ${unknown}!", {}, new Map());
    expect(result).toBe("Hello ${unknown}!");
  });

  it("leaves unknown step references as-is", () => {
    const result = resolveTemplate("${steps.missing.content}", {}, new Map());
    expect(result).toBe("${steps.missing.content}");
  });

  it("returns empty string for step content when result has no content", () => {
    const steps = new Map<string, StepResult>();
    steps.set("s1", {
      stepId: "s1",
      status: "failed",
      result: { status: "error", steps: 0, cost: 0 },
    });

    const result = resolveTemplate("Content: ${steps.s1.content}", {}, steps);
    expect(result).toBe("Content: ");
  });

  it("handles mixed variables and step references", () => {
    const steps = new Map<string, StepResult>();
    steps.set("plan", {
      stepId: "plan",
      status: "completed",
      result: { status: "success", content: "the plan", steps: 2, cost: 0.3 },
    });

    const result = resolveTemplate(
      "Task: ${feature}\nPlan: ${steps.plan.content}",
      { feature: "auth" },
      steps
    );
    expect(result).toBe("Task: auth\nPlan: the plan");
  });
});
