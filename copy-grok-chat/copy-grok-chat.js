// ==UserScript==
// @name         Grok – Copy Full Chat
// @namespace    https://github.com/yourname/copy-full-chat
// @version      1.0.0
// @description  Adds a button to grok.com chats that copies or downloads the ENTIRE conversation as Markdown, not just the rendered part.
// @match        https://grok.com/*
// @grant        none
// @run-at       document-idle
// ==/UserScript==

/*
 * How it works
 * ------------
 * Instead of scraping the page, this script asks grok.com's own backend (the
 * same endpoints the web app uses, with your existing session cookies) for the
 * full conversation, follows one branch of it, and turns it into Markdown.
 *
 * Usage
 * -----
 *   Click              → copy chat (messages + short notes for images/files)
 *   Shift + Click      → copy FULL detail (also thinking trace and web sources)
 *   Alt/Option + Click → download as a .md file instead of copying
 *                        (combine with Shift for full detail)
 *
 * Note: the endpoints are undocumented and may change; if the button reports an
 * error, the API shape probably changed.
 */

(function () {
  'use strict';

  const BTN_ID = 'cfc-grok-copy-full-chat-btn';
  const API = '/rest/app-chat/conversations/';
  let cachedText = null; // used if clipboard write fails after the async fetch

  // ---------- helpers ----------

  function getConversationId() {
    const m = location.pathname.match(/\/c\/([0-9a-zA-Z-]{16,})/);
    return m ? m[1] : null;
  }

  async function getJson(url, options = {}) {
    const res = await fetch(url, {
      credentials: 'include',
      ...options,
      headers: { 'Content-Type': 'application/json', ...(options.headers || {}) }
    });
    if (!res.ok) throw new Error(`Request failed (${res.status})`);
    return res.json();
  }

  async function fetchConversation(convId) {
    // 1. Title (optional – don't fail the export if this endpoint changes)
    let title = '';
    try {
      const meta = await getJson(API + convId);
      title = meta?.conversation?.title || meta?.title || '';
    } catch (_) {}

    // 2. Tree of response ids
    let nodesRes;
    try {
      nodesRes = await getJson(API + convId + '/response-node?includeThreads=true');
    } catch (e) {
      throw new Error('Could not load conversation (' + e.message.replace(/\D+/g, '') + ')');
    }
    const nodes = nodesRes.responseNodes || [];
    if (!nodes.length) throw new Error('Conversation is empty');

    // 3. Full content of every response, in batches
    const ids = nodes.map(n => n.responseId);
    const responses = [];
    for (let i = 0; i < ids.length; i += 50) {
      const r = await getJson(API + convId + '/load-responses', {
        method: 'POST',
        body: JSON.stringify({ responseIds: ids.slice(i, i + 50) })
      });
      responses.push(...(r.responses || []));
    }

    // Fill in parent links from the node list if the responses lack them.
    const parentOf = new Map(nodes.map(n => [n.responseId, n.parentResponseId]));
    for (const r of responses) {
      if (!r.parentResponseId && parentOf.get(r.responseId)) r.parentResponseId = parentOf.get(r.responseId);
    }
    return { title, responses };
  }

  function ts(r) {
    const t = Date.parse(r.createTime || '');
    return isNaN(t) ? 0 : t;
  }

  // Grok doesn't report which branch is on screen, so follow the most
  // recently created message back to the root (= the latest branch).
  function activeBranch(responses) {
    const byId = new Map(responses.map(r => [r.responseId, r]));
    const hasChild = new Set(responses.map(r => r.parentResponseId).filter(Boolean));
    const leaves = responses.filter(r => !hasChild.has(r.responseId));
    leaves.sort((a, b) => ts(a) - ts(b));
    let cur = leaves[leaves.length - 1];

    const chain = [];
    const seen = new Set();
    while (cur && !seen.has(cur.responseId)) {
      seen.add(cur.responseId);
      chain.push(cur);
      cur = cur.parentResponseId ? byId.get(cur.parentResponseId) : null;
    }
    chain.reverse();

    // If links were missing entirely, fall back to all messages by time.
    if (chain.length < 2 && responses.length > 1) {
      return responses.slice().sort((a, b) => ts(a) - ts(b));
    }
    return chain;
  }

  function quote(text) {
    return String(text).split('\n').map(l => '> ' + l).join('\n');
  }

  // Strip Grok's inline render/citation tags and tool cards.
  function cleanText(t) {
    return String(t || '')
      .replace(/<grok:render[\s\S]*?<\/grok:render>/g, '')
      .replace(/<xai:tool_usage_card[\s\S]*?<\/xai:tool_usage_card>/g, '')
      .replace(/<grok:[^>]*\/>/g, '')
      .replace(/\n{3,}/g, '\n\n')
      .trim();
  }

  function responseToMd(r, full) {
    const isUser = String(r.sender || '').toLowerCase() === 'human';
    const parts = [];

    if (!isUser && full && r.thinkingTrace && String(r.thinkingTrace).trim()) {
      parts.push('> **Thinking**\n>\n' + quote(String(r.thinkingTrace).trim()));
    }

    const text = isUser ? String(r.message || r.query || '').trim() : cleanText(r.message);
    if (text) parts.push(text);

    const n = (x) => (Array.isArray(x) ? x.length : 0);
    if (n(r.imageAttachments)) parts.push(`*[${n(r.imageAttachments)} image attachment(s)]*`);
    if (n(r.fileAttachments)) parts.push(`*[${n(r.fileAttachments)} file attachment(s)]*`);
    if (n(r.generatedImageUrls)) parts.push(`*[${n(r.generatedImageUrls)} generated image(s)]*`);

    if (!isUser && full && n(r.webSearchResults)) {
      const src = r.webSearchResults
        .filter(w => w && w.url)
        .map(w => `- [${(w.title || w.url).replace(/[\[\]]/g, '')}](${w.url})`);
      if (src.length) parts.push('**Sources**\n\n' + src.join('\n'));
    }

    if (!parts.length) return null;
    return { speaker: isUser ? 'User' : 'Grok', text: parts.join('\n\n') };
  }

  function conversationToMd(conv, full) {
    const title = conv.title || 'Grok conversation';
    const turns = activeBranch(conv.responses)
      .map(r => responseToMd(r, full))
      .filter(Boolean);
    const header = `# ${title}\n\n` +
      `*Exported from Grok on ${new Date().toLocaleString()} — ${turns.length} messages*`;
    const body = turns.map(t => `## ${t.speaker}\n\n${t.text}`);
    return { md: [header, ...body].join('\n\n---\n\n') + '\n', count: turns.length, title };
  }

  // ---------- clipboard / download ----------

  async function copyText(text) {
    try {
      await navigator.clipboard.writeText(text);
      return true;
    } catch (_) {
      const ta = document.createElement('textarea');
      ta.value = text;
      ta.style.cssText = 'position:fixed;top:-9999px;opacity:0';
      document.body.appendChild(ta);
      ta.select();
      let ok = false;
      try { ok = document.execCommand('copy'); } catch (_) {}
      ta.remove();
      return ok;
    }
  }

  function download(text, title) {
    const safe = (title || 'grok-chat').replace(/[\\/:*?"<>|]+/g, '_').slice(0, 100);
    const blob = new Blob([text], { type: 'text/markdown;charset=utf-8' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = safe + '.md';
    document.body.appendChild(a);
    a.click();
    setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 1000);
  }

  // ---------- UI ----------

  function setLabel(btn, text, resetMs) {
    btn.textContent = text;
    if (resetMs) {
      clearTimeout(btn._t);
      btn._t = setTimeout(() => { btn.textContent = '📋 Copy chat'; }, resetMs);
    }
  }

  async function onClick(e) {
    const btn = e.currentTarget;
    const full = e.shiftKey;
    const toFile = e.altKey;

    if (cachedText && !toFile) {
      const ok = await copyText(cachedText);
      cachedText = null;
      setLabel(btn, ok ? '✅ Copied!' : '❌ Copy failed', 2500);
      return;
    }

    const convId = getConversationId();
    if (!convId) return setLabel(btn, 'Not in a chat', 2000);

    setLabel(btn, '⏳ Loading…');
    try {
      const conv = await fetchConversation(convId);
      const { md, count, title } = conversationToMd(conv, full);

      if (toFile) {
        download(md, title);
        setLabel(btn, '✅ Downloaded', 2500);
        return;
      }

      const ok = await copyText(md);
      if (ok) {
        setLabel(btn, `✅ Copied ${count} msgs${full ? ' (full)' : ''}`, 2500);
      } else {
        cachedText = md;
        setLabel(btn, '👆 Ready – click again to copy');
      }
    } catch (err) {
      console.error('[Copy Full Chat]', err);
      setLabel(btn, '❌ ' + (err.message || 'Error'), 4000);
    }
  }

  function ensureButton() {
    const inChat = !!getConversationId();
    let btn = document.getElementById(BTN_ID);

    if (!inChat) {
      if (btn) btn.remove();
      cachedText = null;
      return;
    }
    if (btn) return;

    btn = document.createElement('button');
    btn.id = BTN_ID;
    btn.type = 'button';
    btn.textContent = '📋 Copy chat';
    btn.title = 'Click: copy whole chat as Markdown\n' +
                'Shift+Click: include thinking and web sources\n' +
                'Alt+Click: download as .md';
    btn.style.cssText = [
      'position:fixed', 'top:72px', 'right:16px', 'z-index:2147483647',
      'padding:6px 12px', 'border-radius:8px', 'border:1px solid rgba(128,128,128,.4)',
      'background:rgba(40,40,40,.85)', 'color:#fff', 'font:13px/1.2 system-ui,sans-serif',
      'cursor:pointer', 'box-shadow:0 2px 8px rgba(0,0,0,.25)', 'backdrop-filter:blur(4px)'
    ].join(';');
    btn.addEventListener('click', onClick);
    document.body.appendChild(btn);
  }

  // grok.com is a single-page app: watch for URL changes.
  let lastPath = '';
  setInterval(() => {
    if (location.pathname !== lastPath) {
      lastPath = location.pathname;
      cachedText = null;
    }
    ensureButton();
  }, 800);
})();
