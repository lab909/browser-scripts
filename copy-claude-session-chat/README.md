# Claude Code (web) – Copy Full Session

A userscript that adds a **📋 Copy session** button to [Claude Code](https://claude.ai/code) sessions in the browser (links like `https://claude.ai/code/session_…`). Clicking it copies the **entire** session to your clipboard as Markdown, or downloads it as a `.md` file, not just the part currently on screen.

## Why

Claude Code sessions on the web can run for hours, and the page doesn't keep every message on screen at once. Selecting and copying the page misses part of the session, picks up buttons and interface text, and loses formatting.

This script doesn't copy from the page. It fetches the session's full history from the same internal endpoints the Claude Code web app uses, signed in with your existing session. It then builds clean Markdown from that data, so session length doesn't matter.

## Features

- Copies the whole session as Markdown, with **User** and **Claude** headings.
- Shows each tool Claude used as a short note, such as `[Bash: npm test]` or `[Edit: src/app.py]`, and groups several tool steps in a row into a compact list.
- Has an optional full-detail mode that adds Claude's thinking, the full input and output of every tool, and subagent messages.
- Can download the session as a `.md` file instead of copying it.
- Puts messages in the right order, whichever order the server returns them in.
- Leaves out the system notes and status messages Claude Code adds behind the scenes.
- Names the export after the session's title.
- Recognizes all session link formats (`session_…`, `cse_…` and `cshk_…`).
- Has a backup: if the history request fails, it uses the session data the page loaded itself.
- Works as you move between sessions without reloading the page.
- Sends no data anywhere: requests go only to claude.ai, and nothing leaves your browser.

## Installation

1. Install a userscript manager such as [Violentmonkey](https://violentmonkey.github.io/). Tampermonkey should also work.
2. Install the script in one of these ways:
   - Open the raw `claude-code-copy-full-session.user.js` file from this repository, and your userscript manager will offer to install it.
   - Or create a new script in the manager's dashboard, paste in the file's contents, and save.
3. Open or reload any Claude Code session on claude.ai.

The script works alongside the [Claude.ai – Copy Full Chat](../claude) script. Each one only shows its button on its own kind of page: regular chats or Claude Code sessions.

## Usage

When a session is open, a **📋 Copy session** button appears in the top-right corner.

| Action | Result |
|---|---|
| **Click** | Copies the session: messages, plus a one-line note for each tool Claude used |
| **Shift + Click** | Copies the full detail: also thinking, full tool inputs and outputs, and subagent messages |
| **Alt/Option + Click** | Downloads the session as a `.md` file (add Shift for full detail) |

Some browsers, notably Firefox, may block clipboard access if the session takes a moment to load. When that happens, the button changes to **"Ready – click again to copy"**, and a second click finishes the copy.

## Output example

```markdown
# fix-login-validation

*Exported from Claude Code on 10/20/2026, 21:32:10 — 4 messages*

---

## User

The login form accepts empty passwords. Can you fix it and add a test?

---

## Claude

*[Read: src/components/LoginForm.tsx]*
*[Edit: src/components/LoginForm.tsx]*
*[Bash: npm test -- LoginForm]*

The form now rejects empty passwords, and the new test passes.
```

## Troubleshooting

Open the browser console (F12) and look for lines starting with `[Copy Full Session]`:

- `loaded N events from /v1/…` means the session history was fetched from the server.
- `API not available, using events recorded from the page` means the backup was used.
- A summary such as `{fromApi: 120, recordedFromPage: 4, …}` shows how many events came from each source and whether their order was flipped.

If the button shows **"No messages found"**, reload the session page and click again. This gives the backup a chance to record the session data the page loads.

## Limitations

- **Relies on undocumented APIs.** If Anthropic changes the Claude Code web app's internal endpoints, the script may stop working or fall back to the backup. Fixing it usually means updating the endpoint URLs or field names in the script.
- **The backup only sees what the page loads.** If the server request fails, the export only includes messages the page loaded after the script started, which may not be the whole session.
- Images appear as placeholders. Files Claude read or wrote appear as tool notes. Their content is only included in full-detail mode, as part of the tool input and output.
- Only Claude Code sessions on claude.ai in the browser are supported. Sessions in the terminal, the desktop app or IDE extensions are not.

## Privacy

The script runs entirely in your browser. It sends requests only to `claude.ai`, using the session you are already signed in with, and it never sends your sessions to any other server. It reuses the page's own `anthropic-*` and `x-*` request headers, and it never reads or copies your cookies or sign-in tokens.

## Disclaimer

This is an unofficial community script. It is not affiliated with or endorsed by Anthropic. Use at your own risk.

## License

MIT
