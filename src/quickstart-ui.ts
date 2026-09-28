export const setupHtml = `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8">
    <meta name="viewport" content="width=device-width,initial-scale=1">
    <meta name="color-scheme" content="light">
    <title>Flary quick start</title>
    <link rel="stylesheet" href="/app.css">
  </head>
  <body>
    <main class="shell" id="setup">
      <aside class="sidebar">
        <a class="mark" href="#assistant" aria-label="Flary home"><span>f</span> Flary</a>
        <p class="eyebrow">Quick start</p>
        <ol id="steps" aria-label="Setup progress">
          <li class="active" data-step="0"><span class="step-number">1</span><span>Your assistant</span></li>
          <li data-step="1"><span class="step-number">2</span><span>Connect accounts</span></li>
          <li data-step="2"><span class="step-number">3</span><span>Launch</span></li>
          <li data-step="3"><span class="step-number">4</span><span>Try it</span></li>
        </ol>
        <p class="local">Local setup<br>Your accounts. Your data.</p>
      </aside>

      <section class="stage">
        <div class="mobile-progress" aria-label="Current setup step">
          <span id="mobile-step">Step 1 of 4</span>
          <span id="mobile-step-name">Your assistant</span>
        </div>
        <div id="notice" role="status" aria-live="polite"></div>
        <div id="error" class="message error" role="alert" aria-live="assertive" hidden>
          <p id="error-message"></p>
          <button type="button" class="secondary small" id="error-retry" hidden>Retry</button>
        </div>

        <form id="wizard" novalidate>
          <section class="panel active" data-step="0" aria-labelledby="assistant-heading">
            <p class="eyebrow">Your assistant</p>
            <h1 id="assistant-heading" tabindex="-1">Create your assistant</h1>
            <p class="lead">Choose a starting point. You can make it your own below.</p>

            <fieldset class="presets">
              <legend>Start with a job</legend>
              <div class="preset-grid">
                <button type="button" class="preset selected" data-preset="support" aria-pressed="true">
                  <strong>Customer support</strong>
                  <span>Friendly, concise help for visitors.</span>
                </button>
                <button type="button" class="preset" data-preset="docs" aria-pressed="false">
                  <strong>Documentation</strong>
                  <span>Guide people to clear next steps.</span>
                </button>
                <button type="button" class="preset" data-preset="sales" aria-pressed="false">
                  <strong>Lead enquiries</strong>
                  <span>Learn what people need and route them well.</span>
                </button>
              </div>
            </fieldset>

            <label for="agent-name">Assistant name
              <input id="agent-name" name="agentName" value="Support assistant" autocomplete="off" required minlength="1">
            </label>
            <label for="system-prompt">Instructions
              <textarea id="system-prompt" name="systemPrompt" rows="4" required minlength="1">Help visitors use this product. Give short and accurate answers. Say when you do not know.</textarea>
              <small>Write the kind of help you want people to receive.</small>
            </label>

            <div class="actions actions-end">
              <button type="button" data-next>Continue to accounts</button>
            </div>
          </section>

          <section class="panel" data-step="1" aria-labelledby="accounts-heading" hidden>
            <p class="eyebrow">Connect accounts</p>
            <h2 id="accounts-heading" tabindex="-1">Connect your accounts</h2>
            <p class="lead">Choose where your assistant lives and which AI it uses.</p>

            <details class="permission-list"><summary>What access does Flary need?</summary>
              <div class="permission"><strong>Account Read</strong><span>List accounts available to you.</span></div>
              <div class="permission"><strong>Workers Platform Read and Write</strong><span>Create and update the Worker, Durable Objects, D1, R2, Queues, and secrets.</span></div>
            </details>

            <button type="button" id="connect-cloudflare">Connect Cloudflare</button>
            <div id="cloudflare-connected" class="connection-confirmation" role="status" hidden>
              <span class="connection-check" aria-hidden="true">✓</span>
              <div><strong>Cloudflare connected</strong><p id="connected-account"></p></div>
            </div>
            <p id="oauth-note" class="note"></p>

            <label for="account" id="account-field" hidden>Cloudflare account
              <select id="account" name="accountId" required>
                <option value="">Connect an account first</option>
              </select>
              <small id="account-note">Your choice is kept with this local setup session.</small>
            </label>

            <label for="provider">Model provider
              <select id="provider" name="provider" required>
                <option value="google">Google Gemini</option>
                <option value="openai">OpenAI</option>
                <option value="anthropic">Anthropic</option>
                <option value="workers-ai">Cloudflare Workers AI</option>
              </select>
            </label>
            <div id="provider-key-wrap">
              <label for="provider-key" id="provider-key-label">Google Gemini API key
                <input id="provider-key" name="providerKey" type="password" autocomplete="off" spellcheck="false">
              </label>
              <p class="key-note" id="key-note">Saved on this computer. Sent to your Cloudflare account when you launch.</p>
              <a id="key-help" class="help-link" href="https://aistudio.google.com/apikey" target="_blank" rel="noreferrer">Get a key in Google AI Studio ↗</a>
            </div>

            <details class="advanced" id="advanced-details">
              <summary>Advanced setup details</summary>
              <p class="note">These defaults work for a first launch. Open this section if you need a different Worker name or exact model.</p>
              <label for="worker-name">Worker name
                <input id="worker-name" name="workerName" value="flary-widget" pattern="[a-z0-9-]+" maxlength="63" autocomplete="off" required>
                <small>Lowercase letters, numbers, and hyphens only.</small>
              </label>
              <label for="model">Exact model
                <input id="model" name="model" value="gemini-2.5-flash" autocomplete="off" required>
                <small id="model-note">The exact model name is sent to your Worker.</small>
              </label>
            </details>

            <div class="actions">
              <button type="button" class="secondary" data-back>Back</button>
              <button type="button" data-next>Continue to launch</button>
            </div>
          </section>

          <section class="panel" data-step="2" aria-labelledby="launch-heading" hidden>
            <p class="eyebrow">Launch</p>
            <h2 id="launch-heading" tabindex="-1">Ready to launch?</h2>
            <p class="lead">Review your assistant. We’ll publish it and check that it can respond.</p>

            <div class="summary" aria-label="Assistant summary">
              <div><span>Assistant</span><strong id="summary-name">Support assistant</strong></div>
              <div><span>Job</span><p id="summary-prompt">Help visitors use this product.</p></div>
              <div><span>Account</span><strong id="summary-account">Choose an account</strong></div>
            </div>

            <div id="launch-progress" class="progress" role="status" aria-live="polite" aria-busy="false" hidden>
              <span class="progress-mark" aria-hidden="true"></span>
              <div><strong id="progress-stage">Preparing</strong><p id="progress-message">Getting things ready…</p></div>
            </div>
            <button type="button" id="launch">Launch assistant</button>
            <p class="note">This can take a few minutes while Cloudflare provisions resources. You can safely retry if something needs attention.</p>

            <div class="actions">
              <button type="button" class="secondary" data-back>Back</button>
            </div>
          </section>

          <section class="panel" data-step="3" aria-labelledby="try-heading" hidden>
            <p class="eyebrow">Try it</p>
            <h2 id="try-heading" tabindex="-1">Your assistant is ready.</h2>
            <p class="lead">Start a conversation, then add your assistant to your website.</p>

            <div class="live-card">
              <div class="live-icon" aria-hidden="true">✦</div>
              <div>
                <h3 id="live-title">Meet your assistant</h3>
                <p id="live-description">Deployment verification passed. Try the assistant in a new tab.</p>
                <a id="widget-link" class="primary-link" href="#" target="_blank" rel="noreferrer">Open assistant ↗</a>
              </div>
            </div>

            <div id="embed-result" class="embed-result">
              <h3>Add it to your app</h3>
              <label for="embed">HTML embed code
                <textarea id="embed" rows="3" readonly></textarea>
              </label>
              <button type="button" class="secondary" id="copy">Copy embed code</button>
              <p id="react-path" class="note"></p>
            </div>

            <div class="actions">
              <button type="button" class="secondary" data-back>Back</button>
            </div>
          </section>
        </form>
      </section>
    </main>
    <script src="/app.js"></script>
  </body>
</html>`;

export const setupCss = `:root {
  font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
  font-size: 16px;
  line-height: 1.5;
  color: #202124;
  background: #fafafa;
  font-synthesis: none;
  -webkit-font-smoothing: antialiased;
  --ink: #202124;
  --muted: #72757b;
  --line: #e4e5e7;
  --accent: #1764db;
}
* { box-sizing: border-box; }
body { margin: 0; }
button, input, select, textarea { font: inherit; }
button, a { -webkit-tap-highlight-color: transparent; }
[hidden] { display: none !important; }
a { color: var(--accent); text-underline-offset: 3px; }
.shell { min-height: 100dvh; }
.sidebar { display: flex; align-items: center; gap: 3rem; padding: 1.25rem max(1.5rem, calc((100vw - 1040px) / 2)); border-bottom: 1px solid var(--line); background: #fff; }
.mark { display: inline-flex; gap: .6rem; align-items: center; color: var(--ink); font-size: 1rem; font-weight: 650; text-decoration: none; letter-spacing: -.025em; flex-shrink: 0; }
.mark span { display: grid; place-items: center; width: 1.7rem; height: 1.7rem; border-radius: 7px; background: #202124; color: #fff; font-size: 1.3rem; font-weight: 600; }
.sidebar > .eyebrow { display: none; }
#steps { display: flex; flex: 1; justify-content: center; gap: 1.65rem; padding: 0; margin: 0; list-style: none; }
#steps li { display: flex; align-items: center; gap: .45rem; color: #858890; font-size: .75rem; white-space: nowrap; }
.step-number { display: grid; place-items: center; width: 1.35rem; height: 1.35rem; border: 1px solid var(--line); border-radius: 50%; font-size: .7rem; background: #fff; }
#steps li.active { color: var(--ink); font-weight: 600; }
#steps li.active .step-number { background: var(--ink); border-color: var(--ink); color: #fff; }
#steps li.completed { color: #567364; }
.local { margin: 0; color: var(--muted); font-size: .7rem; line-height: 1.45; white-space: nowrap; text-align: right; }
.stage { max-width: 648px; margin: 0 auto; padding: 3rem 1.5rem 4rem; }
.mobile-progress { display: none; }
.panel { width: 100%; }
.panel.active { animation: arrive 160ms ease-out; }
@keyframes arrive { from { opacity: 0; transform: translateY(3px); } to { opacity: 1; transform: translateY(0); } }
.eyebrow { margin: 0 0 .5rem; color: var(--muted); font-size: .75rem; font-weight: 500; letter-spacing: .01em; }
h1, h2 { margin: 0 0 .65rem; font-size: 1.9rem; line-height: 1.2; font-weight: 650; letter-spacing: -.035em; }
h3 { margin: 0 0 .5rem; font-size: 1rem; font-weight: 600; letter-spacing: -.015em; }
h1:focus, h2:focus { outline: none; }
.lead { margin: 0 0 1.9rem; color: #72757b; font-size: .925rem; line-height: 1.6; max-width: 55ch; }
label { display: block; margin: 1.15rem 0; font-size: .8125rem; font-weight: 550; }
input, select, textarea { display: block; width: 100%; margin-top: .45rem; padding: .7rem .85rem; border: 1px solid #d8dadd; border-radius: 8px; background: #fff; color: var(--ink); font-size: .875rem; font-weight: 400; line-height: 1.5; transition: border-color 120ms, box-shadow 120ms; }
input, select { min-height: 44px; }
textarea { resize: vertical; min-height: 112px; }
input::placeholder, textarea::placeholder { color: #96999f; }
input:focus, select:focus, textarea:focus { outline: none; border-color: var(--accent); box-shadow: 0 0 0 3px #1764db15; }
input:user-invalid, select:user-invalid, textarea:user-invalid { border-color: #bd413b; }
button:focus-visible, a:focus-visible, summary:focus-visible { outline: 3px solid #1764db55; outline-offset: 3px; }
small, .note, .key-note { display: block; color: var(--muted); font-size: .75rem; font-weight: 400; line-height: 1.55; }
small { margin-top: .45rem; }
.note { margin: .75rem 0; }
button, .primary-link { display: inline-flex; justify-content: center; align-items: center; gap: .4rem; min-height: 42px; padding: .65rem 1rem; border: 1px solid transparent; border-radius: 8px; background: #202124; color: #fff; font-size: .8125rem; font-weight: 550; line-height: 1.4; text-decoration: none; cursor: pointer; transition: background 120ms, transform 100ms; }
button:hover, .primary-link:hover { background: #3a3c40; }
button:active, .primary-link:active { transform: scale(.98); }
button:disabled { opacity: .45; cursor: default; }
button.secondary { color: #4b4e54; border-color: var(--line); background: #fff; }
button.secondary:hover { background: #f2f3f4; }
button.small { min-height: 34px; padding: .4rem .75rem; }
.actions { display: flex; justify-content: space-between; gap: .75rem; margin-top: 1.65rem; padding-top: 1.2rem; border-top: 1px solid var(--line); }
.actions-end { justify-content: flex-end; }
.presets { border: 0; padding: 0; margin: 1.65rem 0 1.4rem; }
.presets legend { margin-bottom: .6rem; font-size: .8125rem; font-weight: 550; }
.preset-grid { display: grid; grid-template-columns: repeat(3, 1fr); gap: .6rem; }
.preset { position: relative; display: block; padding: .85rem; min-height: 96px; text-align: left; color: var(--ink); border: 1px solid var(--line); background: #fff; font-weight: 400; }
.preset:hover { background: #f5f6f8; border-color: #b7bbc2; }
.preset.selected { border-color: #7ea6e1; background: #f0f5fc; box-shadow: 0 0 0 1px #7ea6e130; }
.preset strong { display: block; margin-bottom: .35rem; font-size: .8125rem; font-weight: 600; line-height: 1.4; }
.preset span { display: block; color: #797e87; font-size: .75rem; font-weight: 400; line-height: 1.5; }
.advanced { margin: 1.25rem 0; padding: .85rem 0; border-top: 1px solid var(--line); border-bottom: 1px solid var(--line); }
summary { cursor: pointer; color: #5f636b; font-size: .8125rem; font-weight: 500; }
.advanced[open] summary { margin-bottom: .75rem; }
.permission-list { margin: .75rem 0 1.25rem; }
.permission { display: grid; grid-template-columns: 10rem 1fr; gap: .85rem; padding: .65rem 0; font-size: .75rem; }
.permission strong { font-weight: 500; }
.permission span { color: var(--muted); }
#connect-cloudflare { width: 100%; background: #fff; color: var(--ink); border-color: #d8dadd; }
#connect-cloudflare:hover { background: #f0f1f3; }
#oauth-note:empty { display: none; }
.connection-confirmation { display: flex; align-items: center; gap: .75rem; padding: .85rem 1rem; margin-top: .75rem; border: 1px solid #d5e5da; border-radius: 9px; background: #f1f8f3; }
.connection-confirmation strong { font-size: .8125rem; font-weight: 600; }
.connection-confirmation p { margin: .1rem 0 0; color: #587161; font-size: .75rem; }
.connection-check { display: grid; place-items: center; width: 1.5rem; height: 1.5rem; border-radius: 50%; background: #257348; color: white; font-size: .875rem; }
.key-note { margin: -.5rem 0 .25rem; }
.help-link { font-size: .75rem; font-weight: 500; }
.summary { margin: 1.75rem 0; padding: .25rem 1rem; border: 1px solid var(--line); border-radius: 10px; background: #fff; }
.summary > div { display: grid; grid-template-columns: 6rem 1fr; gap: 1rem; padding: .9rem 0; border-bottom: 1px solid #eff0f2; font-size: .8125rem; }
.summary > div:last-child { border-bottom: 0; }
.summary span { color: var(--muted); }
.summary strong { font-weight: 550; }
.summary p { margin: 0; color: #555a63; }
.progress { display: flex; align-items: flex-start; gap: .75rem; margin: 1.25rem 0; padding: 1rem; border-radius: 9px; background: #edf3fc; font-size: .8125rem; }
.progress-mark { flex: 0 0 auto; width: 8px; height: 8px; margin-top: .4rem; border-radius: 50%; background: var(--accent); }
.progress[aria-busy="true"] .progress-mark { animation: pulse 1s ease-in-out infinite; }
@keyframes pulse { 50% { opacity: .35; } }
.progress strong { font-weight: 550; }
.progress p { margin: .2rem 0 0; color: #5e6d82; }
.live-card { display: flex; gap: 1rem; margin: 1.5rem 0; padding: 1.3rem; border: 1px solid #dce6df; border-radius: 12px; background: #f2f7f3; }
.live-icon { display: grid; place-items: center; flex: 0 0 2rem; height: 2rem; border-radius: 50%; background: #dfede3; color: #387149; }
.live-card p { color: var(--muted); font-size: .8125rem; margin: 0 0 1rem; }
.embed-result { margin: 2rem 0 0; padding-top: 1.5rem; border-top: 1px solid var(--line); }
.embed-result textarea { font: .75rem/1.6 ui-monospace, SFMono-Regular, monospace; }
#notice { position: fixed; z-index: 3; top: 1rem; left: 50%; transform: translate(-50%, -4px); width: max-content; max-width: calc(100vw - 2rem); padding: .7rem 1rem; border-radius: 9px; background: #202124; color: #fff; font-size: .8125rem; box-shadow: 0 4px 20px #00000012; opacity: 0; pointer-events: none; transition: opacity 150ms, transform 150ms; }
#notice.show { opacity: 1; transform: translate(-50%, 0); }
.message { display: flex; align-items: center; justify-content: space-between; gap: 1rem; padding: .85rem 1rem; margin-bottom: 1.5rem; border: 1px solid #eed5d2; border-radius: 9px; background: #fdf3f2; color: #94433c; font-size: .8125rem; }
.message p { margin: 0; }
.message button { flex-shrink: 0; }
@media (max-width: 850px) { .sidebar { gap: 1.5rem; } .local { display: none; } #steps { justify-content: flex-end; gap: 1rem; } }
@media (max-width: 600px) {
  .sidebar { padding: 1rem 1.25rem; }
  #steps { display: none; }
  .stage { padding: 1.25rem 1.25rem 2.5rem; }
  .mobile-progress { display: flex; justify-content: space-between; margin-bottom: 1.75rem; color: var(--muted); font-size: .75rem; }
  #mobile-step-name { color: #50545b; }
  h1, h2 { font-size: 1.65rem; }
  .lead { font-size: .875rem; }
  .preset-grid { grid-template-columns: 1fr; gap: .5rem; }
  .preset { min-height: 0; padding: .8rem .9rem; }
  .preset strong { margin-bottom: .15rem; }
  .permission { grid-template-columns: 1fr; gap: .25rem; }
  input, select, textarea { font-size: 1rem; }
  .actions button { min-height: 44px; }
  .summary > div { grid-template-columns: 4.5rem 1fr; gap: .75rem; }
  .message { align-items: flex-start; }
}
@media (prefers-reduced-motion: reduce) { .panel.active, .progress-mark { animation: none !important; } button, .primary-link, #notice { transition: none; } button:active, .primary-link:active { transform: none; } }
@media (prefers-contrast: more) { :root { --muted: #45484d; --line: #84888f; } .lead, small, .note, .preset span { color: #45484d; } }
`;

export const setupScript = `let step = 0;
let status = null;
let launching = false;
let pollTimer = null;
let polling = false;
let retryAction = null;
let lastDefaultModel = "gemini-2.5-flash";

const form = document.querySelector("#wizard");
const panels = [...document.querySelectorAll(".panel")];
const items = [...document.querySelectorAll("#steps li")];
const stepNames = ["Your assistant", "Connect accounts", "Launch", "Try it"];
const providerDefaults = {
  google: { model: "gemini-2.5-flash", label: "Google Gemini API key", url: "https://aistudio.google.com/apikey", help: "Get a key in Google AI Studio ↗" },
  openai: { model: "gpt-5", label: "OpenAI API key", url: "https://platform.openai.com/api-keys", help: "Get a key in the OpenAI dashboard ↗" },
  anthropic: { model: "claude-sonnet-4-5", label: "Anthropic API key", url: "https://console.anthropic.com/settings/keys", help: "Get a key in the Anthropic Console ↗" },
  "workers-ai": { model: "@cf/meta/llama-3.3-70b-instruct-fp8-fast", label: "Provider key", url: "https://dash.cloudflare.com/", help: "Manage Cloudflare Workers AI ↗" },
};
const presets = {
  support: { name: "Support assistant", prompt: "Help visitors use this product. Give short and accurate answers. Say when you do not know." },
  docs: { name: "Docs guide", prompt: "Help visitors understand our documentation. Explain concepts in plain language, point to the next useful step, and say when the documentation does not answer a question." },
  sales: { name: "Sales assistant", prompt: "Learn what visitors need, answer questions about this product, and suggest a helpful next step. Be clear, honest, and concise." },
};

function field(name) {
  return form.elements.namedItem(name);
}

function value(name) {
  const node = field(name);
  return node ? String(node.value || "") : "";
}

function notice(message) {
  const node = document.querySelector("#notice");
  node.textContent = message;
  node.className = "show";
  clearTimeout(notice.timer);
  notice.timer = window.setTimeout(() => { node.className = ""; }, 6000);
}

function clearNotice() {
  const node = document.querySelector("#notice");
  clearTimeout(notice.timer);
  node.className = "";
  node.textContent = "";
}

function showError(message, retry) {
  const node = document.querySelector("#error");
  document.querySelector("#error-message").textContent = message;
  const button = document.querySelector("#error-retry");
  retryAction = retry || null;
  button.hidden = !retryAction;
  node.hidden = false;
}

function clearError() {
  retryAction = null;
  document.querySelector("#error").hidden = true;
}

async function retryError() {
  const action = retryAction;
  if (!action) return;
  const button = document.querySelector("#error-retry");
  button.disabled = true;
  try { await action(); } finally { button.disabled = false; }
}

async function readStatus() {
  const response = await fetch("/api/status", { headers: { accept: "application/json" }, cache: "no-store" });
  let data = {};
  try { data = await response.json(); } catch (_) { /* The error below is more useful than a JSON parse error. */ }
  if (!response.ok) throw new Error(data.error || "The setup status could not be loaded.");
  return data;
}

async function api(path, body = {}) {
  const response = await fetch(path, {
    method: "POST",
    headers: { "content-type": "application/json", accept: "application/json" },
    body: JSON.stringify(body),
  });
  let data = {};
  try { data = await response.json(); } catch (_) { /* The error below is more useful than a JSON parse error. */ }
  if (!response.ok) throw new Error(data.error || "The setup action failed.");
  return data;
}

function collectDraft() {
  return {
    agentName: value("agentName").trim(),
    systemPrompt: value("systemPrompt").trim(),
    workerName: value("workerName").trim(),
    provider: value("provider"),
    model: value("model").trim(),
    accountId: value("accountId").trim(),
  };
}

function collectProject() {
  const data = collectDraft();
  const providerKey = value("providerKey").trim();
  if (providerKey && value("provider") !== "workers-ai") data.providerKey = providerKey;
  return data;
}

let draftQueue = Promise.resolve();
let draftTimer;
async function saveDraft(targetStep = step) {
  clearTimeout(draftTimer);
  const draft = { ...collectDraft(), step: Math.min(targetStep, 2) };
  try {
    draftQueue = draftQueue.catch(() => undefined).then(() => api("/api/draft", draft));
    await draftQueue;
    return true;
  } catch (error) {
    showError(error.message || "The draft could not be saved.", saveDraft);
    return false;
  }
}

function validateStage(index) {
  const names = index === 0
    ? ["agentName", "systemPrompt"]
    : index === 1 ? ["accountId", "provider", "workerName", "model", "providerKey"] : [];
  for (const name of names) {
    const node = field(name);
    if (!node || node.disabled || node.checkValidity()) continue;
    if (step !== index) setStep(index);
    if (name === "accountId" && !node.value) {
      showError("Connect your Cloudflare account to continue.", connectCloudflare);
      document.querySelector("#connect-cloudflare").focus();
      return false;
    }
    if (name === "workerName" || name === "model" || name === "providerKey") document.querySelector("#advanced-details").open = true;
    node.reportValidity();
    node.focus();
    return false;
  }
  return true;
}

async function moveTo(next) {
  const bounded = Math.max(0, Math.min(next, panels.length - 1));
  if (bounded === step) return;
  clearError();
  clearNotice();
  if (bounded > step && !validateStage(step)) return;
  if (!(await saveDraft(bounded))) return;
  setStep(bounded);
}

function setStep(next, focus = true) {
  step = Math.max(0, Math.min(next, panels.length - 1));
  panels.forEach((panel, index) => {
    const active = index === step;
    panel.classList.toggle("active", active);
    panel.hidden = !active;
    panel.setAttribute("aria-hidden", String(!active));
  });
  items.forEach((item, index) => {
    item.classList.toggle("active", index === step);
    item.classList.toggle("completed", index < step);
    if (index === step) item.setAttribute("aria-current", "step");
    else item.removeAttribute("aria-current");
  });
  document.querySelector("#mobile-step").textContent = "Step " + (step + 1) + " of 4";
  document.querySelector("#mobile-step-name").textContent = stepNames[step];
  window.scrollTo(0, 0);
  if (step === 2) updateSummary();
  if (focus) {
    const heading = panels[step].querySelector("h1, h2");
    if (heading) window.requestAnimationFrame(() => heading.focus({ preventScroll: true }));
  }
}

function renderConnection() {
  const connected = Boolean(status && status.cloudflareConnected);
  const button = document.querySelector("#connect-cloudflare");
  button.textContent = connected ? "Check connection" : "Connect Cloudflare";
  document.querySelector("#cloudflare-connected").hidden = !connected;
  const account = field("account");
  document.querySelector("#connected-account").textContent = connected
    ? "Account access verified" + (account.selectedOptions[0] ? " · " + account.selectedOptions[0].textContent : "")
    : "";
}

function renderAccounts() {
  const select = field("account");
  const previous = select.value || (status && status.config && status.config.accountId) || "";
  select.replaceChildren();
  const accounts = (status && Array.isArray(status.accounts)) ? status.accounts : [];
  document.querySelector("#account-field").hidden = !accounts.length;
  if (!accounts.length) {
    const option = document.createElement("option");
    option.value = "";
    option.textContent = "Connect an account first";
    select.append(option);
  } else {
    for (const account of accounts) {
      if (!account || typeof account.id !== "string") continue;
      const option = document.createElement("option");
      option.value = account.id;
      option.textContent = typeof account.name === "string" ? account.name : account.id;
      select.append(option);
    }
  }
  if (previous && [...select.options].some((option) => option.value === previous)) select.value = previous;
}

function renderProvider() {
  const provider = value("provider");
  const details = providerDefaults[provider] || providerDefaults.google;
  const keyInput = document.querySelector("#provider-key");
  const keyWrap = document.querySelector("#provider-key-wrap");
  const hasKey = Boolean(status && status.config && status.config.hasProviderKey && status.config.provider === provider);
  const workersAi = provider === "workers-ai";
  document.querySelector("#provider-key-label").firstChild.textContent = details.label;
  document.querySelector("#key-help").href = details.url;
  document.querySelector("#key-help").textContent = details.help;
  keyInput.hidden = workersAi;
  keyInput.disabled = workersAi;
  keyInput.required = !workersAi && !hasKey;
  keyWrap.querySelector(".key-note").textContent = workersAi
    ? "No provider key is needed for Cloudflare Workers AI."
    : "Saved on this computer. Sent to your Cloudflare account when you launch.";
  document.querySelector("#key-help").hidden = false;
}

function updateSummary() {
  document.querySelector("#summary-name").textContent = value("agentName") || "Your assistant";
  const prompt = value("systemPrompt").trim();
  document.querySelector("#summary-prompt").textContent = prompt || "Add instructions for your assistant.";
  const select = field("account");
  document.querySelector("#summary-account").textContent = select.selectedOptions[0] ? select.selectedOptions[0].textContent : "Choose an account";
}

function renderProgress() {
  const box = document.querySelector("#launch-progress");
  const progress = status && status.progress;
  const message = progress && typeof progress.message === "string" ? progress.message : "";
  const stageLabels = { idle: "Getting ready", prepare: "Preparing project", prepared: "Project ready", account: "Connecting account", build: "Building assistant", validate: "Checking response", publish: "Publishing assistant", verify: "Checking live widget", complete: "Ready", error: "Needs attention" };
  const stageKey = progress && typeof progress.stage === "string" ? progress.stage : "idle";
  const stageName = stageLabels[stageKey] || stageKey.replace(/[-_]+/g, " ").replace(/^./, (letter) => letter.toUpperCase());
  const visible = Boolean(status && (status.busy || message));
  box.hidden = !visible;
  box.setAttribute("aria-busy", status && status.busy ? "true" : "false");
  document.querySelector("#progress-stage").textContent = stageName;
  document.querySelector("#progress-message").textContent = message || "Getting things ready…";
  const launchButton = document.querySelector("#launch");
  launchButton.disabled = launching || Boolean(status && status.busy);
  if (!launching) launchButton.textContent = status && status.busy ? "Launch in progress…" : "Launch assistant";
}

function renderLive() {
  const hasWidget = Boolean(status && status.widgetUrl);
  document.querySelector("#embed-result").hidden = !hasWidget;
  if (!hasWidget) return;
  const link = document.querySelector("#widget-link");
  link.href = status.widgetUrl;
  document.querySelector("#embed").value = status.embedCode || "";
  document.querySelector("#react-path").textContent = status.reactExample ? "React example: " + status.reactExample : "";
}

function renderStatus() {
  renderAccounts();
  renderConnection();
  renderProvider();
  updateSummary();
  renderProgress();
  renderLive();
}

function stopPolling() {
  polling = false;
  if (pollTimer !== null) window.clearTimeout(pollTimer);
  pollTimer = null;
}

function startPolling() {
  stopPolling();
  polling = true;
  const tick = async () => {
    if (!polling) return;
    try {
      status = await readStatus();
      renderStatus();
      if (!launching && !status.busy) {
        if (status.phase === "deployed" && status.widgetUrl) setStep(3);
        else if (status.error) showError(status.error, launchAssistant);
      }
    } catch (_) {
      // The launch request owns the persistent error. Keep trying status so a temporary read failure recovers.
    }
    if (polling && (launching || (status && status.busy))) pollTimer = window.setTimeout(tick, 900);
    else if (polling) stopPolling();
  };
  void tick();
}

async function connectCloudflare() {
  clearError();
  if (!(await saveDraft())) return;
  const button = document.querySelector("#connect-cloudflare");
  button.disabled = true;
  button.textContent = "Connecting…";
  try {
    if (status && status.oauthSupported && status.cloudflareConnected) {
      status = await readStatus();
      renderStatus();
      return;
    }
    if (status && status.oauthSupported) {
      const data = await api("/api/cloudflare/oauth");
      if (!data.authorizationUrl) throw new Error("Cloudflare did not return an authorization URL.");
      window.location.assign(data.authorizationUrl);
      return;
    }
    status = await api("/api/cloudflare/wrangler");
    renderStatus();
    notice("Cloudflare is connected. Choose an account to continue.");
  } catch (error) {
    showError(error.message || "Cloudflare could not be connected.", connectCloudflare);
  } finally {
    button.disabled = false;
    renderConnection();
  }
}

async function launchAssistant() {
  if (launching || !validateStage(1)) return;
  clearError();
  launching = true;
  const button = document.querySelector("#launch");
  button.disabled = true;
  button.textContent = "Launching…";
  startPolling();
  try {
    if (!(await saveDraft())) return;
    status = await api("/api/project", collectProject());
    renderStatus();
    status = await api("/api/deploy");
    renderStatus();
    if (!status.widgetUrl) throw new Error("Deployment finished without a live widget URL.");
    stopPolling();
    setStep(3);
    notice("Your assistant is ready. Try it in the new tab.");
  } catch (error) {
    stopPolling();
    try { status = await readStatus(); renderStatus(); } catch (_) { /* Keep the original failure visible. */ }
    showError(error.message || "Launch failed.", launchAssistant);
  } finally {
    launching = false;
    button.disabled = Boolean(status && status.busy);
    button.textContent = status && status.busy ? "Launch in progress…" : "Launch assistant";
  }
}

async function copyEmbed() {
  const embed = document.querySelector("#embed").value;
  if (!embed) return;
  try {
    await navigator.clipboard.writeText(embed);
    notice("Embed code copied.");
  } catch (_) {
    showError("The embed code could not be copied. Select it and copy it manually.", copyEmbed);
  }
}

function selectPreset(name) {
  const preset = presets[name];
  if (!preset) return;
  field("agentName").value = preset.name;
  field("systemPrompt").value = preset.prompt;
  document.querySelectorAll("[data-preset]").forEach((button) => {
    const selected = button.dataset.preset === name;
    button.classList.toggle("selected", selected);
    button.setAttribute("aria-pressed", String(selected));
  });
}

function providerChanged() {
  field("providerKey").value = "";
  const details = providerDefaults[value("provider")] || providerDefaults.google;
  const model = field("model");
  if (!model.value || model.value === lastDefaultModel) model.value = details.model;
  lastDefaultModel = details.model;
  renderProvider();
}

async function load() {
  try {
    status = await readStatus();
    if (!status.busy && !status.oauthSupported && !status.cloudflareConnected) {
      document.querySelector("#connect-cloudflare").textContent = "Checking connection…";
      document.querySelector("#connect-cloudflare").disabled = true;
      try { status = await api("/api/cloudflare/check"); } catch (_) { /* Keep Connect available when the read-only check fails. */ }
      finally { document.querySelector("#connect-cloudflare").disabled = false; }
    }
    const config = status.config || {};
    for (const name of ["accountId", "workerName", "agentName", "systemPrompt", "provider", "model"]) {
      const node = field(name);
      if (node && typeof config[name] === "string" && config[name]) node.value = config[name];
    }
    document.querySelectorAll("[data-preset]").forEach((button) => {
      const preset = presets[button.dataset.preset];
      const selected = preset && preset.name === value("agentName") && preset.prompt === value("systemPrompt");
      button.classList.toggle("selected", Boolean(selected));
      button.setAttribute("aria-pressed", String(Boolean(selected)));
    });
    lastDefaultModel = (providerDefaults[value("provider")] || providerDefaults.google).model;
    renderStatus();
    const initialStep = status.busy ? 2 : status.phase === "deployed" && status.widgetUrl ? 3 : status.phase === "configured" ? 2 : status.phase === "connected" ? Math.max(1, Math.min(status.step || 1, 2)) : Math.min(status.step || 0, 1);
    setStep(initialStep, false);
    if (new URLSearchParams(window.location.search).get("connected") === "1") notice("Cloudflare is connected. Choose an account to continue.");
    if (typeof status.error === "string" && status.error) {
      const retry = initialStep === 0 || initialStep === 1 ? connectCloudflare : initialStep === 2 ? launchAssistant : load;
      showError(status.error, retry);
    }
    if (status.busy) startPolling();
  } catch (error) {
    showError(error.message || "The setup could not be loaded.", load);
  }
}

form.addEventListener("input", (event) => {
  if (!event.target.name || event.target.name === "providerKey" || launching || (status && status.busy)) return;
  clearTimeout(draftTimer);
  draftTimer = window.setTimeout(() => { void saveDraft(); }, 500);
});
form.addEventListener("submit", (event) => event.preventDefault());
document.querySelectorAll("[data-next]").forEach((button) => button.addEventListener("click", () => { void moveTo(step + 1); }));
document.querySelectorAll("[data-back]").forEach((button) => button.addEventListener("click", () => { void moveTo(step - 1); }));
document.querySelectorAll("[data-preset]").forEach((button) => button.addEventListener("click", () => selectPreset(button.dataset.preset)));
document.querySelector("#provider").addEventListener("change", providerChanged);
document.querySelector("#account").addEventListener("change", () => { updateSummary(); renderConnection(); });
document.querySelector("#connect-cloudflare").addEventListener("click", () => { void connectCloudflare(); });
document.querySelector("#launch").addEventListener("click", () => { void launchAssistant(); });
document.querySelector("#copy").addEventListener("click", () => { void copyEmbed(); });
document.querySelector("#error-retry").addEventListener("click", () => { void retryError(); });
load();
`;
