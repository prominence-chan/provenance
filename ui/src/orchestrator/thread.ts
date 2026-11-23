// Which orchestrator an existing tier thread runs on (the composer shows it, read only: the
// setting applies to new threads). shared/orchestrator-api.ts has the contract: threads the
// orchestrator backend runs have ids starting with ORCHESTRATOR_ID_PREFIX; any other tier thread
// is "provenance".

import {
  ORCHESTRATOR_ID_PREFIX,
  isOrchestrator,
  type Orchestrator,
} from "../../shared/orchestrator-api";

/**
 * An orchestrated thread names its orchestrator in its id ("orc-hyperexperimental-…") or in its
 * modelProvider / extra.orchestrator; without either it is the plain experimental one.
 */
export function threadOrchestrator(
  id: string,
  thread?: { modelProvider?: string | null; extra?: unknown } | null,
): Orchestrator {
  if (!id.startsWith(ORCHESTRATOR_ID_PREFIX)) return "provenance";
  const rest = id.slice(ORCHESTRATOR_ID_PREFIX.length);
  if (rest.startsWith("hyperexperimental")) return "hyperexperimental";
  if (rest.startsWith("experimental")) return "experimental";
  const extra = (thread?.extra as { orchestrator?: unknown } | null | undefined)?.orchestrator;
  if (isOrchestrator(extra)) return extra;
  if (isOrchestrator(thread?.modelProvider)) return thread.modelProvider;
  return "experimental";
}
