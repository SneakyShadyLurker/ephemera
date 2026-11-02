/*
 * CPU time for work bounds in core tests. Core stays free of Node types, but
 * its tests run in a Node-compatible process; CPU time, unlike wall time,
 * ignores how long a busy machine takes to schedule the test.
 */

interface CpuUsage {
  user: number;
  system: number;
}

const host = (globalThis as { process?: { cpuUsage?: (previous?: CpuUsage) => CpuUsage } }).process;

/**
 * The wall-clock timeout for a test whose bound is a CPU budget. The budget is
 * the property; this only stops a hang, so it leaves room for a busy machine,
 * where Vitest's default 5 s cut a 0.5 s-CPU test at a load average of 22.
 */
export const CPU_BOUND_TEST_TIMEOUT_MS = 60_000;

/** Milliseconds of CPU this process spent running `work`. */
export function cpuMs<T>(work: () => T): { result: T; ms: number } {
  if (host?.cpuUsage === undefined) {
    throw new Error("This test needs a runtime with process.cpuUsage");
  }
  const started = host.cpuUsage();
  const result = work();
  const spent = host.cpuUsage(started);
  return { result, ms: (spent.user + spent.system) / 1_000 };
}
