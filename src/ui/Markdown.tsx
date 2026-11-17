import { Children, isValidElement, memo, useRef, useState, type ReactNode } from "react";
import ReactMarkdown from "react-markdown";
import rehypeHighlight from "rehype-highlight";
import remarkGfm from "remark-gfm";
import { openExternal } from "../platform/files";
import { repo, useApp } from "../state/store";
import { Icon } from "./icons";

function CodeBlock({ children }: { children?: ReactNode }) {
  const ref = useRef<HTMLPreElement>(null);
  const [copied, setCopied] = useState(false);
  const first = Children.toArray(children)[0];
  const cls = isValidElement<{ className?: string }>(first) ? (first.props.className ?? "") : "";
  const lang = /language-([\w+-]+)/.exec(cls)?.[1];
  return (
    <div className="codeblock">
      <div className="codeblock-head">
        <span className="grow">{lang ?? "code"}</span>
        {(lang === "html" || lang === "svg" || lang === "xml") && (
          <button
            className="btn small"
            title="Show this as a page"
            onClick={async () => {
              const text = ref.current?.innerText ?? "";
              const html = lang === "svg" || /^\s*<svg/.test(text) ? `<!doctype html><body style="margin:0;display:grid;place-items:center;min-height:100vh">${text}</body>` : text;
              const blob = await repo.putBlob(new TextEncoder().encode(html), "text/html", "preview.html");
              useApp.setState({ preview: blob });
            }}
          >
            Preview
          </button>
        )}
        <button
          className="icon-btn"
          title="Copy code"
          onClick={() => {
            void navigator.clipboard.writeText(ref.current?.innerText ?? "");
            setCopied(true);
            setTimeout(() => setCopied(false), 1200);
          }}
        >
          {copied ? <Icon.check /> : <Icon.copy />}
        </button>
      </div>
      <pre ref={ref}>{children}</pre>
    </div>
  );
}

export const Markdown = memo(function Markdown({ text }: { text: string }) {
  return (
    <div className="md">
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        rehypePlugins={[[rehypeHighlight, { detect: false, ignoreMissing: true }]]}
        components={{
          pre: ({ children }) => <CodeBlock>{children}</CodeBlock>,
          table: ({ children }) => (
            <div className="table-wrap">
              <table>{children}</table>
            </div>
          ),
          a: ({ href, children }) => (
            <a
              href={href}
              onClick={(e) => {
                e.preventDefault();
                if (href && /^https?:|^mailto:/.test(href)) void openExternal(href);
              }}
            >
              {children}
            </a>
          ),
        }}
      >
        {text}
      </ReactMarkdown>
    </div>
  );
});
