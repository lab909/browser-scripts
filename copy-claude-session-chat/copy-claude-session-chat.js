// ==UserScript==
// @name         Claude Code (web) – Copy Full Session
// @namespace    https://github.com/yourname/copy-full-chat
// @version      1.0.0
// @description  Adds a button to Claude Code sessions on claude.ai/code that copies or downloads the ENTIRE session as Markdown, not just the rendered part.
// @match        https://claude.ai/*
// @grant        none
// @run-at       document-start
// ==/UserScript==

/*
 * How it works
 * ------------
 * 1. When you click the button, the script asks claude.ai's backend for the
 *    session's full event history, using the same headers the Claude Code web
 *    page sends (copied from the page's own requests, so nothing is guessed).
 * 2. As a backup, the script also records every session event the page itself
 *    loads (normal requests, event streams and live connections). If the API
 *    call fails, these recorded events are used instead.
 * The events are then turned into Markdown.
 *
 * Usage
 * -----
 *   Click              → copy session (messages + one-line notes for each tool
 *                        Claude used, e.g. "Bash: npm test")
 *   Shift + Click      → copy FULL detail (also thinking, full tool inputs,
 *                        tool outputs, and subagent messages)
 *   Alt/Option + Click → download as a .md file instead of copying
 *                        (combine with Shift for full detail)
 *
 * Note: the endpoints are undocumented and may change. Open the browser console
 * (F12) and look for "[Copy Full Session]" lines to see what the script did.
 */

(function () {
  'use strict';

  const LOG = '[Copy Full Session]';
  const BTN_ID = 'cfc-claude-code-copy-full-session-btn';
  // Sessions appear as session_<id>, cse_<id> (same id) or cshk_<id + extra>.
  const SID_RE = /(?:session|cse)_[0-9A-Za-z]+/;
  const toSessionId = s => String(s).replace(/^cse_/, 'session_');

  const captured = new Map();     // sessionId -> Map(key -> { e, n })
  const capturedMeta = new Map(); // sessionId -> metadata object
  const pageHeaders = {};         // anthropic-* / x-* headers from the page's own /v1/ requests
  let seq = 0;
  let cachedText = null;
  let busy = false;

  // ---------- small helpers ----------

  function getSessionId() {
    const m = location.pathname.match(/\/code\/((?:session|cse)_[0-9A-Za-z]+)/);
    if (m) return toSessionId(m[1]);
    // Share-style links (cshk_…) start with the session id (24 characters).
    const k = location.pathname.match(/\/code\/cshk_([0-9A-Za-z]{24})/);
    return k ? 'session_' + k[1] : null;
  }

  function getCookie(name) {
    const m = document.cookie.match(new RegExp('(?:^|; )' + name + '=([^;]*)'));
    return m ? decodeURIComponent(m[1]) : null;
  }

  function sidFromUrl(url) {
    const m = String(url || '').match(SID_RE);
    return m ? toSessionId(m[0]) : null;
  }

  // ---------- recording what the page loads ----------

  function isEvent(e) {
    if (!e || typeof e !== 'object' || Array.isArray(e)) return false;
    if (['user', 'assistant', 'system', 'result'].includes(e.type)) return true;
    return !!(e.message && typeof e.message === 'object' && e.message.role);
  }

  function unwrap(o) {
    for (let i = 0; i < 3 && o && typeof o === 'object' && !isEvent(o); i++) {
      const inner = o.event || o.payload || (o.data && !Array.isArray(o.data) ? o.data : null);
      if (!inner || typeof inner !== 'object') break;
      o = inner;
    }
    return o;
  }

  function eventKey(e) {
    return e.uuid || e.id || e.event_id ||
      ('h:' + e.type + ':' + JSON.stringify(e.message || e.content || e).slice(0, 300));
  }

  function eventList(j) {
    if (Array.isArray(j)) return j;
    if (!j || typeof j !== 'object') return [];
    for (const k of ['data', 'events', 'messages', 'items', 'results']) {
      if (Array.isArray(j[k])) return j[k];
    }
    return [];
  }

  function addEvents(sid, list) {
    if (!sid) return 0;
    if (!captured.has(sid)) captured.set(sid, new Map());
    const store = captured.get(sid);
    let added = 0;
    for (const raw of list) {
      const e = unwrap(raw);
      if (!isEvent(e)) continue;
      const k = eventKey(e);
      if (!store.has(k)) { store.set(k, { e, n: seq++ }); added++; }
      else store.get(k).e = e; // keep the latest version (e.g. a finished stream)
    }
    return added;
  }

  function ingest(url, j) {
    const sid = sidFromUrl(url);
    if (!sid || !j || typeof j !== 'object') return;
    const list = eventList(j);
    if (list.length) { addEvents(sid, list); return; }
    const one = unwrap(j);
    if (isEvent(one)) { addEvents(sid, [one]); return; }
    // Session details (title etc.): the URL ends with the session id.
    if (/(?:session|cse)_[0-9A-Za-z]+\/?(\?|$)/.test(String(url)) && j.title !== undefined) capturedMeta.set(sid, j);
  }

  function parseText(url, text) {
    const s = String(text || '').trim();
    if (!s) return [];
    try { const j = JSON.parse(s); ingest(url, j); return eventList(j).length ? eventList(j) : [j]; } catch (_) {}
    const out = [];
    for (let line of s.split(/\r?\n/)) {
      line = line.trim().replace(/^data:\s*/, '');
      if (!line || line[0] !== '{' && line[0] !== '[') continue;
      try { const j = JSON.parse(line); ingest(url, j); out.push(...(Array.isArray(j) ? j : [j])); } catch (_) {}
    }
    return out;
  }

  async function readStream(url, res) {
    try {
      const reader = res.body.getReader();
      const dec = new TextDecoder();
      let buf = '';
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        buf += dec.decode(value, { stream: true });
        let i;
        while ((i = buf.indexOf('\n')) >= 0) {
          parseText(url, buf.slice(0, i));
          buf = buf.slice(i + 1);
        }
      }
      if (buf) parseText(url, buf);
    } catch (_) {}
  }

  function rememberHeaders(input, init) {
    let h = (init && init.headers) || (input && typeof input === 'object' && input.headers);
    if (!h) return;
    const set = (k, v) => {
      k = String(k).toLowerCase();
      // Only copy anthropic-* and x-* headers. Cookies and authorization are
      // never copied (the browser adds sign-in automatically).
      if ((k.startsWith('anthropic-') || k.startsWith('x-')) && v != null) pageHeaders[k] = String(v);
    };
    if (typeof h.forEach === 'function' && !Array.isArray(h)) h.forEach((v, k) => set(k, v));
    else if (Array.isArray(h)) h.forEach(([k, v]) => set(k, v));
    else Object.entries(h).forEach(([k, v]) => set(k, v));
  }

  const origFetch = window.fetch.bind(window);
  window.fetch = function (input, init) {
    let url = '';
    try { url = typeof input === 'string' ? input : (input && input.url) || String(input); } catch (_) {}
    try { if (/\/v1\//.test(url)) rememberHeaders(input, init); } catch (_) {}
    const p = origFetch(input, init);
    if (SID_RE.test(url)) {
      p.then(res => {
        const ct = (res.headers.get('content-type') || '').toLowerCase();
        if (ct.includes('json')) res.clone().json().then(j => ingest(url, j)).catch(() => {});
        else if (ct.includes('event-stream') || ct.includes('ndjson')) readStream(url, res.clone());
      }).catch(() => {});
    }
    return p;
  };

  function wrapSocketClass(name) {
    const Orig = window[name];
    if (!Orig) return;
    const Wrapped = function (url, opt) {
      const s = opt === undefined ? new Orig(url) : new Orig(url, opt);
      try {
        if (SID_RE.test(String(url))) {
          s.addEventListener('message', ev => { if (typeof ev.data === 'string') parseText(String(url), ev.data); });
        }
      } catch (_) {}
      return s;
    };
    Wrapped.prototype = Orig.prototype;
    for (const k of ['CONNECTING', 'OPEN', 'CLOSING', 'CLOSED']) if (k in Orig) Wrapped[k] = Orig[k];
    window[name] = Wrapped;
  }
  wrapSocketClass('WebSocket');
  wrapSocketClass('EventSource');

  // ---------- loading from the API ----------

  async function apiGet(url) {
    const headers = {
      'anthropic-version': '2023-06-01',
      'anthropic-beta': 'ccr-byoc-2025-07-29',
      'anthropic-client-platform': 'web_claude_ai',
      'anthropic-client-feature': 'ccr',
      ...pageHeaders,
      Accept: 'application/json'
    };
    if (!headers['x-organization-uuid']) {
      const org = getCookie('lastActiveOrg');
      if (org) headers['x-organization-uuid'] = org;
    }
    const res = await origFetch(url, { credentials: 'include', headers });
    if (!res.ok) throw new Error('HTTP ' + res.status);
    const text = await res.text();
    try { return JSON.parse(text); } catch (_) { return { data: parseText(url, text) }; }
  }

  function pageEvents(page) {
    return eventList(page).map(unwrap).filter(isEvent);
  }

  // Returns the session's events in the order the API lists them (pages joined
  // in list order), or null if no endpoint worked. Direction is fixed later.
  async function loadEventsFromApi(sid) {
    const bases = [
      `/v1/code/sessions/${sid}/events`,
      `/v1/sessions/${sid}/events`,
      `/v1/code/sessions/${sid}/messages`
    ];
    for (const base of bases) {
      let first;
      try { first = await apiGet(base); } catch (err) {
        console.debug(LOG, base, '→', err.message);
        continue;
      }
      const list = pageEvents(first);
      if (!list.length) { console.debug(LOG, base, '→ no events'); continue; }
      const seen = new Set(list.map(eventKey));
      const addNew = evs => evs.filter(e => { const k = eventKey(e); return seen.has(k) ? false : (seen.add(k), true); });

      // Forward: pages that come after the first one in list order.
      let page = first;
      for (let i = 0; i < 500; i++) {
        let next = null;
        if (page.has_more && page.last_id) next = 'after_id=' + encodeURIComponent(page.last_id);
        else if (page.next_cursor) next = 'cursor=' + encodeURIComponent(page.next_cursor);
        else if (page.next_page) next = 'page=' + encodeURIComponent(page.next_page);
        if (!next) break;
        try { page = await apiGet(base + '?' + next); } catch (_) { break; }
        const fresh = addNew(pageEvents(page));
        if (!fresh.length) break;
        list.push(...fresh);
      }

      // Backward: pages that come before the first one, if the API offers them.
      page = first;
      for (let i = 0; i < 500 && page.first_id; i++) {
        try { page = await apiGet(base + '?before_id=' + encodeURIComponent(page.first_id)); } catch (_) { break; }
        const fresh = addNew(pageEvents(page));
        if (!fresh.length) break;
        list.unshift(...fresh);
        if (!page.has_more) break;
      }

      console.info(LOG, `loaded ${list.length} events from ${base}`);
      return list;
    }
    return null;
  }

  // ---------- ordering ----------

  function evTs(e) {
    const cands = [e.timestamp, e.created_at, e.createdAt, e.time, e.message && e.message.created_at];
    for (const v of cands) {
      if (v == null || v === '') continue;
      const t = typeof v === 'number' ? (v < 1e12 ? v * 1000 : v) : Date.parse(v);
      if (!isNaN(t)) return t;
    }
    return null;
  }

  // Lists may come newest-first; detect that and flip to oldest-first.
  function fixDirection(list) {
    let up = 0, down = 0, prev = null;
    for (const e of list) {
      const t = evTs(e);
      if (t == null) continue;
      if (prev != null) { if (t > prev) up++; else if (t < prev) down++; }
      prev = t;
    }
    if (down > up) return { list: list.slice().reverse(), reversed: true };
    if (!up && !down && list.length > 1) {
      // No timestamps: a session starts with its setup event or a user message.
      const init = list.findIndex(e => e.type === 'system');
      const firstUser = list.findIndex(e => e.type === 'user');
      const lastUser = list.length - 1 - list.slice().reverse().findIndex(e => e.type === 'user');
      if ((init >= 0 && init > list.length / 2) || (firstUser >= 0 && lastUser === list.length - 1 && list[0].type === 'assistant')) {
        return { list: list.slice().reverse(), reversed: true };
      }
    }
    return { list, reversed: false };
  }

  function orderedEvents(sid, apiList) {
    const out = [];
    const seen = new Set();
    const push = e => { const k = eventKey(e); if (!seen.has(k)) { seen.add(k); out.push(e); } };

    const api = apiList ? fixDirection(apiList) : { list: [], reversed: false };
    api.list.forEach(push);

    const store = captured.get(sid);
    const rec = store
      ? fixDirection(Array.from(store.values()).sort((a, b) => a.n - b.n).map(x => x.e))
      : { list: [], reversed: false };
    rec.list.forEach(push); // events only the page saw (e.g. live ones) go after

    // Events without a timestamp take the one of the event before them, so a
    // stable sort by time keeps them next to their neighbours.
    const raw = out.map(evTs);
    const firstKnown = raw.find(t => t != null);
    let last = firstKnown == null ? 0 : firstKnown;
    const keyed = out.map((e, i) => {
      if (raw[i] != null) last = raw[i];
      return { e, t: last, i };
    });
    keyed.sort((a, b) => a.t - b.t || a.i - b.i);

    console.info(LOG, {
      fromApi: api.list.length,
      recordedFromPage: rec.list.length,
      total: out.length,
      withTimestamps: raw.filter(t => t != null).length,
      apiReversed: api.reversed,
      recordedReversed: rec.reversed
    });
    return keyed.map(x => x.e);
  }

  async function loadMeta(sid) {
    if (capturedMeta.has(sid)) return capturedMeta.get(sid);
    try {
      const m = await apiGet(`/v1/code/sessions/${sid}`);
      capturedMeta.set(sid, m);
      return m;
    } catch (_) { return {}; }
  }

  function sessionTitle(meta) {
    const m = meta || {};
    const t = m.title || m.name || (m.session && (m.session.title || m.session.name)) ||
              (m.data && (m.data.title || m.data.name));
    if (t) return String(t);
    const dt = document.title && document.title.replace(/\s*[-–|]\s*Claude.*$/i, '').trim();
    return dt && !/^claude( code)?$/i.test(dt) ? dt : 'Claude Code session';
  }

  // ---------- Markdown ----------

  function fence(content, lang = '') {
    const runs = String(content).match(/`+/g) || [];
    const longest = runs.reduce((n, r) => Math.max(n, r.length), 0);
    const f = '`'.repeat(Math.max(3, longest + 1));
    return `${f}${lang}\n${content}\n${f}`;
  }

  function quote(text) {
    return String(text).split('\n').map(l => '> ' + l).join('\n');
  }

  function cleanUserText(t) {
    return String(t || '')
      .replace(/<system-reminder>[\s\S]*?<\/system-reminder>/g, '')
      .replace(/<local-command-caveat>[\s\S]*?<\/local-command-caveat>/g, '')
      .replace(/<command-message>[\s\S]*?<\/command-message>/g, '')
      .replace(/<command-name>([\s\S]*?)<\/command-name>/g, '$1')
      .replace(/<command-args>([\s\S]*?)<\/command-args>/g, ' $1')
      .replace(/<\/?local-command-std(out|err)>/g, '')
      .replace(/\n{3,}/g, '\n\n')
      .trim();
  }

  function toolSummary(name, input) {
    const i = input || {};
    let s = i.command || i.file_path || i.notebook_path || i.path || i.pattern ||
            i.url || i.query || i.description || i.prompt || '';
    s = String(s).replace(/\s+/g, ' ').trim();
    if (s.length > 120) s = s.slice(0, 117) + '…';
    return s ? `*[${name}: ${s.replace(/\*/g, '\\*')}]*` : `*[${name}]*`;
  }

  function toolResultText(c) {
    if (typeof c === 'string') return c;
    if (Array.isArray(c)) {
      return c.map(x => (x && (typeof x.text === 'string' ? x.text : x.type === 'image' ? '[image]' : ''))).join('\n');
    }
    return c ? JSON.stringify(c, null, 2) : '';
  }

  // Returns [{ speaker, text }] for one event.
  function eventToParts(e, full) {
    if (e.isMeta || e.type === 'system' || e.type === 'result') return [];
    if (e.parent_tool_use_id && !full) return []; // subagent internals
    const msg = e.message || e;
    const role = e.type === 'assistant' || msg.role === 'assistant' ? 'assistant' : 'user';
    const content = msg.content;
    const sub = e.parent_tool_use_id ? '*(subagent)* ' : '';
    const out = [];

    if (typeof content === 'string') {
      const t = role === 'user' ? cleanUserText(content) : content.trim();
      if (t) out.push({ speaker: role === 'user' && !sub ? 'User' : 'Claude', text: sub + t });
      return out;
    }
    if (!Array.isArray(content)) return out;

    for (const b of content) {
      if (!b || typeof b !== 'object') continue;
      if (role === 'user') {
        if (b.type === 'text') {
          const t = cleanUserText(b.text);
          if (t) out.push({ speaker: sub ? 'Claude' : 'User', text: sub + t });
        } else if (b.type === 'image') {
          out.push({ speaker: 'User', text: '*[Image]*' });
        } else if (b.type === 'tool_result' && full) {
          const t = toolResultText(b.content).trim();
          if (t) out.push({ speaker: 'Claude', text: sub + `**Tool result${b.is_error ? ' (error)' : ''}**\n\n` + fence(t) });
        }
      } else {
        if (b.type === 'text' && b.text && b.text.trim()) {
          out.push({ speaker: 'Claude', text: sub + b.text.trim() });
        } else if (b.type === 'thinking' && full && b.thinking) {
          out.push({ speaker: 'Claude', text: '> **Thinking**\n>\n' + quote(b.thinking.trim()) });
        } else if (b.type === 'tool_use') {
          out.push({
            speaker: 'Claude',
            text: sub + (full
              ? `**Tool call: ${b.name}**\n\n` + fence(JSON.stringify(b.input || {}, null, 2), 'json')
              : toolSummary(b.name, b.input))
          });
        }
      }
    }
    return out;
  }

  function sessionToMd(events, meta, full) {
    const title = sessionTitle(meta);
    const turns = [];
    for (const e of events) {
      for (const p of eventToParts(e, full)) {
        const last = turns[turns.length - 1];
        if (last && last.speaker === p.speaker) last.parts.push(p.text);
        else turns.push({ speaker: p.speaker, parts: [p.text] });
      }
    }
    // Merge consecutive one-line tool notes into a compact list.
    for (const t of turns) {
      const merged = [];
      for (const p of t.parts) {
        const isNote = /^\*\[[^\n]*\]\*$/.test(p);
        const prev = merged[merged.length - 1];
        if (isNote && prev && prev.note) prev.text += '\n' + p;
        else merged.push({ text: p, note: isNote });
      }
      t.parts = merged.map(m => m.text);
    }
    const header = `# ${title}\n\n` +
      `*Exported from Claude Code on ${new Date().toLocaleString()} — ${turns.length} messages*`;
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
    const safe = (title || 'claude-code-session').replace(/[\\/:*?"<>|]+/g, '_').slice(0, 100);
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
      btn._t = setTimeout(() => { btn.textContent = '📋 Copy session'; }, resetMs);
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

    const sid = getSessionId();
    if (!sid) return setLabel(btn, 'Not in a session', 2000);

    busy = true;
    setLabel(btn, '⏳ Loading…');
    try {
      const apiList = await loadEventsFromApi(sid);
      if (!apiList) console.info(LOG, 'API not available, using events recorded from the page');
      const events = orderedEvents(sid, apiList);
      if (!events.length) throw new Error('No messages found – reload the page and try again');

      const meta = await loadMeta(sid);
      const { md, count, title } = sessionToMd(events, meta, full);

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
      console.error(LOG, err);
      setLabel(btn, '❌ ' + (err.message || 'Error'), 5000);
    } finally {
      busy = false;
    }
  }

  function ensureButton() {
    if (!document.body) return;
    let btn = document.getElementById(BTN_ID);
    if (!getSessionId()) {
      if (btn) btn.remove();
      cachedText = null;
      return;
    }
    if (btn) return;

    btn = document.createElement('button');
    btn.id = BTN_ID;
    btn.type = 'button';
    btn.textContent = '📋 Copy session';
    btn.title = 'Click: copy whole session as Markdown\n' +
                'Shift+Click: include thinking, tool inputs and outputs, subagents\n' +
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
