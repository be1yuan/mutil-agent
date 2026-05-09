import { describe, it, expect } from "vitest";
import {
  buildStep,
  sanitizeName,
  serializeWorkflow,
  type WizardStepInput,
} from "./workflow-wizard.js";
import { parseWorkflowYaml } from "../workflow/parser.js";
import type { WorkflowDefinition } from "../workflow/types.js";

describe("WorkflowWizard helpers", () => {
  describe("sanitizeName", () => {
    it("converts to lowercase kebab-case", () => {
      expect(sanitizeName("Code Review")).toBe("code-review");
    });

    it("removes special characters", () => {
      expect(sanitizeName("My Workflow!!!")).toBe("my-workflow");
    });

    it("trims dashes", () => {
      expect(sanitizeName("  --hello--  ")).toBe("hello");
    });

    it("handles empty string", () => {
      expect(sanitizeName("")).toBe("");
    });
  });

  describe("buildStep", () => {
    it("builds an agent step", () => {
      const input: WizardStepInput = {
        type: "agent",
        agentType: "explore",
        task: "Analyze code",
      };
      const step = buildStep(input, 0);
      expect(step.id).toBe("step1");
      expect(step.type).toBe("agent");
      expect(step.agentType).toBe("explore");
      expect(step.task).toBe("Analyze code");
    });

    it("builds a committee step", () => {
      const input: WizardStepInput = {
        type: "committee",
        agentTypes: ["explore", "coder"],
        task: "Review and implement",
      };
      const step = buildStep(input, 1);
      expect(step.id).toBe("step2");
      expect(step.type).toBe("committee");
      expect(step.agentTypes).toEqual(["explore", "coder"]);
    });

    it("builds a checkpoint step", () => {
      const input: WizardStepInput = {
        type: "checkpoint",
        task: "Ready to deploy?",
      };
      const step = buildStep(input, 2);
      expect(step.id).toBe("step3");
      expect(step.type).toBe("checkpoint");
      expect(step.checkpoint).toBeDefined();
      expect(step.checkpoint!.message).toBe("Ready to deploy?");
      expect(step.checkpoint!.autoApprove).toBe(false);
    });
  });

  describe("serializeWorkflow", () => {
    it("produces valid YAML that round-trips through parseWorkflowYaml", () => {
      const def: WorkflowDefinition = {
        name: "test-wf",
        description: "A test workflow",
        steps: [
          { id: "s1", type: "agent", agentType: "explore", task: "Analyze" },
        ],
      };
      const yaml = serializeWorkflow(def);
      const parsed = parseWorkflowYaml(yaml);
      expect(parsed.name).toBe("test-wf");
      expect(parsed.description).toBe("A test workflow");
      expect(parsed.steps).toHaveLength(1);
      expect(parsed.steps[0].id).toBe("s1");
    });

    it("handles special characters in description", () => {
      const def: WorkflowDefinition = {
        name: "special",
        description: 'Review code: "quality" check',
        steps: [
          { id: "s1", type: "agent", agentType: "explore", task: "Analyze: test" },
        ],
      };
      const yaml = serializeWorkflow(def);
      // Should not throw when re-parsing
      const parsed = parseWorkflowYaml(yaml);
      expect(parsed.description).toBe('Review code: "quality" check');
    });

    it("serializes committee step with agentTypes", () => {
      const def: WorkflowDefinition = {
        name: "committee-wf",
        description: "Committee test",
        steps: [
          {
            id: "c1",
            type: "committee",
            agentTypes: ["explore", "coder"],
            task: "Parallel task",
          },
        ],
      };
      const yaml = serializeWorkflow(def);
      const parsed = parseWorkflowYaml(yaml);
      expect(parsed.steps[0].type).toBe("committee");
      expect(parsed.steps[0].agentTypes).toEqual(["explore", "coder"]);
    });

    it("serializes checkpoint step", () => {
      const def: WorkflowDefinition = {
        name: "cp-wf",
        description: "Checkpoint test",
        steps: [
          {
            id: "cp1",
            type: "checkpoint",
            task: "Review?",
            checkpoint: { message: "Review?", autoApprove: true },
          },
        ],
      };
      const yaml = serializeWorkflow(def);
      const parsed = parseWorkflowYaml(yaml);
      expect(parsed.steps[0].checkpoint?.autoApprove).toBe(true);
    });

    it("serializes variables", () => {
      const def: WorkflowDefinition = {
        name: "var-wf",
        description: "Variables test",
        steps: [{ id: "s1", type: "agent", agentType: "explore", task: "test" }],
        variables: { targetDir: "src", mode: "strict" },
      };
      const yaml = serializeWorkflow(def);
      const parsed = parseWorkflowYaml(yaml);
      expect(parsed.variables).toEqual({ targetDir: "src", mode: "strict" });
    });
  });
});
