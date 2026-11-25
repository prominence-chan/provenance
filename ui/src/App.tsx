import { Composer } from "./components/Composer";
import { Conversation } from "./components/Conversation";
import { FlameFx } from "./components/effects/FlameFx";
import { HealthBanner } from "./components/HealthBanner";
import { HeroSun } from "./components/effects/HeroSun";
import { useFx } from "./components/effects/useFx";
import { Notices } from "./components/Notices";
import { Sidebar } from "./components/Sidebar";
import { SubagentsPanel } from "./components/SubagentsPanel";
import { ThreadHeader } from "./components/ThreadHeader";
import { WelcomeDialog } from "./fallback/WelcomeDialog";
import { SetupDialog } from "./setup/SetupDialog";
import { useAppState } from "./store/store";
import type { TierId } from "./theme/tiers";
import { useSidebar } from "./theme/ui";

export function App() {
  const selected = useAppState((s) => s.selectedThreadId);
  const fx = useFx();
  const { narrow, visible } = useSidebar();
  return (
    <div
      className="app"
      data-sidebar={visible ? "open" : "closed"}
      data-narrow={narrow ? "" : undefined}
    >
      <Sidebar />
      <main className="main">
        <FlameFx fx={fx} />
        <ThreadHeader />
        <HealthBanner />
        {selected ? (
          <Conversation threadId={selected} />
        ) : (
          <NewThreadHero tier={fx.tier?.id ?? null} />
        )}
        <Composer />
      </main>
      <SubagentsPanel />
      <Notices />
      <SetupDialog />
      <WelcomeDialog />
    </div>
  );
}

/** The sun reacts to the selected tier (HeroSun.tsx); a fallback shows the plain sun. */
function NewThreadHero({ tier }: { tier: TierId | null }) {
  return (
    <div className="hero">
      <HeroSun size={200} tier={tier} />
      <h1>What should we build?</h1>
    </div>
  );
}
