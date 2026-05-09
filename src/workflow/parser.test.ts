import { describe, it, expect } from "vitest";
import { parseWorkflowYaml, WorkflowValidationError } from "./parser.js";

describe("WorkflowParser", () => {
  const validYaml = `
name: test-workflow
description: A test workflow
version: "1.0"
variables:
  targetDir: src
steps:
  - id: step1
    type: agent
    agentType: explore
    task: "Analyze \${targetDir}"
  - id: step2
    type: agent
    agentType: coder
    task: "Implement based on \${steps.step1.content}"
    budget: 5.0
    on:
      condition:
        field: status
        operator: eq
        value: completed
      then: step3
      else: step1
  - id: step3
    type: checkpoint
    task: "Review checkpoint"
    checkpoint:
      message: "Continue?"
      autoApprove: false
`;

  it("parses a valid workflow definition", () => {
    const def = parseWorkflowYaml(validYaml);
    expect(def.name).toBe("test-workflow");
    expect(def.description).toBe("A test workflow");
    expect(def.version).toBe("1.0");
    expect(def.variables).toEqual({ targetDir: "src" });
    expect(def.steps).toHaveLength(3);
  });

  it("parses step fields correctly", () => {
    const def = parseWorkflowYaml(validYaml);
    const step1 = def.steps[0];
    expect(step1.id).toBe("step1");
    expect(step1.type).toBe("agent");
    expect(step1.agentType).toBe("explore");
    expect(step1.task).toContain("${targetDir}");
  });

  it("parses conditional branching", () => {
    const def = parseWorkflowYaml(validYaml);
    const step2 = def.steps[1];
    expect(step2.on).toBeDefined();
    expect(step2.on!.condition.field).toBe("status");
    expect(step2.on!.condition.operator).toBe("eq");
    expect(step2.on!.condition.value).toBe("completed");
    expect(step2.on!.then).toBe("step3");
    expect(step2.on!.else).toBe("step1");
  });

  it("parses checkpoint step", () => {
    const def = parseWorkflowYaml(validYaml);
    const step3 = def.steps[2];
    expect(step3.type).toBe("checkpoint");
    expect(step3.checkpoint).toBeDefined();
    expect(step3.checkpoint!.message).toBe("Continue?");
    expect(step3.checkpoint!.autoApprove).toBe(false);
  });

  it("parses committee step", () => {
    const yaml = `
name: committee-test
description: A committee test workflow
steps:
  - id: c1
    type: committee
    agentTypes:
      - explore
      - coder
    task: "Do something"
    strategy: concat
`;
    const def = parseWorkflowYaml(yaml);
    expect(def.steps[0].type).toBe("committee");
    expect(def.steps[0].agentTypes).toEqual(["explore", "coder"]);
    expect(def.steps[0].strategy).toBe("concat");
  });

  it("rejects YAML with no name", () => {
    const yaml = `
steps:
  - id: s1
    type: agent
    agentType: explore
    task: "test"
`;
    expect(() => parseWorkflowYaml(yaml)).toThrow(WorkflowValidationError);
  });

  it("rejects YAML with no steps", () => {
    const yaml = `
name: empty
steps: []
`;
    expect(() => parseWorkflowYaml(yaml)).toThrow(WorkflowValidationError);
  });

  it("rejects YAML with invalid step type", () => {
    const yaml = `
name: bad-type
steps:
  - id: s1
    type: invalid
    task: "test"
`;
    expect(() => parseWorkflowYaml(yaml)).toThrow(WorkflowValidationError);
  });

  it("rejects agent step without agentType", () => {
    const yaml = `
name: no-agent
steps:
  - id: s1
    type: agent
    task: "test"
`;
    expect(() => parseWorkflowYaml(yaml)).toThrow(WorkflowValidationError);
  });

  it("rejects committee step without agentTypes", () => {
    const yaml = `
name: no-agents
steps:
  - id: s1
    type: committee
    task: "test"
`;
    expect(() => parseWorkflowYaml(yaml)).toThrow(WorkflowValidationError);
  });

  it("rejects duplicate step ids", () => {
    const yaml = `
name: dupes
steps:
  - id: s1
    type: agent
    agentType: explore
    task: "test1"
  - id: s1
    type: agent
    agentType: coder
    task: "test2"
`;
    expect(() => parseWorkflowYaml(yaml)).toThrow(WorkflowValidationError);
  });

  it("rejects branch targets that don't exist", () => {
    const yaml = `
name: bad-branch
steps:
  - id: s1
    type: agent
    agentType: explore
    task: "test"
    on:
      condition:
        field: status
        operator: eq
        value: completed
      then: nonexistent
      else: also_nonexistent
`;
    expect(() => parseWorkflowYaml(yaml)).toThrow(WorkflowValidationError);
  });

  it("rejects empty task", () => {
    const yaml = `
name: empty-task
steps:
  - id: s1
    type: agent
    agentType: explore
    task: ""
`;
    expect(() => parseWorkflowYaml(yaml)).toThrow(WorkflowValidationError);
  });
});
