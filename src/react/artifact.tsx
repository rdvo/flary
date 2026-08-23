import * as React from "react";
import type { CSSProperties, ReactNode } from "react";

export interface FlaryInlineArtifactProps {
  title: string;
  html: string;
  height?: number;
  className?: string;
  header?: ReactNode;
  /** Scripts run in a unique sandbox origin. They cannot access the host page. */
  allowScripts?: boolean;
}

const boundedHeight = (value: number | undefined) =>
  Math.max(180, Math.min(960, value ?? 420));

/** Render agent HTML in a separate sandboxed document, never in the host DOM. */
export function FlaryInlineArtifact({
  title,
  html,
  height,
  className = "",
  header,
  allowScripts = true,
}: FlaryInlineArtifactProps) {
  const style = { "--flary-artifact-height": `${boundedHeight(height)}px` } as CSSProperties;
  return (
    <figure className={`flary-artifact ${className}`.trim()} style={style}>
      <figcaption className="flary-artifact__header">
        {header ?? <span>{title}</span>}
      </figcaption>
      <iframe
        className="flary-artifact__frame"
        title={title}
        srcDoc={html}
        sandbox={allowScripts ? "allow-scripts allow-forms allow-popups" : "allow-forms allow-popups"}
        referrerPolicy="no-referrer"
        loading="lazy"
      />
    </figure>
  );
}
