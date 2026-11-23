// Time for guards and timeouts. Every limit in the orchestrators (a worker's minutes, the idle
// guard, a call's duration, the waits between retries) is measured on the monotonic clock: the
// wall clock can jump (a sync, a change of date, a sleep), and a jump of a day once ended a turn
// that had run for minutes. Wall time (Date.now) is only for timestamps that are stored or shown.
//
// Node's timers (setTimeout, AbortSignal.timeout) already run on the monotonic clock; what must
// not be done is to compare two Date.now() readings to decide that something took too long.

export const mono = {
  /** Milliseconds on the monotonic clock (an arbitrary origin: only differences mean anything). */
  now: (): number => performance.now(),
};
