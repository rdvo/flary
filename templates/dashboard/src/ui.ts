export function dashboardHtml(setupOpen: boolean, signedIn = false): string {
  return `<!doctype html>
<html>
  <head>
    <meta charset="utf-8">
    <meta name="viewport" content="width=device-width,initial-scale=1">
    <title>Flary</title>
    <style>${styles}</style>
  </head>
  <body>
    <div class="shell">
      <nav>
        <span class="brand">Flary</span>
        <a href="/">Threads</a>
        <a href="/connections">Connections</a>
        <a href="/settings">Secret health</a>
      </nav>
      <main>${setupOpen ? setupPage() : signedIn ? appPage() : loginPage()}</main>
    </div>
    <script>${clientScript()}</script>
  </body>
</html>`;
}

function setupPage(): string {
  return `<section class="card">
    <h1>Create the first owner</h1>
    <p class="muted">Copy <code>FLARY_SETUP_TOKEN</code> from <code>.dev.vars</code>. Registration closes after this owner is created.</p>
    <form id="setup">
      <input name="token" type="password" placeholder="Setup token" required>
      <input name="name" placeholder="Name" required>
      <input name="email" type="email" placeholder="Email" required>
      <input name="password" type="password" minlength="10" placeholder="Password (10+ characters)" required>
      <button>Create owner</button>
    </form>
    <pre id="result"></pre>
  </section>`;
}

function loginPage(): string {
  return `<section class="card">
    <h1>Sign in</h1>
    <form id="login">
      <input name="email" type="email" placeholder="Email" required>
      <input name="password" type="password" placeholder="Password" required>
      <button>Sign in</button>
    </form>
    <pre id="result"></pre>
  </section>`;
}

function appPage(): string {
  return `<h1>Your Flary</h1>
    <div class="grid">
      <section class="card">
        <h2>Assistant</h2>
        <p>Create a durable thread, send messages, and reconnect from its saved cursor.</p>
        <button id="new-thread">New thread</button>
        <div id="threads"></div>
      </section>
      <section class="card">
        <h2>Connections</h2>
        <p>Check the active deployment provider or authorize an optional subscription connection.</p>
        <a href="/connections">Manage connections</a>
      </section>
      <section class="card">
        <h2>Deployment</h2>
        <p>Review required-secret health without showing any secret value.</p>
        <a href="/settings">Check secret health</a>
      </section>
    </div>
    <section class="card">
      <h2>Thread console</h2>
      <textarea id="message" rows="4" placeholder="Send a message"></textarea>
      <button id="send">Send</button>
      <pre id="events">Create or open a thread. Flary saves the replay cursor in this browser.</pre>
    </section>`;
}

function clientScript(): string {
  return `
const setup = document.querySelector('#setup');
if (setup) setup.addEventListener('submit', async (event) => {
  event.preventDefault();
  const response = await fetch('/api/setup', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(Object.fromEntries(new FormData(setup))),
  });
  document.querySelector('#result').textContent = await response.text();
  if (response.ok) location.href = '/';
});

const login = document.querySelector('#login');
if (login) login.addEventListener('submit', async (event) => {
  event.preventDefault();
  const response = await fetch('/api/auth/sign-in/email', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(Object.fromEntries(new FormData(login))),
  });
  document.querySelector('#result').textContent = await response.text();
  if (response.ok) location.reload();
});

let activeThread;
let cursor = 0;
let replayTimer;

async function request(url, init) {
  const response = await fetch(url, init);
  const value = await response.json();
  if (!response.ok) throw new Error(value?.error?.message || value?.error || 'Request failed');
  return value;
}

async function loadThreads() {
  const target = document.querySelector('#threads');
  if (!target) return;
  const value = await request('/apps/assistant/threads');
  target.replaceChildren();
  for (const item of value.threads) {
    const button = document.createElement('button');
    button.textContent = item.metadata?.title || item.thread.threadId;
    button.onclick = () => openThread(item.thread.threadId);
    target.append(button, ' ');
  }
}

async function openThread(id) {
  activeThread = id;
  cursor = Number(localStorage.getItem('flary-cursor:' + id) || 0);
  clearInterval(replayTimer);
  await replay();
  replayTimer = setInterval(replay, 1500);
}

async function replay() {
  if (!activeThread) return;
  const value = await request('/apps/assistant/threads/' + encodeURIComponent(activeThread) + '/turns?after=' + cursor + '&limit=100');
  const turns = value.turns || [];
  if (!turns.length) return;
  document.querySelector('#events').textContent += JSON.stringify(turns, null, 2) + '\\n';
  cursor = Math.max(cursor, ...turns.map((item) => Number(item.sequence || item.sessionSequence || 0)));
  localStorage.setItem('flary-cursor:' + activeThread, String(cursor));
}

document.querySelector('#new-thread')?.addEventListener('click', async () => {
  const workspaceId = crypto.randomUUID();
  const value = await request('/apps/assistant/threads', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      agentId: 'assistant',
      workspace: {
        organizationId: 'personal',
        appId: 'assistant',
        projectId: 'default',
        workspaceId,
        branch: 'main',
      },
    }),
  });
  await loadThreads();
  await openThread(value.binding.thread.threadId);
});

document.querySelector('#send')?.addEventListener('click', async () => {
  if (!activeThread) return alert('Create or open a thread first.');
  const textarea = document.querySelector('#message');
  await request('/apps/assistant/threads/' + encodeURIComponent(activeThread) + '/messages', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ message: textarea.value, idempotencyKey: crypto.randomUUID() }),
  });
  textarea.value = '';
  await replay();
});

loadThreads().catch((error) => {
  const events = document.querySelector('#events');
  if (events) events.textContent = error.message;
});`;
}

export function connectionsHtml(): string {
  return `<!doctype html>
<meta name="viewport" content="width=device-width">
<title>Connections · Flary</title>
<style>${connectionStyles}</style>
<a href="/">← Flary</a>
<h1>Connections</h1>
<section>
  <h2>Active provider</h2>
  <p>The provider selected by <code>flary setup</code> is ready for agent calls. Deployment-managed keys remain Worker secrets.</p>
</section>
<section>
  <h2>Subscription authorization</h2>
  <p>Authorize and store an encrypted ChatGPT/Codex or Claude Pro/Max connection. A trusted model resolver must select it before an agent turn uses it.</p>
  <button data-provider="openai-codex">Connect ChatGPT</button>
  <button data-provider="anthropic">Connect Claude</button>
</section>
<section id="complete" hidden>
  <h2>Complete authorization</h2>
  <input id="authorization-result" placeholder="Paste the code or callback URL">
  <button id="finish">Complete</button>
</section>
<pre id="connection-result"></pre>
<section>
  <h2>MCP servers</h2>
  <p>Paste one HTTPS MCP URL. Flary discovers the server login, receives the OAuth callback, encrypts the token, and checks the tool list.</p>
  <form id="mcp-form">
    <input name="name" placeholder="Connection name" required>
    <input name="url" type="url" inputmode="url" placeholder="https://mcp.example.com/mcp" required>
    <button>Add MCP server</button>
  </form>
  <div id="mcp-connections"></div>
  <p class="muted">OpenAPI sources still belong in trusted application code. MCP credentials never enter prompts or generated tool code.</p>
</section>
<script>${connectionScript()}</script>`;
}

function connectionScript(): string {
  return `
let sessionId;
let pollTimer;
const output = document.querySelector('#connection-result');

function show(value) {
  output.textContent = JSON.stringify(value, null, 2);
}

async function poll(session) {
  clearTimeout(pollTimer);
  const response = await fetch('/api/connections/oauth/' + session.id + '?poll=1');
  const value = await response.json();
  show(value);
  if (!response.ok || value.status !== 'pending') return;
  pollTimer = setTimeout(() => poll(value), Math.max(2, value.intervalSeconds || 5) * 1000);
}

for (const button of document.querySelectorAll('[data-provider]')) {
  button.addEventListener('click', async () => {
    const response = await fetch('/api/connections/oauth/start', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ provider: button.dataset.provider }),
    });
    const result = await response.json();
    show(result);
    if (!response.ok) return;
    sessionId = result.id;
    if (result.authorizationUrl) window.open(result.authorizationUrl, '_blank', 'noopener');
    if (result.verificationUri) window.open(result.verificationUri, '_blank', 'noopener');
    if (result.method === 'device_code') poll(result);
    else document.querySelector('#complete').hidden = false;
  });
}

document.querySelector('#finish').addEventListener('click', async () => {
  const response = await fetch('/api/connections/oauth/' + sessionId + '/complete', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ authorizationResult: document.querySelector('#authorization-result').value }),
  });
  show(await response.json());
});

const mcpForm = document.querySelector('#mcp-form');
const mcpList = document.querySelector('#mcp-connections');
let mcpPollTimer;

async function loadMcpConnections() {
  if (!mcpList) return;
  const response = await fetch('/api/connections/mcp');
  const value = await response.json();
  if (!response.ok) return show(value);
  mcpList.replaceChildren();
  for (const connection of value.connections || []) {
    const row = document.createElement('div');
    row.className = 'connection-row';
    const details = document.createElement('div');
    const title = document.createElement('strong');
    title.textContent = connection.name + ' · ' + connection.status;
    const endpoint = document.createElement('small');
    endpoint.textContent = connection.url + (typeof connection.toolCount === 'number' ? ' · ' + connection.toolCount + ' tools' : '');
    details.append(title, document.createElement('br'), endpoint);
    const remove = document.createElement('button');
    remove.className = 'secondary';
    remove.textContent = 'Remove';
    remove.onclick = async () => {
      const result = await fetch('/api/connections/mcp/' + encodeURIComponent(connection.id), { method: 'DELETE' });
      if (!result.ok) show(await result.json());
      await loadMcpConnections();
    };
    row.append(details, remove);
    mcpList.append(row);
  }
}

function pollMcpConnection(id) {
  clearTimeout(mcpPollTimer);
  let attempts = 0;
  const next = async () => {
    attempts += 1;
    const response = await fetch('/api/connections/mcp');
    const value = await response.json();
    const connection = value.connections?.find((item) => item.id === id);
    if (connection?.status === 'ready' || connection?.status === 'error' || attempts >= 150) {
      show(connection || value);
      await loadMcpConnections();
      return;
    }
    mcpPollTimer = setTimeout(next, 2000);
  };
  mcpPollTimer = setTimeout(next, 1200);
}

mcpForm?.addEventListener('submit', async (event) => {
  event.preventDefault();
  const response = await fetch('/api/connections/mcp', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(Object.fromEntries(new FormData(mcpForm))),
  });
  const value = await response.json();
  show(value);
  if (!response.ok) return;
  mcpForm.reset();
  await loadMcpConnections();
  if (value.authorizationUrl) {
    window.open(value.authorizationUrl, '_blank', 'noopener');
    pollMcpConnection(value.id);
  }
});

window.addEventListener('message', async (event) => {
  if (event.origin !== window.location.origin || event.data?.type !== 'flary:mcp-connected') return;
  show(event.data);
  await loadMcpConnections();
});

loadMcpConnections().catch((error) => show({ error: error.message }));`;
}

const styles = `
:root{font-family:Inter,ui-sans-serif,system-ui;color:#18201c;background:#f5f7f5}
body{margin:0}.shell{max-width:1100px;margin:auto;padding:32px}
nav{display:flex;gap:18px;align-items:center;padding:16px 0}.brand{font-weight:800;font-size:20px}
a{color:#176b45;text-decoration:none}.card{background:white;border:1px solid #dce3de;border-radius:14px;padding:22px;margin:18px 0}
input,button,textarea{font:inherit;padding:10px 12px;border-radius:8px;border:1px solid #bdc8c0}
textarea{box-sizing:border-box;width:100%}button{background:#176b45;color:white;border:0;cursor:pointer}
.grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(220px,1fr));gap:14px}.muted{color:#65736a}
pre{white-space:pre-wrap;background:#eef2ef;padding:14px;border-radius:8px}`;

const connectionStyles = `
body{font-family:system-ui;max-width:760px;margin:40px auto;padding:20px}
section{border:1px solid #ddd;border-radius:12px;padding:20px;margin:15px 0}
button,input{font:inherit;padding:9px 12px}input[type=url]{min-width:min(26rem,70vw)}button{cursor:pointer;background:#176b45;color:white;border:0;border-radius:7px}.secondary{background:#e8eee9;color:#244333}.muted,small{color:#65736a}form{display:flex;gap:8px;flex-wrap:wrap}.connection-row{display:flex;align-items:center;justify-content:space-between;gap:16px;border-top:1px solid #e4e8e5;padding:12px 0}pre{white-space:pre-wrap;background:#f3f5f3;padding:12px}`;
