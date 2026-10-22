# Ü Check by Accessiblü

Ü Check is a Chrome extension for WCAG 2.2 testing. It runs automated checks, walks you through the things automation can't catch, and turns the results into a VPAT matrix and an Accessibility Conformance Report (ACR).

I built it because my team at Accessiblü needed a tool that matched how we actually audit. Automated scans are a starting point. The real work is in the manual review, and the tool should help with both.

[Install Ü Check from the Chrome Web Store](https://chromewebstore.google.com/detail/acimaoihbmigdidmhjnheiaaoophmmki)

## What it does

- Runs automated WCAG 2.2 checks at Level A, AA or AAA using axe-core
- Sorts results into Violations, Passes and Needs Review
- Builds a VPAT criteria matrix for Level A and AA that tracks automated results and your manual verdicts for each success criterion
- Exports results as JSON, CSV or a full ACR
- Connects to Ü Monitor (in development) for ongoing monitoring

### Audit tools for things automation misses

axe-core looks at a snapshot of the page. Some barriers only show up over time or through interaction, so Ü Check adds its own tools for those:

- Watch Live Regions: observes `aria-live`, `role="status"`, `role="alert"` and `role="log"` regions and records whether they actually announce updates (4.1.3 Status Messages)
- Check Focus Indicators: focuses every focusable element and flags any with no visible change (2.4.7 Focus Visible)
- `role="application"` review: flags regions where screen reader browse mode gets turned off, for manual verification (2.1.1 Keyboard)
- Drag interaction review: detects draggable elements and common drag-and-drop libraries so you can confirm a single-pointer alternative exists (2.5.7 Dragging Movements)
- Inspectors for tab order, headings, images, landmarks and ARIA

## Accessibility of the tool itself

An accessibility tool that fails its own audit isn't much use, so Ü Check is built and tested with keyboard and screen reader users in mind.

- Press `Ctrl+Shift+A` (Windows and Linux) or `Cmd+Shift+A` (macOS) to open Ü Check in a focused standalone window. Your screen reader announces it right away and focus lands on the Run Accessibility Test button.
- If you prefer the side panel, press `F6` to move focus between the address bar, the page and the side panel.
- Focus indicators meet the WCAG 3:1 non-text contrast minimum against their backgrounds.
- The tool is reviewed with JAWS as part of Accessiblü's own audit process.

You can change the shortcut at `chrome://extensions/shortcuts`.

## Install for local development

1. Clone this repo.
2. Open `chrome://extensions/` in Chrome.
3. Turn on Developer mode.
4. Select Load unpacked and choose the repo folder.
5. Open any web page and select the Accessiblü icon in the toolbar, or use the keyboard shortcut.

The extension can't run on `chrome://` pages or the Chrome Web Store.

## How it's built

Ü Check is plain JavaScript on Chrome Manifest V3, with no build step. I develop it with Claude as a coding partner, and you'll see that in the commit history. I set the direction, review every change, and test the results with real assistive technology before anything ships. Using AI this way lets a small accessibility firm build and maintain tooling that would otherwise take a dedicated dev team.

See the [changelog](CHANGELOG.md) for release notes.

## Credits

- [axe-core](https://github.com/dequelabs/axe-core) by Deque Systems, Inc. powers the automated rules engine. axe-core is licensed under the [Mozilla Public License 2.0](https://www.mozilla.org/MPL/2.0/), and its license header is kept in `axe.min.js`.
- [Open Sans](https://fonts.google.com/specimen/Open+Sans) is licensed under the SIL Open Font License 1.1.

## License

Copyright © 2026 Accessiblü Solutions, LLC. All rights reserved. The source is published here for reference and review. See [LICENSE](LICENSE) for details. Third-party components keep their own licenses, as listed under Credits.

## Contact

Questions or a bug report? [Contact Accessiblü](https://www.accessiblu.com/contact/) or open an issue.
