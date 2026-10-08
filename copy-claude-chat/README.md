# Claude.ai – Copy Full Chat

A userscript that adds a **📋 Copy chat** button to [claude.ai](https://claude.ai) conversations. Clicking it copies the **entire** conversation to your clipboard as Markdown, not just the part currently on screen.

## Why

claude.ai removes messages that are scrolled out of view from the page to save memory. This means selecting and copying a long chat only grabs the visible portion, and the rest is lost.

This script doesn't copy from the page at all. It fetches the full conversation from the same internal endpoint the claude.ai web app uses, signed in with your existing session. It then builds clean Markdown from that data, so chat length doesn't matter.

## Features

- Copies the whole conversation as Markdown, with **User** and **Claude** headings.
- Includes artifact and generated-file contents as fenced code blocks.
- Has an optional full-detail mode that adds Claude's thinking, tool calls and results, and attachment text.
- Can download the chat as a `.md` file instead of copying it.
- Follows the branch currently shown on screen, so edited or regenerated messages appear the way you see them.
- Works as you move between chats without reloading the page.
- Sends no data anywhere: requests go only to claude.ai, and nothing leaves your browser.

## Installation

1. Install a userscript manager such as [Violentmonkey](https://violentmonkey.github.io/). Tampermonkey and Greasemonkey should also work.
2. Install the script in one of these ways:
   - Open the raw `claude-copy-full-chat.user.js` file from this repository, and your userscript manager will offer to install it.
   - Or create a new script in the manager's dashboard, paste in the file's contents, and save.
3. Open or reload any chat on claude.ai.

## Usage

When a chat is open, a **📋 Copy chat** button appears in the top-right corner.

| Action | Result |
|---|---|
| **Click** | Copies the chat: messages, artifacts, and short notes where tools were used |
| **Shift + Click** | Copies the full detail: also thinking, tool inputs and results, and attachment contents |
| **Alt/Option + Click** | Downloads the chat as a `.md` file (add Shift for full detail) |

Some browsers, notably Firefox, may block clipboard access if the conversation takes a moment to load. When that happens, the button changes to **"Ready – click again to copy"**, and a second click finishes the copy.

## Output example

```markdown
# My conversation title

*Exported from claude.ai on 10/8/2026, 14:32:10 — 12 messages*

---

## User

How do I reverse a list in Python?

---

## Claude

You can use slicing: `my_list[::-1]` …
```

## Limitations

- **Relies on an undocumented API.** If claude.ai changes its internal endpoints, the script may stop working, and the button will show an error such as `❌ Could not load conversation (404)`. Fixing it usually means updating the endpoint URL or field names in the script.
- Only the branch currently shown on screen is exported. Other versions of edited or regenerated messages are not included.
- Images and binary files are listed by file name only. Their content is not exported.

## Privacy

The script runs entirely in your browser. It sends requests only to `claude.ai`, using the session you are already signed in with, and it never sends your conversations to any other server.

## Disclaimer

This is an unofficial community script. It is not affiliated with or endorsed by Anthropic. Use at your own risk.

## License

MIT
