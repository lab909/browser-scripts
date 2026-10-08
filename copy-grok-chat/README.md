# Grok – Copy Full Chat

A userscript that adds a **📋 Copy chat** button to [Grok](https://grok.com) conversations. Clicking it copies the **entire** conversation to your clipboard as Markdown, or downloads it as a `.md` file, not just the part currently on screen.

## Why

Selecting and copying a long Grok conversation from the page is unreliable. You have to scroll through the whole chat, the selection picks up buttons and interface text, and formatting gets lost.

This script doesn't copy from the page at all. It fetches the full conversation from the same internal endpoints the grok.com web app uses, signed in with your existing session. It then builds clean Markdown from that data, so chat length doesn't matter.

## Features

- Copies the whole conversation as Markdown, with **User** and **Grok** headings.
- Removes the citation and tool tags Grok puts inside answers, so the copied text is clean.
- Has an optional full-detail mode that adds Grok's thinking and a list of the web sources it used.
- Can download the chat as a `.md` file instead of copying it.
- Notes uploaded and generated images and files with placeholders.
- Works as you move between chats without reloading the page.
- Sends no data anywhere: requests go only to grok.com, and nothing leaves your browser.

## Installation

1. Install a userscript manager such as [Violentmonkey](https://violentmonkey.github.io/). Tampermonkey and Greasemonkey should also work.
2. Install the script in one of these ways:
   - Open the raw `grok-copy-full-chat.user.js` file from this repository, and your userscript manager will offer to install it.
   - Or create a new script in the manager's dashboard, paste in the file's contents, and save.
3. Open or reload any conversation on grok.com.

## Usage

When a conversation is open, a **📋 Copy chat** button appears in the top-right corner.

| Action | Result |
|---|---|
| **Click** | Copies the chat: messages, plus placeholders for images and files |
| **Shift + Click** | Copies the full detail: also Grok's thinking and its web sources |
| **Alt/Option + Click** | Downloads the chat as a `.md` file (add Shift for full detail) |

Some browsers, notably Firefox, may block clipboard access if the conversation takes a moment to load. When that happens, the button changes to **"Ready – click again to copy"**, and a second click finishes the copy.

## Output example

```markdown
# Reversing a list in Python

*Exported from Grok on 10/8/2026, 14:32:10 — 4 messages*

---

## User

How do I reverse a list in Python?

---

## Grok

You can use slicing: `my_list[::-1]` …
```

## Limitations

- **Relies on undocumented APIs.** If xAI changes grok.com's internal endpoints, the script may stop working, and the button will show an error such as `❌ Could not load conversation (404)`. The browser console (F12) shows which step failed. Fixing it usually means updating the endpoint URLs or field names in the script.
- **Exports the latest branch.** Grok doesn't tell the page which version of an edited or regenerated message you're viewing. The script therefore follows the most recent version, which may differ from what's on screen if you switched back to an older one.
- Images and files, both uploaded and generated, appear as placeholders. Their content is not exported.
- Only grok.com is supported. Grok inside X (x.com) is not.

## Privacy

The script runs entirely in your browser. It sends requests only to grok.com, using the session you are already signed in with, and it never sends your conversations to any other server.

## Disclaimer

This is an unofficial community script. It is not affiliated with or endorsed by xAI or X Corp. Use at your own risk.

## License

MIT
