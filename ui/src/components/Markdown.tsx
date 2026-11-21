import { isValidElement, memo, useState, type ReactNode } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { IconCheck, IconCopy } from "./icons";

/** Assistant/markdown text. Links open in a new tab; fenced code gets a header + copy. */
export const Markdown = memo(function Markdown({ text }: { text: string }) {
  return (
    <div className="md">
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        components={{
          a: (props) => <a {...props} target="_blank" rel="noreferrer" />,
          pre: ({ children }) => <CodeBlock>{children}</CodeBlock>,
        }}
      >
        {text}
      </ReactMarkdown>
    </div>
  );
});

function CodeBlock({ children }: { children?: ReactNode }) {
  const [copied, setCopied] = useState(false);
  const code = isValidElement<{ className?: string; children?: ReactNode }>(children)
    ? children
    : null;
  const lang = /language-([\w+#-]+)/.exec(code?.props.className ?? "")?.[1];
  const raw = String(code?.props.children ?? "").replace(/\n$/, "");
  const copy = () => {
    void navigator.clipboard?.writeText(raw).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 1200);
    });
  };
  return (
    <div className="code-block">
      <div className="code-head">
        <span className="code-lang">{lang ?? "text"}</span>
        <button className="code-copy" onClick={copy} title="Copy">
          {copied ? <IconCheck size={12} /> : <IconCopy size={12} />}
          <span>{copied ? "Copied" : "Copy"}</span>
        </button>
      </div>
      <pre>{children}</pre>
    </div>
  );
}
