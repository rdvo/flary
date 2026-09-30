import * as React from "react";
import type { ComponentProps } from "react";
import { Streamdown } from "streamdown";
import { flaryMarkdownStyles } from "./styles.js";

export interface FlaryMarkdownProps extends Omit<
  ComponentProps<typeof Streamdown>,
  "children" | "mode"
> {
  children: string;
  /** Set this while the assistant message is still receiving tokens. */
  streaming?: boolean;
  /** Includes scoped CSS by default. Disable when injecting flaryMarkdownStyles once. */
  styled?: boolean;
}

/** Stream-safe Markdown for Flary transcripts. Raw HTML stays disabled. */
export function FlaryMarkdown({
  children,
  streaming = false,
  styled = true,
  className = "",
  controls,
  components,
  lineNumbers = false,
  linkSafety,
  ...props
}: FlaryMarkdownProps) {
  return (
    <>
      {styled ? <style data-flary-markdown-styles="">{flaryMarkdownStyles}</style> : null}
      <Streamdown
        {...props}
        className={`flary-markdown ${className}`.trim()}
        mode={streaming ? "streaming" : "static"}
        isAnimating={streaming}
        parseIncompleteMarkdown={streaming}
        skipHtml
        components={{ strong: "strong", ...components }}
        lineNumbers={lineNumbers}
        linkSafety={linkSafety ?? { enabled: false }}
        controls={
          typeof controls === "object"
            ? { code: { copy: true, download: false }, table: false, ...controls }
            : (controls ?? { code: { copy: true, download: false }, table: false })
        }
      >
        {children}
      </Streamdown>
    </>
  );
}
