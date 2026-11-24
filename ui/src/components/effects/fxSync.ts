// One moment shared by the composer's nova flare (FlameFx) and the hero sun (HeroSun): when the
// flare's burst peaks. Selecting nova starts both; FlameFx works out its burst from its own
// timeline and publishes it here, and the sun's collapse is driven to land on that instant, so
// the two read as one explosion.
//
// Times are performance.now() milliseconds (the clock both effects run on), already scaled by
// the dev-only ?fxspeed.

export const novaBurst = {
  /** When the selection that started this flare happened. */
  selectedAt: -Infinity,
  /** When its burst peaks. */
  burstAt: -Infinity,
};

export function publishNovaBurst(selectedAt: number, burstAt: number): void {
  novaBurst.selectedAt = selectedAt;
  novaBurst.burstAt = burstAt;
}

// Dev only: for headless checks of the sync (with HeroSun's __provenanceSunTip).
if (import.meta.env.DEV)
  (window as unknown as { __provenanceNovaBurst: typeof novaBurst }).__provenanceNovaBurst =
    novaBurst;
