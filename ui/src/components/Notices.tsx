import { dismissNotice } from "../store/actions";
import { useAppState } from "../store/store";

/** Toasts for warnings/errors (bottom-right). */
export function Notices() {
  const notices = useAppState((s) => s.notices);
  if (!notices.length) return null;
  return (
    <div className="notices">
      {notices.map((n) => (
        <div key={n.id} className={`notice notice-${n.level}`} onClick={() => dismissNotice(n.id)}>
          {n.text}
        </div>
      ))}
    </div>
  );
}
