/**
 * Simple Prometheus-compatible metrics.
 *
 * No external dependencies. Supports Counter, Gauge, and Histogram.
 * Exports in Prometheus text exposition format.
 */

// ── Metric types ──

interface MetricEntry {
  name: string;
  help: string;
  type: "counter" | "gauge";
  labels: string[];
  value: number;
}

// ── Metrics registry ──

export class MetricsRegistry {
  private metrics = new Map<string, MetricEntry>();
  private labelValues = new Map<string, Map<string, number>>();

  /** Register or get a counter */
  counter(name: string, help: string, labels: string[] = []): Counter {
    const key = name;
    if (!this.metrics.has(key)) {
      this.metrics.set(key, { name, help, type: "counter", labels, value: 0 });
    }
    return new Counter(this, name, labels);
  }

  /** Register or get a gauge */
  gauge(name: string, help: string, labels: string[] = []): Gauge {
    const key = name;
    if (!this.metrics.has(key)) {
      this.metrics.set(key, { name, help, type: "gauge", labels, value: 0 });
    }
    return new Gauge(this, name, labels);
  }

  /** Increment a metric value */
  inc(name: string, value: number, labelValues: Record<string, string> = {}): void {
    const labelKey = this.labelKey(name, labelValues);
    const current = this.labelValues.get(name)?.get(labelKey) ?? 0;
    if (!this.labelValues.has(name)) {
      this.labelValues.set(name, new Map());
    }
    this.labelValues.get(name)!.set(labelKey, current + value);
  }

  /** Set a metric value */
  set(name: string, value: number, labelValues: Record<string, string> = {}): void {
    const labelKey = this.labelKey(name, labelValues);
    if (!this.labelValues.has(name)) {
      this.labelValues.set(name, new Map());
    }
    this.labelValues.get(name)!.set(labelKey, value);
  }

  /** Get a metric value */
  get(name: string, labelValues: Record<string, string> = {}): number {
    const labelKey = this.labelKey(name, labelValues);
    return this.labelValues.get(name)?.get(labelKey) ?? 0;
  }

  /** Export in Prometheus text exposition format */
  export(): string {
    const lines: string[] = [];

    for (const [name, metric] of this.metrics) {
      lines.push(`# HELP ${name} ${metric.help}`);
      lines.push(`# TYPE ${name} ${metric.type}`);

      const values = this.labelValues.get(name);
      if (values && values.size > 0) {
        for (const [labelKey, value] of values) {
          if (labelKey === "{}") {
            lines.push(`${name} ${value}`);
          } else {
            lines.push(`${name}${labelKey} ${value}`);
          }
        }
      } else {
        lines.push(`${name} 0`);
      }
    }

    return lines.join("\n") + "\n";
  }

  /** Reset all metrics */
  reset(): void {
    for (const values of this.labelValues.values()) {
      values.clear();
    }
  }

  private labelKey(name: string, labelValues: Record<string, string>): string {
    const entries = Object.entries(labelValues).sort(([a], [b]) => a.localeCompare(b));
    if (entries.length === 0) return "{}";
    const pairs = entries.map(([k, v]) => `${k}="${this.escapeLabelValue(v)}"`).join(",");
    return `{${pairs}}`;
  }

  private escapeLabelValue(v: string): string {
    return v.replace(/\\/g, "\\\\").replace(/"/g, '\\"').replace(/\n/g, "\\n");
  }
}

// ── Counter ──

export class Counter {
  constructor(
    private registry: MetricsRegistry,
    private name: string,
    private labels: string[]
  ) {}

  inc(value: number = 1, labelValues: Record<string, string> = {}): void {
    this.registry.inc(this.name, value, labelValues);
  }
}

// ── Gauge ──

export class Gauge {
  constructor(
    private registry: MetricsRegistry,
    private name: string,
    private labels: string[]
  ) {}

  inc(value: number = 1, labelValues: Record<string, string> = {}): void {
    this.registry.inc(this.name, value, labelValues);
  }

  dec(value: number = 1, labelValues: Record<string, string> = {}): void {
    this.registry.inc(this.name, -value, labelValues);
  }

  set(value: number, labelValues: Record<string, string> = {}): void {
    this.registry.set(this.name, value, labelValues);
  }
}

// ── Pre-defined agent metrics ──

export function createAgentMetrics(): MetricsRegistry {
  const reg = new MetricsRegistry();

  reg.counter("agent_tasks_total", "Total number of agent tasks", ["agent_type", "status"]);
  reg.counter("agent_steps_total", "Total steps executed", ["agent_type"]);
  reg.counter("agent_tool_calls_total", "Total tool calls", ["agent_type", "tool_name", "success"]);
  reg.counter("agent_tokens_total", "Total tokens consumed", ["provider", "type"]);
  reg.counter("agent_cost_yuan_total", "Total cost in yuan", ["provider"]);
  reg.gauge("agent_active_tasks", "Currently running tasks", ["agent_type"]);

  return reg;
}
