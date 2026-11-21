import { Composer } from "./components/Composer";
import { Conversation } from "./components/Conversation";
import { PlasmaEdge } from "./components/effects/FireFx";
import { useFx } from "./components/effects/useFx";
import { Notices } from "./components/Notices";
import { Sidebar } from "./components/Sidebar";
import { SolarMark } from "./components/SolarMark";
import { ThreadHeader } from "./components/ThreadHeader";
import { useAppState } from "./store/store";

export function App() {
  const selected = useAppState((s) => s.selectedThreadId);
  const fx = useFx();
  return (
    <div className="app">
      <Sidebar />
      <main className="main">
        <PlasmaEdge fx={fx} />
        <ThreadHeader />
        {selected ? <Conversation threadId={selected} /> : <NewThreadHero />}
        <Composer />
      </main>
      <Notices />
    </div>
  );
}

function NewThreadHero() {
  const cwd = useAppState((s) => s.settings.cwd);
  return (
    <div className="hero">
      <div className="hero-mark">
        <SolarMark size={64} />
      </div>
      <h1>What should we build?</h1>
      <p className="hero-cwd mono">{cwd || "no working directory set"}</p>
    </div>
  );
}
