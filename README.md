# Ü Check by Accessiblü

Ü Check is a Chrome extension for WCAG 2.2 auditing. It runs the automated checks, inventories every element on the page, walks an auditor through the manual checks group by group, and turns all of it into a VPAT matrix and an Accessibility Conformance Report (ACR).

I built it because my team at Accessiblü needed a tool that matched how we actually audit. Automated scans cover only part of WCAG. Most of the real work is manual review, and the tool should carry the evidence from both into the report.

[Install Ü Check from the Chrome Web Store](https://chromewebstore.google.com/detail/acimaoihbmigdidmhjnheiaaoophmmki)

Current version: 1.16.0. See the [changelog](CHANGELOG.md).

## What it does

### Automated testing

- Runs WCAG 2.2 checks at Level A, AA or AAA using axe-core
- Sorts results into Violations, Passes and Needs Review
- Counts elements for each WCAG criterion, for example "17 of 20 elements pass (3 fail)" for 1.3.1, and suggests Partially Supports or Does Not Support from those counts. It never suggests Supports, because automated checks can't confirm that. The auditor makes the call.

### Audit tools for what automation misses

axe-core looks at a snapshot of the page. Some barriers only show up when focus moves or the page updates, so Ü Check adds its own checks:

- Check Focus Indicators finds elements where the browser's focus ring is removed and nothing replaces it (2.4.7 Focus Visible). Chrome only applies focus styles while the page itself has focus, so when Ü Check is in the side panel it reads the page's CSS, including stylesheets from other domains, instead of watching the page.
- Watch Live Regions lists every `aria-live`, `role="status"`, `role="alert"`, `role="log"` and `output` region and records each update while you use the page, so you can confirm status messages actually fire (4.1.3 Status Messages)
- `role="application"` regions go to Needs Review, because that role turns off a screen reader's reading keys (2.1.1 Keyboard)
- Drag-and-drop elements and libraries go to Needs Review, so you can confirm a single-pointer alternative exists (2.5.7 Dragging Movements)

### Element Inventory

- Counts every link, button, image, form field, heading and more on the page, including inside iframes, and says what it couldn't count
- Groups elements with stable group codes (G-003 and so on) that stay the same when you rescan
- Exports to CSV and JSON

### Guided Audit

- Builds a manual checklist for the page from Accessiblü's check catalog and the Element Inventory
- For each check and element group, the auditor answers Yes, No, N/A or Unsure, records how many instances fail and how many were reviewed, and adds notes
- Show on page draws numbered boxes over the elements in a group. Previous and Next step through them one at a time, and focus can be moved to the element so a screen reader reads it in place.
- Highlight all draws every group on the page at once, each with its own color, label and legend. Color is never the only cue.
- Screenshots as evidence: capture the visible tab or attach an image file, describe it (that description becomes its text alternative), and attach it to the answer
- Copy an answer to other groups of the same kind. A No is never copied, because a failing count belongs to one group.

### Reporting

- VPAT matrix with per-criterion counts and links to the W3C reference for each criterion
- Exports to JSON, CSV and a full ACR
- Inspectors for tab order, headings, landmarks, lists, images, icons, color contrast and ARIA, plus the focus indicator and live region tools above

### Ü Monitor integration

Ü Check connects to Ü Monitor, Accessiblü's audit and monitoring platform, which is in development. Signed-in auditors can send scan results, the Element Inventory, Guided Audit answers, screenshots and VPAT verdicts to the matching audit, where the team turns them into findings and conformance levels.

An optional AI test plan asks Claude (made by Anthropic) for a draft checklist for the page, built from the Element Inventory and the team's check catalog, with steps for keyboard, JAWS, NVDA, VoiceOver and visual testing. It only suggests. The client's own administrator decides whether AI features are on, and a person decides every result.

## Accessibility of the tool itself

An accessibility tool that fails its own audit isn't much use, so Ü Check is built and tested with keyboard and screen reader users in mind.

- Press `Ctrl+Shift+A` (Windows and Linux) or `Cmd+Shift+A` (macOS) to open Ü Check in a focused standalone window. Your screen reader announces it right away.
- If you prefer the side panel, press `F6` to move focus between the address bar, the page and the side panel.
- Status changes are announced through a live region, and focus stays on the control you used.
- The tool is reviewed with JAWS as part of Accessiblü's own audit process.

You can change the shortcut at `chrome://extensions/shortcuts`.

## Install for local development

1. Clone this repo.
2. Open `chrome://extensions/` in Chrome.
3. Turn on Developer mode.
4. Select Load unpacked and choose the repo folder.
5. Open any web page and select the Ü Check icon in the toolbar, or use the keyboard shortcut.

The extension can't run on `chrome://` pages or the Chrome Web Store. The Ü Monitor features need an Ü Monitor account. Everything else works without one.

## How it's built

Ü Check is plain JavaScript on Chrome Manifest V3, with no build step. I develop it with Claude as a coding partner, and you'll see that in the commit history. I set the direction, review every change, and test the results with real assistive technology before anything ships. Working this way, releases 1.8 through 1.15, which added the Ü Monitor connection, per-criterion counts, the Guided Audit and screenshot evidence, shipped over three days in October 2026.

This public repo holds the extension only. Ü Monitor is developed separately.

## Credits

- [axe-core](https://github.com/dequelabs/axe-core) 4.14.0 by Deque Systems, Inc. powers the automated rules engine. axe-core is licensed under the [Mozilla Public License 2.0](https://www.mozilla.org/MPL/2.0/), and its license header is kept in `axe.min.js`.
- [Open Sans](https://fonts.google.com/specimen/Open+Sans) is licensed under the SIL Open Font License 1.1.

## License

Copyright © 2026 Accessiblü Solutions, LLC. All rights reserved. The source is published here for reference and review. See [LICENSE](LICENSE) for details. Third-party components keep their own licenses, as listed under Credits.

## Contact

Questions or a bug report? [Contact Accessiblü](https://www.accessiblu.com/contact/) or open an issue.
