import { Check, Copy } from "lucide-react";
import { useState } from "react";

const command = "npm install --save-exact flary@0.3.0-rc.5";

function copyWithSelection(value: string): boolean {
  const input = document.createElement("textarea");
  input.value = value;
  input.setAttribute("readonly", "");
  input.style.position = "fixed";
  input.style.opacity = "0";
  window.document.body.appendChild(input);
  input.select();
  const copied = document.execCommand("copy");
  input.remove();
  return copied;
}

export function InstallCommand() {
  const [copied, setCopied] = useState(false);

  async function copyInstall() {
    try {
      if (navigator.clipboard && window.isSecureContext) {
        await navigator.clipboard.writeText(command);
      } else if (!copyWithSelection(command)) {
        throw new Error("Copy was not available");
      }
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1600);
    } catch {
      setCopied(false);
    }
  }

  return (
    <button
      className="install"
      type="button"
      onClick={() => void copyInstall()}
      aria-label={`Copy ${command}`}
    >
      <code>{command}</code>
      <span aria-live="polite" aria-label={copied ? "Copied" : "Copy"}>
        {copied ? <Check size={14} /> : <Copy size={14} />}
      </span>
    </button>
  );
}
