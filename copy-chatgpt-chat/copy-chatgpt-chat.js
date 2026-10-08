// ==UserScript==
// @name         ChatGPT – Copy Full Chat
// @namespace    https://github.com/yourname/copy-full-chat
// @version      1.0.0
// @description  Adds a button to ChatGPT chats that copies the ENTIRE conversation (active branch) as Markdown, not just the rendered part.
// @match        https://chatgpt.com/*
// @match        https://chat.openai.com/*
// @grant        none
// @run-at       document-idle
// ==/UserScript==

/*
 * How it works
 * ------------
 * Instead of scraping the page, this script asks ChatGPT's own backend (the same
 * endpoint the web app uses, authenticated with your current session) for the
 * full conversation, walks the currently selected branch, and turns it into
 * Markdown.
 *
 * Usage
 * -----
 *   Click              → copy chat (text + canvas documents, short tool notes)
 *   Shift + Click      → copy FULL detail (also reasoning summaries, tool
 *                        calls, tool/code outputs)
 *   Alt/Option + Click → download as a .md file instead of copying
 *                        (combine with Shift for full detail)
 *
 * Note: the endpoint is undocumented and may change; if the button reports an
 * error, the API shape probably changed.
 */

(function () {
  'use strict';

  const BTN_ID = 'cfc-chatgpt-copy-full-chat-btn';
  let cachedText = null;   // used if clipboard write fails after the async fetch
  let cachedToken = null;  // access token from /api/auth/session

  // ---------- helpers ----------

  function getConversationId() {
    // Matches /c/<id> and /g/<gizmo>/c/<id>
    const m = location.pathname.match(/\/c\/([0-9a-zA-Z-]{16,})/);
    return m ? m[1] : null;
  }

  function getCookie(name) {
    const m = document.cookie.match(new RegExp('(?:^|; )' + name + '=([^;]*)'));
    return m ? decodeURIComponent(m[1]) : null;
  }

  async function getAccessToken(force) {
    if (cachedToken && !force) return cachedToken;
    const res = await fetch('/api/auth/session', { credentials: 'include' });
    if (!res.ok) throw new Error('Could not get session (' + res.status + ')');
    const s = await res.json();
    if (!s || !s.accessToken) throw new Error('Not logged in');
    cachedToken = s.accessToken;
    return cachedToken;
  }

  async function fetchConversation(convId) {
    const doFetch = async (force) => {
      const headers = { Authorization: 'Bearer ' + await getAccessToken(force) };
      // Team / Enterprise workspaces need the account id header.
      const acct = getCookie('_account');
      if (acct && acct !== 'personal') headers['ChatGPT-Account-Id'] = acct;
      return fetch('/backend-api/conversation/' + convId, { credentials: 'include', headers });
    };
    let res = await doFetch(false);
    if (res.status === 401 || res.status === 403) res = await doFetch(true); // token expired
    if (!res.ok) throw new Error('Could not load conversation (' + res.status + ')');
    return res.json();
  }

  // Walk from the current node up to the root → messages of the visible branch.
  function activeBranch(data) {
    const mapping = data.mapping || {};
    let nodeId = data.current_node;
    if (!nodeId || !mapping[nodeId]) {
      // Fallback: pick the most recently created leaf.
      const leaves = Object.values(mapping).filter(n => !n.children || !n.children.length);
      leaves.sort((a, b) => (a.message?.create_time || 0) - (b.message?.create_time || 0));
      nodeId = leaves.length ? leaves[leaves.length - 1].id : null;
    }
    const chain = [];
    const seen = new Set();
    while (nodeId && mapping[nodeId] && !seen.has(nodeId)) {
      seen.add(nodeId);
      const node = mapping[nodeId];
      if (node.message) chain.push(node.message);
      nodeId = node.parent;
    }
    return chain.reverse();
  }

  // Code fence that is longer than any backtick run inside the content.
  function fence(content, lang = '') {
    const runs = String(content).match(/`+/g) || [];
    const longest = runs.reduce((n, r) => Math.max(n, r.length), 0);
    const f = '`'.repeat(Math.max(3, longest + 1));
    return `${f}${lang}\n${content}\n${f}`;
  }

  function quote(text) {
    return String(text).split('\n').map(l => '> ' + l).join('\n');
  }

  // Remove ChatGPT's inline citation markers (private-use-area tokens and 【…】 refs).
  function cleanText(t) {
    return String(t)
      .replace(/\ue200[^\ue201]*\ue201/g, '')
      .replace(/【[^】]*】/g, '')
      .replace(/[\ue200-\ue2ff]/g, '');
  }

  function partsToText(parts) {
    if (!Array.isArray(parts)) return '';
    return parts.map(p => {
      if (typeof p === 'string') return p;
      if (p && p.content_type === 'image_asset_pointer') return '*[Image]*';
      if (p && p.content_type === 'audio_transcription') return p.text || '';
      if (p && typeof p.text === 'string') return p.text;
      return '';
    }).filter(Boolean).join('\n\n');
  }

  function isHidden(msg) {
    const md = msg.metadata || {};
    return md.is_visually_hidden_from_conversation ||
           msg.author?.role === 'system' ||
           ['user_editable_context', 'model_editable_context'].includes(msg.content?.content_type);
  }

  // Canvas ("canmore") documents created by the assistant.
  function canvasDoc(msg) {
    const r = msg.recipient || '';
    if (!/^canmore\.(create|update)_textdoc$/.test(r)) return null;
    try {
      const j = JSON.parse(msg.content?.text || '{}');
      if (r.endsWith('create_textdoc') && j.content) {
        const lang = (j.type || '').split('/').pop();
        return `**Canvas: ${j.name || 'untitled'}**\n\n` +
               fence(j.content, /^[\w+-]+$/.test(lang) && lang !== 'document' ? lang : '');
      }
      if (r.endsWith('update_textdoc') && Array.isArray(j.updates)) {
        return '*[Canvas updated]*';
      }
    } catch (_) {}
    return null;
  }

  // Returns Markdown for one message, or '' to skip it.
  function messageToMd(msg, full) {
    if (isHidden(msg)) return '';
    const role = msg.author?.role;
    const c = msg.content || {};
    const type = c.content_type;

    if (role === 'user') {
      let t = type === 'text' || type === 'multimodal_text' ? partsToText(c.parts) : (c.text || '');
      const atts = (msg.metadata?.attachments || []).map(a => `*[Attachment: ${a.name || 'file'}]*`);
      return [t.trim(), ...atts].filter(Boolean).join('\n\n');
    }

    if (role === 'assistant') {
      const recipient = msg.recipient || 'all';

      // Normal visible answer
      if (recipient === 'all' && (type === 'text' || type === 'multimodal_text')) {
        return cleanText(partsToText(c.parts)).trim();
      }

      // Reasoning summaries
      if (type === 'thoughts') {
        if (!full || !Array.isArray(c.thoughts)) return '';
        const body = c.thoughts.map(th =>
          (th.summary ? `**${th.summary}**\n` : '') + (th.content || '')).join('\n\n').trim();
        return body ? '> **Thinking**\n>\n' + quote(body) : '';
      }
      if (type === 'reasoning_recap') return full && c.content ? `*${c.content}*` : '';

      // Tool calls (code interpreter, browsing, canvas, image gen, …)
      const doc = canvasDoc(msg);
      if (doc) return doc;
      if (recipient !== 'all') {
        if (!full) return `*[Tool call: ${recipient}]*`;
        const body = c.text ?? partsToText(c.parts) ?? '';
        const lang = type === 'code' ? (c.language && c.language !== 'unknown' ? c.language : '') : '';
        return `**Tool call: ${recipient}**\n\n` + fence(body, lang);
      }
      return '';
    }

    if (role === 'tool') {
      // Generated images are worth noting even in default mode.
      if (type === 'multimodal_text' && (c.parts || []).some(p => p && p.content_type === 'image_asset_pointer')) {
        return '*[Generated image]*';
      }
      if (!full) return '';
      const name = msg.author?.name || 'tool';
      let body = '';
      if (type === 'execution_output' || type === 'text' || type === 'code') {
        body = c.text ?? partsToText(c.parts);
      } else if (type === 'tether_quote') {
        body = [c.title, c.url, c.text].filter(Boolean).join('\n');
      } else if (type === 'tether_browsing_display') {
        body = c.result || c.summary || '';
      } else if (type === 'multimodal_text') {
        body = partsToText(c.parts);
      }
      body = String(body || '').trim();
      return body ? `**Tool result: ${name}**\n\n` + fence(body) : '';
    }

    return '';
  }

  function conversationToMd(data, full) {
    const title = data.title || 'ChatGPT conversation';
    const msgs = activeBranch(data);

    // Group consecutive assistant/tool messages into one "ChatGPT" turn.
    const turns = [];
    for (const m of msgs) {
      const md = messageToMd(m, full);
      if (!md) continue;
      const speaker = m.author?.role === 'user' ? 'User' : 'ChatGPT';
      const last = turns[turns.length - 1];
      if (last && last.speaker === speaker) last.parts.push(md);
      else turns.push({ speaker, parts: [md] });
    }

    const header = `# ${title}\n\n` +
      `*Exported from ChatGPT on ${new Date().toLocaleString()} — ${turns.length} messages*`;
    const body = turns.map(t => `## ${t.speaker}\n\n${t.parts.join('\n\n')}`);
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
    const safe = (title || 'chatgpt-chat').replace(/[\\/:*?"<>|]+/g, '_').slice(0, 100);
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
      const data = await fetchConversation(convId);
      const { md, count, title } = conversationToMd(data, full);

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
                'Shift+Click: include reasoning, tool calls and outputs\n' +
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

  // ChatGPT is a single-page app: watch for URL changes.
  let lastPath = '';
  setInterval(() => {
    if (location.pathname !== lastPath) {
      lastPath = location.pathname;
      cachedText = null;
    }
    ensureButton();
  }, 800);
})();
