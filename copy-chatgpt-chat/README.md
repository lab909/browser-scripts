# ChatGPT – Copy Full Chat

A userscript that adds a **📋 Copy chat** button to [ChatGPT](https://chatgpt.com) conversations. Clicking it copies the **entire** conversation to your clipboard as Markdown, not just the part currently on screen.

## Why

Selecting and copying a long ChatGPT conversation from the page is unreliable. Long chats may not be fully shown on the page, and the built-in copy button only works on one message at a time.

This script doesn't copy from the page at all. It fetches the full conversation from the same internal endpoint the ChatGPT web app uses, signed in with your existing session. It then builds clean Markdown from that data, so chat length doesn't matter.

## Features

- Copies the whole conversation as Markdown, with **User** and **ChatGPT** headings.
- Merges each reply into one section, even when ChatGPT used tools such as search or code partway through it.
- Includes the contents of Canvas documents as fenced code blocks.
- Removes the inline citation markers ChatGPT adds to answers, so the copied text is clean.
- Has an optional full-detail mode that adds reasoning summaries, the code ChatGPT ran with its output, and browsing results.
- Can download the chat as a `.md` file instead of copying it.
- Follows the branch currently shown on screen, so edited or regenerated messages appear the way you see them.
- Leaves out hidden content such as system prompts, custom instructions and memory.
- Works on both `chatgpt.com` and `chat.openai.com`, including Team and Enterprise workspaces and custom GPT chats.
- Sends no data anywhere: requests go only to ChatGPT, and nothing leaves your browser.

## Installation

1. Install a userscript manager such as [Violentmonkey](https://violentmonkey.github.io/). Tampermonkey and Greasemonkey should also work.
2. Install the script in one of these ways:
   - Open the raw `chatgpt-copy-full-chat.user.js` file from this repository, and your userscript manager will offer to install it.
   - Or create a new script in the manager's dashboard, paste in the file's contents, and save.
3. Open or reload any conversation on ChatGPT.

## Usage

When a conversation is open, a **📋 Copy chat** button appears in the top-right corner.

| Action | Result |
|---|---|
| **Click** | Copies the chat: messages, Canvas documents, and short notes where tools were used |
| **Shift + Click** | Copies the full detail: also reasoning summaries, tool calls, and code and browsing output |
| **Alt/Option + Click** | Downloads the chat as a `.md` file (add Shift for full detail) |

Some browsers, notably Firefox, may block clipboard access if the conversation takes a moment to load. When that happens, the button changes to **"Ready – click again to copy"**, and a second click finishes the copy.

## Output example

```markdown
# Reversing a list in Python

*Exported from ChatGPT on 10/8/2026, 14:32:10 — 4 messages*

---

## User

How do I reverse a list in Python?

---

## ChatGPT

You can use slicing: `my_list[::-1]` …
```

## Limitations

- **Relies on an undocumented API.** If OpenAI changes its internal endpoints, the script may stop working, and the button will show an error such as `❌ Could not load conversation (404)`. The browser console (F12) shows more detail. Fixing it usually means updating the endpoint URL or field names in the script.
- Only the branch currently shown on screen is exported. Other versions of edited or regenerated messages are not included.
- Images, both uploaded and generated, appear as placeholders. Uploaded files are listed by name only.
- Temporary chats and shared-link pages are not supported.

## Privacy

The script runs entirely in your browser. It sends requests only to ChatGPT, using the session you are already signed in with, and it never sends your conversations to any other server. Your session token is kept in memory only while the page is open and is never stored.

## Disclaimer

This is an unofficial community script. It is not affiliated with or endorsed by OpenAI. Use at your own risk.

## License

MIT
