# Security Policy

## Supported versions

Only the latest commit on the `main` branch of this repository receives security fixes.

## Reporting a vulnerability

**Please do not open a public issue for security problems.**

Report privately via GitHub: **[Report a vulnerability](https://github.com/hs2gai/midi-kbd/security/advisories/new)**
(the "Security" tab of this repository → "Report a vulnerability").

Please include:

- what is affected (the web page, or the local server `server.mjs`), with the browser / OS and version
- steps to reproduce, and a sample MIDI or SFZ file if one is needed
- the impact you expect

Responses may take a while and no response time is guaranteed. Progress will be shared in the advisory, and I am happy to credit you there unless you prefer otherwise.

## Scope

midi-kbd runs entirely in the browser and only loads files from its own origin. Issues that break this are especially important, for example:

- a crafted MIDI file that runs script in the page (XSS) or bypasses the Content Security Policy
- the page sending any request to a third-party origin
- the local server (`server.mjs`) serving files outside the project, `sfz/` and the VexFlow build, or being reachable from other machines

Out of scope: problems that require a compromised browser or device, and reports from automated scanners without a demonstrated impact.

---

## 日本語

脆弱性は公開のIssueではなく、上記の **[Report a vulnerability](https://github.com/hs2gai/midi-kbd/security/advisories/new)**（リポジトリのSecurityタブ）から非公開でご報告ください。日本語で構いません。お返事までお時間をいただくことがあります。
