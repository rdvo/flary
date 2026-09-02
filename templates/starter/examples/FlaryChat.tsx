import { useEffect } from "react";

declare module "react" {
  namespace JSX {
    interface IntrinsicElements {
      "flary-chat": { title?: string; "base-url"?: string };
    }
  }
}

export function FlaryChat({
  workerUrl,
  title = "Support assistant",
}: {
  workerUrl: string;
  title?: string;
}) {
  useEffect(() => {
    const source = `${workerUrl.replace(/\/$/, "")}/widget.js`;
    if (document.querySelector(`script[src="${source}"]`)) return;
    const script = document.createElement("script");
    script.src = source;
    script.async = true;
    document.head.append(script);
  }, [workerUrl]);

  return <flary-chat title={title} base-url={workerUrl} />;
}
