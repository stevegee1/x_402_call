/** Minimal Prometheus-text metrics; swap for OpenTelemetry in M2. */
type Labels = Record<string, string>;

const key = (name: string, labels: Labels = {}) => {
  const l = Object.entries(labels)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([k, v]) => `${k}="${v.replace(/["\\\n]/g, "_")}"`)
    .join(",");
  return l ? `${name}{${l}}` : name;
};

export class Metrics {
  private counters = new Map<string, number>();
  private gauges = new Map<string, number>();
  private help = new Map<string, string>();

  inc(name: string, labels?: Labels, by = 1) {
    const k = key(name, labels);
    this.counters.set(k, (this.counters.get(k) ?? 0) + by);
  }

  set(name: string, value: number, labels?: Labels) {
    this.gauges.set(key(name, labels), value);
  }

  get(name: string, labels?: Labels): number {
    const k = key(name, labels);
    return this.counters.get(k) ?? this.gauges.get(k) ?? 0;
  }

  describe(name: string, text: string) {
    this.help.set(name, text);
  }

  render(): string {
    const lines: string[] = [];
    for (const [name, text] of this.help) lines.push(`# HELP ${name} ${text}`);
    for (const [k, v] of this.counters) lines.push(`${k} ${v}`);
    for (const [k, v] of this.gauges) lines.push(`${k} ${v}`);
    return lines.join("\n") + "\n";
  }
}
