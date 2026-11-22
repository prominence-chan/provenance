import { Composer } from "./components/Composer";
import { Conversation } from "./components/Conversation";
import { FlameFx } from "./components/effects/FlameFx";
import { HeroSun } from "./components/effects/HeroSun";
import { useFx } from "./components/effects/useFx";
import { Notices } from "./components/Notices";
import { Sidebar } from "./components/Sidebar";
import { ThreadHeader } from "./components/ThreadHeader";
import { useAppState } from "./store/store";
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
        {selected ? <Conversation threadId={selected} /> : <NewThreadHero />}
        <Composer />
      </main>
      <Notices />
    </div>
  );
}

function NewThreadHero() {
  return (
    <div className="hero">
      <HeroSun size={200} />
      <h1>What should we build?</h1>
    </div>
  );
}
