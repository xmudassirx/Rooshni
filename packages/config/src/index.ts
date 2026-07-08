/**
 * Shared configuration helpers.
 *
 * Master context hard rule: timers are data. All workflow timing comes from
 * `workflow_definitions` rows multiplied by TIME_SCALE. Production = 1;
 * dev = e.g. 1440 so 1 day becomes 1 minute. Never hardcode a duration.
 */

export function timeScale(): number {
  const raw = process.env.TIME_SCALE;
  if (!raw) {
    throw new Error(
      "TIME_SCALE is not set. Timers are data multiplied by TIME_SCALE; refusing to guess a value."
    );
  }
  const scale = Number(raw);
  if (!Number.isFinite(scale) || scale <= 0) {
    throw new Error(`TIME_SCALE must be a positive number, got "${raw}".`);
  }
  return scale;
}

/** Convert a real-world duration (ms) into the scaled duration to actually wait. */
export function scaleDurationMs(realDurationMs: number): number {
  return realDurationMs / timeScale();
}

export function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(`Required environment variable ${name} is not set.`);
  }
  return value;
}
