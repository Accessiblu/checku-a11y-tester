# Ü Check changelog

Ü Check is the Accessiblü browser extension for WCAG auditing. Versions are the `version` in `manifest.json`.
After you reload the extension in `chrome://extensions`, the new number shows on its card.

## Unreleased

### Changed
- Updated the bundled axe-core engine from 4.8.4 to 4.14.0. The `axe.run` options and WCAG tags Ü Check uses are unchanged. Newer rules may report a few findings older versions missed.

## 1.15.0 (2026-10-19)

### New
- **Attach an image file to a check.** Under "Take a screenshot of the page", each check now has "Or attach an image file from this computer". Use it for a screenshot from a phone or another tool. PNG or JPEG, up to 5 MB, and the same five-per-check limit. You are asked to describe it, which becomes its text alternative.
- In Ü Monitor, a finding now has **Attach an image file** (with a required description), **Attach a screenshot from this audit** (pick from the screenshots your testers already took), a way to edit each description, and **Remove from this finding**. A screenshot nothing else uses is deleted with its file when you remove it.

### Notes
- Files are checked by their contents, not their name, so a text file renamed `.png` is refused with a plain message.

## 1.14.0 (2026-10-19)

### New
- **Highlight all groups on the page.** One button at the top of the Guided Audit draws every element group on the page at once, each in its own color, labeled with its group code (G-003 and so on). A legend names each group and says how many elements were found, and tells you when the number differs from what the inventory counted. Color is never the only cue: the legend and the labels carry the names.
- **Screenshots as evidence.** Every check has "Take a screenshot of the page". It captures what is visible in the tab, including any highlight you have showing, saves it to Ü Monitor, and attaches it to that check's answer. Describe what each screenshot shows (that text becomes its alternative text for screen readers), and remove one if it is wrong. Up to five per check.
- Screenshots come back when you reload the checklist, and travel with the answer when you save.
- In Ü Monitor: a **Test results** page lists the answers with their screenshots, and "Log a finding from this result" starts a finding with the question, what you saw, the failing count, the criteria and the screenshots already filled in. Findings show their evidence, to clients too once published.

### Notes
- Screenshots are stored privately in Ü Monitor. Only people who may see the finding (or, before it exists, Accessiblü staff) can open them, through short-lived links.
- Chrome cannot capture its own pages, the Web Store, or a tab that is not the active one.

## 1.13.0 (2026-10-19)

### New
- **Show on page.** Every element check in the Guided Audit has a "Show these N on the page" button. It draws numbered boxes over the elements that group counted, scrolls to the first, and leaves the page itself unchanged.
- **Step through them.** "Previous element" and "Next element" move a bold yellow "3 of 6" marker from one element to the next and scroll it into view. The status line says which one it is: its name, and what kind of element.
- **Move keyboard focus to it on the page.** Puts keyboard focus on the current element, so a screen reader reads it where it lives. This can close the popup, and your answers are kept. Pop the window out first to keep it open.
- "Clear highlights" removes everything. Highlights also work inside iframes. Whole-page checks say there is nothing to highlight.
- If the page has changed since the Element Inventory, you are told nothing was found and to run the inventory again.
- Every step is announced to screen readers, and focus stays on the control you used.

### Notes
- Highlighting finds the elements again with the same rules the Element Inventory used, so the number of boxes matches the group's count.
- Some pages, such as Chrome's own pages and the Web Store, do not allow extensions to draw on them.

## 1.12.0 (2026-10-19)

### New
- **Apply this answer to the other groups.** In the Guided Audit, a Yes, N/A or Unsure answer now has a button that copies it to the other groups of the same kind of element (for example, the other link groups). Groups that already have an answer are left alone. Copied answers are marked "Not saved yet" until you save. A No is never copied, because the failing count belongs to one group.

### Fixed
- After saving in the Guided Audit, keyboard and screen reader focus went missing because the Save button was redrawn. Focus now returns to Save, and the result is announced.
- Sending a scan now makes sure the per-criterion element counts are included, and the confirmation tells you how many criteria they were sent for.

## 1.11.0 (2026-10-19)

### New
- **Guided Audit tab.** A checklist for the page you are on, built from the team's checks and the page's Element Inventory. Answer each check for each group of elements: Yes (passes), No (fails), N/A or Unsure. For a No, say how many instances fail. If you did not review every instance, say how many you reviewed, and the rest stay unresolved. Add what you saw if you want.
- Answers are saved to Ü Monitor with one button, and they come back when you reload, even from another computer. Unsaved answers are also kept on this computer, so closing the popup loses nothing. A problem with an answer is shown on that check and nothing wrong is sent.
- If you made an AI plan for the page (Ü Monitor tab), its priorities and test steps show on each check, and high-priority groups come first.
- Filters: all checks, not answered yet, or high priority from the AI plan. Each group shows how many of its checks are answered.
- Whole-page and text checks are included under "Whole page" and "Text on the page".
- In Ü Monitor, the audit page now turns the answers into counts by criterion (pass, fail, unresolved) with a suggested level, so a team can choose Supports, Partially Supports or Does Not Support from the real numbers.

## 1.10.0 (2026-10-19)

### New
- **Plan this page with AI.** In the Ü Monitor tab, after you run the Element Inventory, the new button sends the inventory to Ü Monitor and asks Claude (made by Anthropic) for a draft checklist for that page. Each item names a real check from the team's catalog, says why it matters on this page, and gives steps for the keyboard, JAWS, NVDA, VoiceOver and a visual check. It also lists what the inventory could not count, so you test those by hand.
- It only suggests. Use "I will use this plan" or "Discard this plan" so the team can see which drafts helped.
- **It works only when the client has turned AI features on.** The client's own administrator does that in Ü Monitor Settings. If it is off, nothing is sent and you see a message saying so.
- A plan takes a minute or two and costs a few cents. Ü Monitor logs each run and stops at a daily limit per audit.

## 1.9.0 (2026-10-17)

### New
- **Element counts for each WCAG criterion.** After an automated scan, the VPAT Matrix shows how many elements the scan checked for each criterion and how many passed. For example, "17 of 20 elements pass (3 fail)" for 1.3.1. Use these counts to choose between Supports, Partially Supports and Does Not Support.
  - An element is counted once per criterion, even when several rules check it. If it fails any rule, it counts as a failure.
  - Elements that need review are counted separately and are never counted as passes.
  - A suggested level appears from the counts alone: Partially Supports when some fail, Does Not Support when more than half fail. It never suggests Supports, because automated checks cannot confirm that. You still choose the level.
- The counts are in the VPAT CSV (checked, passing, failing and needing review), the JSON export, and the report.
- The counts are sent to Ü Monitor with the scan. The audit page there adds the latest scan of each page together and shows the totals by criterion.

### Notes
- These are automated counts. Automated rules cover only some criteria (23 of 55 here), and only part of what each one needs. Criteria without automated rules show no counts. Manual and guided checks add to them later.
- Counts are per page. A header that appears on every page is counted once on each page.

## 1.8.0 (2026-10-17)

### New
- **Ü Monitor tab.** Sign in with your Ü Monitor email and password, and Ü Check finds the audit that matches the page you are on. You can then send:
  - automated scan results (axe-core), with new issues told apart from ones already known
  - the Element Inventory, with the same group codes each time you rescan
  - the VPAT Matrix verdicts
- Your password is sent only to the sign-in service. It is not stored. Sign-in renews itself, so you are not asked again each hour.
- Screen readers read "Ü" as "U" in the heading and the tab name.

### Changed
- **Renamed from "Check Ü" to "Ü Check"**, in the extension name, window title, keyboard shortcut description, install notes and exported reports.
- Exported reports now say "Ü Check by Accessiblü" as the tool, with the extension version.
- The extension description now mentions Ü Monitor.
- The footer of the popup now shows the real version (it was stuck at "v1.5.0").
- The hidden Pulse tab was removed. It had no backend. Ü Monitor replaces it.

### Notes
- The Ü Monitor tab appears with the test results, so run a test first. The default server address is `http://localhost:3000/api/v1`. It changes when Ü Monitor is hosted.
- Sending guided check answers (yes, no, not applicable) is built into the Ü Monitor API but not into this extension yet. Guided audits come in a later version.

## 1.7.0
- Element Inventory: counts every instance of links, buttons, images, form fields, headings and more on a page, in every frame, and says what it could not count. Exports to CSV and JSON in the shape of the audit workbook's Inventory sheet.
- Links to the W3C reference for each criterion in the VPAT Matrix.
- (Recorded afterwards from the project files. Earlier notes for 1.6.0 were not kept.)

## 1.5.0
- Added an unfinished "Pulse" tab for sending VPAT verdicts to a planned service. It was hidden and later replaced by Ü Monitor.

## 1.4.2
- Published version. Listing renamed to "Accessiblu: WCAG Accessibility Audit + VPAT".

## 1.4.1
- Baseline import of "Accessiblü WCAG Check Ü".
