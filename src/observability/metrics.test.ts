/**
 * Metrics module tests.
 */

import { describe, it, expect } from "vitest";
import { MetricsRegistry, Counter, Gauge, createAgentMetrics } from "./metrics.js";

describe("MetricsRegistry", () => {
  it("creates and increments a counter", () => {
    const reg = new MetricsRegistry();
    const counter = reg.counter("test_counter", "A test counter");
    counter.inc(5);
    expect(reg.get("test_counter")).toBe(5);
  });

  it("creates and sets a gauge", () => {
    const reg = new MetricsRegistry();
    const gauge = reg.gauge("test_gauge", "A test gauge");
    gauge.set(42);
    expect(reg.get("test_gauge")).toBe(42);
    gauge.inc(8);
    expect(reg.get("test_gauge")).toBe(50);
    gauge.dec(10);
    expect(reg.get("test_gauge")).toBe(40);
  });

  it("handles labeled metrics", () => {
    const reg = new MetricsRegistry();
    const counter = reg.counter("http_requests", "HTTP requests", ["method", "status"]);
    counter.inc(1, { method: "GET", status: "200" });
    counter.inc(3, { method: "POST", status: "201" });
    counter.inc(1, { method: "GET", status: "404" });

    expect(reg.get("http_requests", { method: "GET", status: "200" })).toBe(1);
    expect(reg.get("http_requests", { method: "POST", status: "201" })).toBe(3);
    expect(reg.get("http_requests", { method: "GET", status: "404" })).toBe(1);
  });

  it("exports in Prometheus text format", () => {
    const reg = new MetricsRegistry();
    const counter = reg.counter("tasks_total", "Total tasks");
    counter.inc(10);

    const output = reg.export();
    expect(output).toContain("# HELP tasks_total Total tasks");
    expect(output).toContain("# TYPE tasks_total counter");
    expect(output).toContain("tasks_total 10");
  });

  it("exports labeled metrics in Prometheus format", () => {
    const reg = new MetricsRegistry();
    const counter = reg.counter("requests_total", "Total requests", ["method"]);
    counter.inc(5, { method: "GET" });
    counter.inc(3, { method: "POST" });

    const output = reg.export();
    expect(output).toContain('requests_total{method="GET"} 5');
    expect(output).toContain('requests_total{method="POST"} 3');
  });

  it("resets all metrics", () => {
    const reg = new MetricsRegistry();
    const counter = reg.counter("test", "Test");
    counter.inc(100);
    expect(reg.get("test")).toBe(100);

    reg.reset();
    expect(reg.get("test")).toBe(0);
  });

  it("creates pre-defined agent metrics", () => {
    const reg = createAgentMetrics();

    // Should have all the standard metrics
    const output = reg.export();
    expect(output).toContain("agent_tasks_total");
    expect(output).toContain("agent_steps_total");
    expect(output).toContain("agent_tool_calls_total");
    expect(output).toContain("agent_tokens_total");
    expect(output).toContain("agent_cost_yuan_total");
    expect(output).toContain("agent_active_tasks");
  });

  it("tracks agent task metrics with labels", () => {
    const reg = createAgentMetrics();

    // Simulate tracking
    reg.inc("agent_tasks_total", 1, { agent_type: "main", status: "success" });
    reg.inc("agent_tasks_total", 1, { agent_type: "main", status: "error" });
    reg.inc("agent_tool_calls_total", 3, { agent_type: "main", tool_name: "Read", success: "true" });

    expect(reg.get("agent_tasks_total", { agent_type: "main", status: "success" })).toBe(1);
    expect(reg.get("agent_tasks_total", { agent_type: "main", status: "error" })).toBe(1);
    expect(reg.get("agent_tool_calls_total", { agent_type: "main", tool_name: "Read", success: "true" })).toBe(3);
  });
});
