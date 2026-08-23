import * as React from "react";
import type { ComponentProps } from "react";
import { Streamdown } from "streamdown";

export interface FlaryMarkdownProps
  extends Omit<ComponentProps<typeof Streamdown>, "children" | "mode"> {
  children: string;
  /** Set this while the assistant message is still receiving tokens. */
  streaming?: boolean;
}

/** Stream-safe Markdown for Flary transcripts. Raw HTML stays disabled. */
export function FlaryMarkdown({
  children,
  streaming = false,
  className = "",
  controls,
  linkSafety,
  ...props
}: FlaryMarkdownProps) {
  return (
    <Streamdown
      {...props}
      className={`flary-markdown ${className}`.trim()}
      mode={streaming ? "streaming" : "static"}
      isAnimating={streaming}
      parseIncompleteMarkdown={streaming}
      skipHtml
      linkSafety={linkSafety ?? { enabled: false }}
      controls={
        typeof controls === "object"
          ? { code: true, table: true, ...controls }
          : controls ?? { code: true, table: true }
      }
    >
      {children}
    </Streamdown>
  );
}
