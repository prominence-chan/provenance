import { Composer } from "./components/Composer";
import { Conversation } from "./components/Conversation";
import { Notices } from "./components/Notices";
import { Sidebar } from "./components/Sidebar";
import { ThreadHeader } from "./components/ThreadHeader";
import { useAppState } from "./store/store";

export function App() {
  const selected = useAppState((s) => s.selectedThreadId);
  return (
    <div className="app">
      <Sidebar />
      <main className="main">
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
      <div className="hero-mark" />
      <h1>What should we build?</h1>
      <p className="muted mono">{cwd || "no working directory set"}</p>
    </div>
  );
}
