// ==UserScript==
// @name         Gemini – Copy Full Chat
// @namespace    https://github.com/yourname/copy-full-chat
// @version      1.0.0
// @description  Adds a button to Gemini chats that copies or downloads the ENTIRE conversation as Markdown, including older messages that haven't been loaded yet.
// @match        https://gemini.google.com/*
// @grant        GM_setClipboard
// @run-at       document-idle
// ==/UserScript==

/*
 * How it works
 * ------------
 * Gemini only loads the most recent part of a long chat; older messages load
 * as you scroll up. This script scrolls the chat to the top automatically until
 * every message has loaded, collects all turns (also while scrolling, in case
 * Gemini unloads some), converts them to Markdown, and puts you back where you
 * were.
 *
 * Usage
 * -----
 *   Click              → copy chat
 *   Shift + Click      → copy FULL detail (also Gemini's thinking, when its
 *                        "Show thinking" panel has been expanded)
 *   Alt/Option + Click → download as a .md file instead of copying
 *                        (combine with Shift for full detail)
 *
 * Note: this reads the page structure, which Google may change; if the button
 * reports "No messages found", the page's element names probably changed.
 */

(function () {
  'use strict';

  const BTN_ID = 'cfc-gemini-copy-full-chat-btn';
  let cachedText = null; // used if clipboard write fails
  let busy = false;

  const sleep = (ms) => new Promise(r => setTimeout(r, ms));

  // ---------- page helpers ----------

  function inChat() {
    return /\/(app|gem\/[^/]+)\/[0-9a-f]{8,}/i.test(location.pathname);
  }

  function findScroller(el) {
    for (let n = el && el.parentElement; n; n = n.parentElement) {
      const s = getComputedStyle(n);
      if (/(auto|scroll)/.test(s.overflowY) && n.scrollHeight > n.clientHeight + 10) return n;
    }
    return document.scrollingElement;
  }

  function getTitle(firstUserText) {
    const el = document.querySelector(
      '.conversation.selected .conversation-title, [data-test-id="conversation-title"]');
    const t = el && el.textContent.trim();
    if (t) return t;
    if (document.title && !/^\s*(Google )?Gemini\s*$/i.test(document.title)) {
      return document.title.replace(/\s*[-–|]\s*(Google )?Gemini\s*$/i, '').trim();
    }
    return (firstUserText || 'Gemini conversation').split('\n')[0].slice(0, 80);
  }

  // ---------- HTML → Markdown ----------

  const SKIP = new Set([
    'button', 'mat-icon', 'svg', 'script', 'style', 'noscript', 'source-footnote',
    'sources-carousel', 'sources-carousel-inline', 'source-inline-chip',
    'message-actions', 'model-thoughts', 'tts-control'
  ]);

  function fence(content, lang = '') {
    const runs = String(content).match(/`+/g) || [];
    const longest = runs.reduce((n, r) => Math.max(n, r.length), 0);
    const f = '`'.repeat(Math.max(3, longest + 1));
    return `${f}${lang}\n${content}\n${f}`;
  }

  function quote(text) {
    return String(text).split('\n').map(l => '> ' + l).join('\n');
  }

  function isHiddenEl(el) {
    const c = el.classList;
    return c.contains('cdk-visually-hidden') || c.contains('sr-only') ||
           c.contains('code-block-decoration') || el.hidden;
  }

  function conv(node) {
    if (node.nodeType === Node.TEXT_NODE) return node.nodeValue.replace(/[ \t\r\n]+/g, ' ');
    if (node.nodeType !== Node.ELEMENT_NODE) return '';
    const el = node;
    const tag = el.tagName.toLowerCase();
    if (SKIP.has(tag) || isHiddenEl(el)) return '';
    const kids = () => Array.from(el.childNodes).map(conv).join('');

    switch (tag) {
      case 'code-block': {
        const langEl = el.querySelector('.code-block-decoration span, .code-block-decoration');
        const lang = (langEl ? langEl.textContent.trim().split(/\s+/)[0] : '').toLowerCase();
        const code = (el.querySelector('code') || el.querySelector('pre') || el).textContent;
        return '\n\n' + fence(code.replace(/\n$/, ''), /^[\w+#-]+$/.test(lang) ? lang : '') + '\n\n';
      }
      case 'pre': {
        const code = el.querySelector('code');
        const m = code && (code.className.match(/language-([\w+#-]+)/) || []);
        return '\n\n' + fence(el.textContent.replace(/\n$/, ''), (m && m[1]) || '') + '\n\n';
      }
      case 'code': {
        const t = el.textContent;
        return t.includes('`') ? '`` ' + t + ' ``' : '`' + t + '`';
      }
      case 'h1': case 'h2': case 'h3': case 'h4': case 'h5': case 'h6':
        return '\n\n' + '#'.repeat(+tag[1]) + ' ' + kids().trim() + '\n\n';
      case 'p': case 'div': case 'section': case 'article':
        return '\n\n' + kids() + '\n\n';
      case 'br':
        return '\n';
      case 'strong': case 'b': {
        const t = kids().trim();
        return t ? '**' + t + '**' : '';
      }
      case 'em': case 'i': {
        const t = kids().trim();
        return t ? '*' + t + '*' : '';
      }
      case 'a': {
        const t = kids().trim();
        const href = el.getAttribute('href');
        return href && t && !href.startsWith('javascript:') ? `[${t}](${el.href})` : t;
      }
      case 'ul': case 'ol':
        return '\n\n' + listMd(el, tag === 'ol') + '\n\n';
      case 'blockquote':
        return '\n\n' + quote(clean(kids())) + '\n\n';
      case 'hr':
        return '\n\n---\n\n';
      case 'table':
        return '\n\n' + tableMd(el) + '\n\n';
      case 'img':
        return '*[Image]*';
      default:
        return kids();
    }
  }

  function listMd(el, ordered) {
    const start = parseInt(el.getAttribute('start') || '1', 10);
    return Array.from(el.children).filter(c => c.tagName === 'LI').map((li, i) => {
      const prefix = ordered ? `${start + i}. ` : '- ';
      const body = clean(Array.from(li.childNodes).map(conv).join('')).replace(/\n{2,}/g, '\n');
      const pad = ' '.repeat(prefix.length);
      return prefix + body.split('\n').map((l, j) => (j ? pad + l : l)).join('\n');
    }).join('\n');
  }

  function tableMd(table) {
    const rows = Array.from(table.querySelectorAll('tr')).map(tr =>
      Array.from(tr.children).map(td =>
        clean(conv(td)).replace(/\n+/g, ' ').replace(/\|/g, '\\|')));
    if (!rows.length) return '';
    const width = Math.max(...rows.map(r => r.length));
    const line = r => '| ' + Array.from({ length: width }, (_, i) => r[i] || '').join(' | ') + ' |';
    return [line(rows[0]), '|' + ' --- |'.repeat(width), ...rows.slice(1).map(line)].join('\n');
  }

  function clean(md) {
    return md
      .replace(/[ \t]+\n/g, '\n')
      .replace(/\n[ \t]+(?=\S)/g, m => m) // keep indentation (lists/code)
      .replace(/\n{3,}/g, '\n\n')
      .trim();
  }

  function htmlToMd(el) {
    return el ? clean(conv(el)) : '';
  }

  // ---------- reading turns ----------

  function extractUser(uq) {
    if (!uq) return '';
    const lines = uq.querySelectorAll('.query-text-line');
    let text = lines.length
      ? Array.from(lines).map(l => l.textContent.replace(/\s+$/, '')).join('\n')
      : htmlToMd(uq.querySelector('.query-text') || uq);
    text = text.replace(/^\s*You said\s*/i, '').trim();
    const files = uq.querySelectorAll('img, user-query-file-preview, [class*="file-preview"]').length;
    if (files) text += (text ? '\n\n' : '') + `*[${files} attachment(s)]*`;
    return text;
  }

  function extractModel(mr) {
    if (!mr) return { text: '', thoughts: '' };
    const main = mr.querySelector('message-content .markdown') ||
                 mr.querySelector('message-content') ||
                 mr.querySelector('.model-response-text');
    let text = htmlToMd(main);
    if (main && !main.querySelector('img')) {
      const gen = mr.querySelectorAll('generated-image, single-image').length;
      if (gen) text += (text ? '\n\n' : '') + `*[${gen} generated image(s)]*`;
    }
    const th = mr.querySelector('model-thoughts .thoughts-content, model-thoughts [data-test-id="thoughts-content"]');
    const thoughts = th ? htmlToMd(th) : '';
    return { text, thoughts };
  }

  // Returns the turns currently in the page, in order.
  function readVisibleTurns() {
    const containers = document.querySelectorAll('.conversation-container');
    if (containers.length) {
      return Array.from(containers).map((c, i) => {
        const user = extractUser(c.querySelector('user-query'));
        const model = extractModel(c.querySelector('model-response'));
        return { key: c.id || ('k:' + user.slice(0, 200) + '|' + model.text.slice(0, 200) + '|' + i), user, ...model };
      });
    }
    // Fallback: pair user-query / model-response elements in document order.
    const turns = [];
    for (const el of document.querySelectorAll('user-query, model-response')) {
      if (el.tagName.toLowerCase() === 'user-query') {
        turns.push({ user: extractUser(el), text: '', thoughts: '' });
      } else {
        const m = extractModel(el);
        if (!turns.length || turns[turns.length - 1].text) turns.push({ user: '', text: '', thoughts: '' });
        Object.assign(turns[turns.length - 1], m);
      }
    }
    return turns.map((t, i) => ({ key: 'k:' + t.user.slice(0, 200) + '|' + t.text.slice(0, 200) + '|' + i, ...t }));
  }

  // Merge a freshly read (ordered) batch into the accumulated ordered list.
  function mergeTurns(all, byKey, batch) {
    const firstKnown = batch.findIndex(t => byKey.has(t.key));
    if (firstKnown === -1) {
      // Nothing overlaps: batch is older content (we scroll upward) → prepend.
      const fresh = batch.filter(t => !byKey.has(t.key));
      fresh.forEach(t => byKey.set(t.key, t));
      all.unshift(...fresh);
      return;
    }
    const older = batch.slice(0, firstKnown).filter(t => !byKey.has(t.key));
    const anchorIdx = all.indexOf(byKey.get(batch[firstKnown].key));
    older.forEach(t => byKey.set(t.key, t));
    all.splice(anchorIdx, 0, ...older);
    // Update known turns (e.g. a response that finished streaming) and append newer ones.
    let pos = all.indexOf(byKey.get(batch[firstKnown].key));
    for (const t of batch.slice(firstKnown)) {
      if (byKey.has(t.key)) {
        Object.assign(byKey.get(t.key), t);
        pos = all.indexOf(byKey.get(t.key));
      } else {
        byKey.set(t.key, t);
        all.splice(++pos, 0, t);
      }
    }
  }

  async function loadAllTurns(onProgress) {
    const first = document.querySelector('user-query, model-response');
    if (!first) throw new Error('No messages found');

    const scroller = findScroller(first);
    const distFromBottom = scroller.scrollHeight - scroller.clientHeight - scroller.scrollTop;

    const all = [];
    const byKey = new Map();
    mergeTurns(all, byKey, readVisibleTurns());

    let stableRounds = 0;
    for (let i = 0; i < 500 && stableRounds < 4; i++) {
      const beforeCount = all.length;
      const beforeHeight = scroller.scrollHeight;
      scroller.scrollTop = 0;
      await sleep(i === 0 ? 400 : 800);
      mergeTurns(all, byKey, readVisibleTurns());
      onProgress(all.length);
      const grew = all.length > beforeCount || scroller.scrollHeight !== beforeHeight;
      stableRounds = grew ? 0 : stableRounds + 1;
    }

    // Final pass from the top down, in case anything was unloaded meanwhile.
    for (let y = 0; y <= scroller.scrollHeight; y += Math.max(200, scroller.clientHeight * 0.8)) {
      scroller.scrollTop = y;
      await sleep(60);
      mergeTurns(all, byKey, readVisibleTurns());
    }

    // Restore the reader's position.
    scroller.scrollTop = scroller.scrollHeight - scroller.clientHeight - distFromBottom;
    return all;
  }

  function turnsToMd(turns, full) {
    const title = getTitle(turns[0] && turns[0].user);
    const sections = [];
    for (const t of turns) {
      if (t.user) sections.push(`## User\n\n${t.user}`);
      const parts = [];
      if (full && t.thoughts) parts.push('> **Thinking**\n>\n' + quote(t.thoughts));
      if (t.text) parts.push(t.text);
      if (parts.length) sections.push(`## Gemini\n\n${parts.join('\n\n')}`);
    }
    const header = `# ${title}\n\n` +
      `*Exported from Gemini on ${new Date().toLocaleString()} — ${sections.length} messages*`;
    return { md: [header, ...sections].join('\n\n---\n\n') + '\n', count: sections.length, title };
  }

  // ---------- clipboard / download ----------

  async function copyText(text) {
    // GM_setClipboard doesn't need a fresh click, which matters because
    // loading a long chat takes a few seconds.
    if (typeof GM_setClipboard === 'function') {
      try { GM_setClipboard(text, 'text'); return true; } catch (_) {}
    }
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
    const safe = (title || 'gemini-chat').replace(/[\\/:*?"<>|]+/g, '_').slice(0, 100);
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
    if (busy) return;

    if (cachedText && !toFile) {
      const ok = await copyText(cachedText);
      cachedText = null;
      setLabel(btn, ok ? '✅ Copied!' : '❌ Copy failed', 2500);
      return;
    }

    busy = true;
    setLabel(btn, '⏳ Loading messages…');
    try {
      const turns = await loadAllTurns(n => setLabel(btn, `⏳ Loading… (${n} turns)`));
      const { md, count, title } = turnsToMd(turns, full);

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
    } finally {
      busy = false;
    }
  }

  function ensureButton() {
    let btn = document.getElementById(BTN_ID);

    if (!inChat()) {
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
                'Shift+Click: include thinking (if expanded)\n' +
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

  // Gemini is a single-page app: watch for URL changes.
  let lastPath = '';
  setInterval(() => {
    if (location.pathname !== lastPath) {
      lastPath = location.pathname;
      cachedText = null;
    }
    ensureButton();
  }, 800);
})();
