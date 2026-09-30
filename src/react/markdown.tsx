import * as React from "react";
import type { ComponentProps } from "react";
import { createCodePlugin } from "@streamdown/code";
import { Streamdown } from "streamdown";
import { flaryMarkdownStyles } from "./styles.js";

// Warm neutrals match Flary's surfaces; each token palette stays readable on them.
const syntaxScopes = [
  "comment, punctuation.definition.comment",
  "keyword, storage, punctuation.definition.template-expression",
  "string",
  "constant, variable.language, variable.other.constant",
  "entity.name.function, support.function",
  "entity.name.type, entity.name.class, entity.name.namespace, entity.name.tag, support.class, support.type",
  "entity.other.attribute-name, meta.object-literal.key, string.unquoted.yaml",
];
const code = createCodePlugin({
  themes: [
    {
      name: "flary-light",
      type: "light",
      colors: { "editor.foreground": "#2d241d", "editor.background": "#f1ebe3" },
      tokenColors: syntaxScopes.map((scope, index) => ({
        scope,
        settings: {
          foreground: ["#655e57", "#9c3232", "#7c451f", "#245b9e", "#6a4690", "#326347", "#6a4690"][
            index
          ],
        },
      })),
    },
    {
      name: "flary-dark",
      type: "dark",
      colors: { "editor.foreground": "#e8e2dc", "editor.background": "#24292e" },
      tokenColors: syntaxScopes.map((scope, index) => ({
        scope,
        settings: {
          foreground: ["#aaa39c", "#ef9b85", "#e6b788", "#88b9ed", "#c6a8e8", "#9ac9ac", "#c6a8e8"][
            index
          ],
        },
      })),
    },
  ],
});

export interface FlaryMarkdownProps extends Omit<
  ComponentProps<typeof Streamdown>,
  "children" | "mode"
> {
  children: string;
  /** Set this while the assistant message is still receiving tokens. */
  streaming?: boolean;
  /** Includes scoped CSS by default. Disable when injecting flaryMarkdownStyles once. */
  styled?: boolean;
  /** Auto follows the host's light/dark theme or the system preference. */
  colorScheme?: "light" | "dark" | "auto";
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
  colorScheme = "auto",
  plugins,
  linkSafety,
  ...props
}: FlaryMarkdownProps) {
  return (
    <>
      {styled ? <style data-flary-markdown-styles="">{flaryMarkdownStyles}</style> : null}
      <Streamdown
        {...props}
        className={`flary-markdown flary-markdown--${colorScheme} ${className}`.trim()}
        plugins={{ code, ...plugins }}
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
