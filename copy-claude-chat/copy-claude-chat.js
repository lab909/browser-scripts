// ==UserScript==
// @name         Claude.ai – Copy Full Chat
// @namespace    https://github.com/yourname/claude-copy-full-chat
// @version      1.0.0
// @description  Adds a button to claude.ai chats that copies the ENTIRE conversation (active branch) as Markdown, not just the rendered part.
// @match        https://claude.ai/*
// @grant        none
// @run-at       document-idle
// ==/UserScript==

/*
 * How it works
 * ------------
 * claude.ai virtualizes long chats, so messages that are scrolled out of view
 * are not in the DOM. Instead of scraping the page, this script asks claude.ai's
 * own backend (the same endpoint the web app uses, with your existing session
 * cookies) for the full conversation, walks the currently selected branch, and
 * turns it into Markdown.
 *
 * Usage
 * -----
 *   Click              → copy chat (text + artifacts, short tool-call notes)
 *   Shift + Click      → copy FULL detail (also thinking, tool inputs/results,
 *                        attachment contents)
 *   Alt/Option + Click → download as a .md file instead of copying
 *                        (combine with Shift for full detail)
 *
 * Note: the endpoint is undocumented and may change; if the button reports an
 * error, the API shape probably changed.
 */

(function () {
  'use strict';

  const BTN_ID = 'cfc-copy-full-chat-btn';
  const ROOT_PARENT = '00000000-0000-4000-8000-000000000000';
  let cachedText = null; // used if clipboard write fails after the async fetch

  // ---------- helpers ----------

  function getConversationId() {
    const m = location.pathname.match(/\/chat\/([0-9a-f-]{36})/i);
    return m ? m[1] : null;
  }

  function getCookie(name) {
    const m = document.cookie.match(new RegExp('(?:^|; )' + name + '=([^;]*)'));
    return m ? decodeURIComponent(m[1]) : null;
  }

  async function getOrgId() {
    const fromCookie = getCookie('lastActiveOrg');
    if (fromCookie && /^[0-9a-f-]{36}$/i.test(fromCookie)) return fromCookie;

    const res = await fetch('/api/organizations', { credentials: 'include' });
    if (!res.ok) throw new Error('Could not list organizations (' + res.status + ')');
    const orgs = await res.json();
    if (!Array.isArray(orgs) || !orgs.length) throw new Error('No organization found');
    const chatOrg = orgs.find(o => Array.isArray(o.capabilities) && o.capabilities.includes('chat'));
    return (chatOrg || orgs[0]).uuid;
  }

  async function fetchConversation(orgId, convId) {
    const url = `/api/organizations/${orgId}/chat_conversations/${convId}` +
                `?tree=True&rendering_mode=messages&render_all_tools=true`;
    const res = await fetch(url, { credentials: 'include' });
    if (!res.ok) throw new Error('Could not load conversation (' + res.status + ')');
    return res.json();
  }

  // Follow the currently selected branch from the leaf back to the root.
  function activeBranch(data) {
    const msgs = data.chat_messages || [];
    const byId = new Map(msgs.map(m => [m.uuid, m]));
    let leaf = data.current_leaf_message_uuid && byId.get(data.current_leaf_message_uuid);

    if (!leaf) {
      // Fallback: no branch info → just sort by index / creation time.
      return msgs.slice().sort((a, b) =>
        (a.index ?? 0) - (b.index ?? 0) ||
        String(a.created_at).localeCompare(String(b.created_at)));
    }

    const chain = [];
    const seen = new Set();
    let cur = leaf;
    while (cur && !seen.has(cur.uuid)) {
      seen.add(cur.uuid);
      chain.push(cur);
      if (!cur.parent_message_uuid || cur.parent_message_uuid === ROOT_PARENT) break;
      cur = byId.get(cur.parent_message_uuid);
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

  function toolResultText(block) {
    const c = block.content;
    if (typeof c === 'string') return c;
    if (Array.isArray(c)) {
      return c.map(x => (x && (x.text ?? (x.type === 'image' ? '[image]' : JSON.stringify(x)))) || '')
              .join('\n');
    }
    return c ? JSON.stringify(c, null, 2) : '';
  }

  function blockToMd(block, full) {
    switch (block.type) {
      case 'text':
        return block.text || '';

      case 'thinking':
        if (!full || !block.thinking) return '';
        return '> **Thinking**\n>\n' + quote(block.thinking);

      case 'tool_use': {
        const input = block.input || {};
        // Artifacts / created files: always include their content.
        const body = input.content ?? input.file_text;
        if ((block.name === 'artifacts' || block.name === 'create_file') && body) {
          const title = input.title || input.path || input.id || 'untitled';
          const lang = input.language || (String(input.path || '').split('.').pop() || '');
          return `**Artifact: ${title}**\n\n` + fence(body, /^[\w+-]+$/.test(lang) ? lang : '');
        }
        if (!full) return `*[Tool call: ${block.name}]*`;
        return `**Tool call: ${block.name}**\n\n` + fence(JSON.stringify(input, null, 2), 'json');
      }

      case 'tool_result': {
        if (!full) return '';
        const txt = toolResultText(block).trim();
        return txt ? `**Tool result${block.name ? ': ' + block.name : ''}**\n\n` + fence(txt) : '';
      }

      default:
        return '';
    }
  }

  function messageToMd(msg, full) {
    const who = msg.sender === 'human' ? 'User' : 'Claude';
    const parts = [];

    if (Array.isArray(msg.content) && msg.content.length) {
      for (const b of msg.content) {
        const s = blockToMd(b, full);
        if (s && s.trim()) parts.push(s.trim());
      }
    } else if (msg.text) {
      parts.push(msg.text.trim());
    }

    // Attachments (pasted text / uploaded docs) and files (images, etc.)
    for (const a of msg.attachments || []) {
      const name = a.file_name || 'attachment';
      if (full && a.extracted_content) {
        parts.push(`**Attachment: ${name}**\n\n` + fence(a.extracted_content));
      } else {
        parts.push(`*[Attachment: ${name}]*`);
      }
    }
    for (const f of [...(msg.files || []), ...(msg.files_v2 || [])]) {
      if (f && f.file_name) parts.push(`*[File: ${f.file_name}]*`);
    }

    return `## ${who}\n\n${parts.join('\n\n')}`;
  }

  function conversationToMd(data, full) {
    const title = data.name || 'Claude conversation';
    const msgs = activeBranch(data);
    const header = `# ${title}\n\n` +
      `*Exported from claude.ai on ${new Date().toLocaleString()} — ${msgs.length} messages*`;
    return [header, ...msgs.map(m => messageToMd(m, full))].join('\n\n---\n\n') + '\n';
  }

  // ---------- clipboard / download ----------

  async function copyText(text) {
    try {
      await navigator.clipboard.writeText(text);
      return true;
    } catch (_) {
      // Fallback for when the async clipboard API is unavailable/denied.
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
    const safe = (title || 'claude-chat').replace(/[\\/:*?"<>|]+/g, '_').slice(0, 100);
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

    // Second click after a failed clipboard write: copy synchronously now.
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
      const orgId = await getOrgId();
      const data = await fetchConversation(orgId, convId);
      const md = conversationToMd(data, full);

      if (toFile) {
        download(md, data.name);
        setLabel(btn, '✅ Downloaded', 2500);
        return;
      }

      const ok = await copyText(md);
      if (ok) {
        setLabel(btn, `✅ Copied ${activeBranch(data).length} msgs${full ? ' (full)' : ''}`, 2500);
      } else {
        // Browser dropped the user-gesture during the fetch; ask for one more click.
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
                'Shift+Click: include thinking, tool calls/results, attachment text\n' +
                'Alt+Click: download as .md';
    btn.style.cssText = [
      'position:fixed', 'top:64px', 'right:16px', 'z-index:2147483647',
      'padding:6px 12px', 'border-radius:8px', 'border:1px solid rgba(128,128,128,.4)',
      'background:rgba(40,40,40,.85)', 'color:#fff', 'font:13px/1.2 system-ui,sans-serif',
      'cursor:pointer', 'box-shadow:0 2px 8px rgba(0,0,0,.25)', 'backdrop-filter:blur(4px)'
    ].join(';');
    btn.addEventListener('click', onClick);
    document.body.appendChild(btn);
  }

  // claude.ai is a single-page app: watch for URL changes.
  let lastPath = '';
  setInterval(() => {
    if (location.pathname !== lastPath) {
      lastPath = location.pathname;
      cachedText = null;
    }
    ensureButton();
  }, 800);
})();
