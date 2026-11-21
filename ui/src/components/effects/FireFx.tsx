// Decorative layers for solstice / nova turns. All aria-hidden and pointer-events: none;
// the animation itself is CSS in src/theme/effects.css (transform/opacity only).
import { SparkField } from "./SparkField";
import type { FxState } from "./useFx";

/** Ring + glow behind the composer, and the nova spark canvas above it. */
export function ComposerAura({ fx }: { fx: FxState }) {
  const effect = fx.tier?.effect ?? "none";
  return (
    <>
      <div className="fx-glow" aria-hidden />
      <div className="fx-ring" aria-hidden>
        <div className="fx-ring-spin" />
      </div>
      {effect === "plasma" && <SparkField active={fx.streaming} />}
    </>
  );
}

/** Plasma shimmer along the top edge of the main column while a turn streams. */
export function PlasmaEdge({ fx }: { fx: FxState }) {
  const effect = fx.tier?.effect ?? "none";
  const on = fx.streaming && effect !== "none";
  return (
    <div className="plasma-edge" data-effect={effect} data-on={on ? "" : undefined} aria-hidden>
      <div className="plasma-edge-flow" />
    </div>
  );
}
