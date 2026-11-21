// Sidebar visibility. On wide screens the sidebar is docked and its collapsed state is
// remembered; below NARROW px it becomes a drawer that starts closed and closes again
// after you pick a thread. Cmd/Ctrl+B toggles it either way.
import { useSyncExternalStore } from "react";

const KEY = "provenance-ui.sidebar-collapsed";
const NARROW = "(max-width: 860px)";
const listeners = new Set<() => void>();
const mq = window.matchMedia(NARROW);

let collapsed = (() => {
  try {
    return localStorage.getItem(KEY) === "1";
  } catch {
    return false;
  }
})();
let drawerOpen = false;
let narrow = mq.matches;

const emit = () => {
  snapshot = { narrow, visible: narrow ? drawerOpen : !collapsed };
  for (const l of listeners) l();
};
let snapshot = { narrow, visible: narrow ? drawerOpen : !collapsed };

mq.addEventListener("change", (e) => {
  narrow = e.matches;
  drawerOpen = false;
  emit();
});

export function toggleSidebar(force?: boolean): void {
  if (narrow) {
    drawerOpen = force ?? !drawerOpen;
  } else {
    collapsed = force === undefined ? !collapsed : !force;
    try {
      localStorage.setItem(KEY, collapsed ? "1" : "0");
    } catch {
      // private mode: still toggle for this session
    }
  }
  emit();
}

/** After choosing a thread or "New thread": a drawer gets out of the way. */
export function closeDrawer(): void {
  if (narrow && drawerOpen) {
    drawerOpen = false;
    emit();
  }
}

export function useSidebar(): { narrow: boolean; visible: boolean } {
  return useSyncExternalStore(
    (l) => {
      listeners.add(l);
      return () => listeners.delete(l);
    },
    () => snapshot,
  );
}

window.addEventListener("keydown", (e) => {
  if ((e.metaKey || e.ctrlKey) && !e.shiftKey && !e.altKey && e.key.toLowerCase() === "b") {
    e.preventDefault();
    toggleSidebar();
  }
});
