const widgetStyles = `
:host{--flary-ink:#18231f;--flary-paper:#f6f8f7;--flary-accent:#176b52;--flary-line:#d8e1dd;display:block;font:15px/1.5 ui-sans-serif,system-ui,sans-serif;color:var(--flary-ink)}
*{box-sizing:border-box}.panel{width:min(100%,24rem);height:32rem;border:1px solid var(--flary-line);border-radius:18px;background:var(--flary-paper);box-shadow:0 18px 55px #10231b1c;display:grid;grid-template-rows:auto 1fr auto;overflow:hidden}
header{padding:1rem 1.1rem;border-bottom:1px solid var(--flary-line);background:#fff}strong{display:block;font-size:1rem}.status{color:#617069;font-size:.78rem}.messages{padding:1rem;overflow:auto;display:flex;flex-direction:column;gap:.7rem}.message{max-width:86%;padding:.7rem .85rem;border-radius:13px;background:#fff;border:1px solid var(--flary-line);white-space:pre-wrap}.user{align-self:flex-end;background:var(--flary-accent);border-color:var(--flary-accent);color:#fff}.error{color:#8b2e21}form{display:grid;grid-template-columns:1fr auto;gap:.5rem;padding:.8rem;border-top:1px solid var(--flary-line);background:#fff}input,button{font:inherit}input{min-width:0;border:1px solid var(--flary-line);border-radius:10px;padding:.7rem .8rem;color:var(--flary-ink)}button{border:0;border-radius:10px;padding:.7rem .9rem;background:var(--flary-accent);color:#fff;font-weight:700;cursor:pointer}button:disabled{opacity:.55}input:focus-visible,button:focus-visible{outline:3px solid #56b99a66;outline-offset:2px}@media(prefers-reduced-motion:no-preference){.message{animation:enter .18s ease-out}@keyframes enter{from{opacity:0;transform:translateY(4px)}}}
`;

export function widgetScript(): string {
  return `
const source = document.currentScript?.src;
const defaultBase = source ? new URL(source).origin : location.origin;
class FlaryChat extends HTMLElement {
  constructor(){super();this.attachShadow({mode:'open'});this.thread='';this.cursor=0;this.visitor=crypto.randomUUID();this.base=this.getAttribute('base-url')||defaultBase;}
  connectedCallback(){
    const title=this.getAttribute('title')||'Support assistant';
    this.shadowRoot.innerHTML='<style>${widgetStyles.replaceAll(
      "`",
      "\\`",
    )}</style><section class="panel" aria-label="'+escapeHtml(title)+'"><header><strong>'+escapeHtml(title)+'</strong><span class="status">Ready to help</span></header><div class="messages" aria-live="polite"><div class="message">How can I help?</div></div><form><input aria-label="Message" placeholder="Write a message" autocomplete="off" required><button>Send</button></form></section>';
    this.shadowRoot.querySelector('form').addEventListener('submit',(event)=>this.send(event));
  }
  async request(path,init){const headers=new Headers(init?.headers);headers.set('x-flary-widget-session',this.visitor);const response=await fetch(this.base+path,{...init,headers});const value=await response.json();if(!response.ok)throw new Error(value?.error?.message||value?.error||'The chat request failed.');return value;}
  async ensureThread(){if(this.thread)return;const workspaceId=crypto.randomUUID();const value=await this.request('/apps/assistant/threads',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({agentId:'assistant',workspace:{organizationId:'widget',appId:'assistant',projectId:'default',workspaceId,branch:'main'}})});this.thread=value.binding.thread.threadId;}
  add(text,kind='assistant'){const node=document.createElement('div');node.className='message '+kind;node.textContent=text;this.shadowRoot.querySelector('.messages').append(node);node.scrollIntoView({block:'end'});}
  async send(event){event.preventDefault();const input=this.shadowRoot.querySelector('input');const button=this.shadowRoot.querySelector('button');const message=input.value.trim();if(!message)return;this.add(message,'user');input.value='';button.disabled=true;try{await this.ensureThread();await this.request('/apps/assistant/threads/'+encodeURIComponent(this.thread)+'/messages',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({message,idempotencyKey:crypto.randomUUID()})});await this.poll();}catch(error){this.add(error instanceof Error?error.message:'The chat request failed.','error');}finally{button.disabled=false;input.focus();}}
  async poll(){for(let attempt=0;attempt<30;attempt++){const value=await this.request('/apps/assistant/threads/'+encodeURIComponent(this.thread)+'/turns?after='+this.cursor+'&limit=100');const turns=value.turns||[];for(const turn of turns){this.cursor=Math.max(this.cursor,Number(turn.sequence||turn.sessionSequence||0));const text=findText(turn);if(text&&isAssistant(turn))this.add(text);}if(turns.some(isComplete))return;await new Promise(resolve=>setTimeout(resolve,700));}throw new Error('The reply is taking longer than expected. Try again.');}
}
function escapeHtml(value){return String(value).replace(/[&<>"]/g,char=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[char]));}
function findText(value){if(!value||typeof value!=='object')return '';for(const key of ['text','content','message','output']){if(typeof value[key]==='string'&&value[key].trim())return value[key];}for(const child of Object.values(value)){const found=findText(child);if(found)return found;}return '';}
function isAssistant(value){return JSON.stringify(value).includes('assistant')||JSON.stringify(value).includes('output');}
function isComplete(value){const text=JSON.stringify(value);return text.includes('completed')||text.includes('finish')||text.includes('assistant');}
customElements.define('flary-chat',FlaryChat);
`;
}

export function widgetDemo(title = "Support assistant"): string {
  const safeTitle = title.replace(
    /[&<>"]/g,
    (character) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[character]!,
  );
  return `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${safeTitle} · Flary</title><style>body{margin:0;min-height:100vh;display:grid;place-items:center;background:#e8efec;padding:1.5rem}</style></head><body><flary-chat title="${safeTitle}"></flary-chat><script src="/widget.js"></script></body></html>`;
}
