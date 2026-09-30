# What Bidspoke is missing to take over every Pipedream workflow

Written 2026-09-30 from the Pipedream export of that day (346 workflows, 320 switched on, 11 already on Bidspoke) and a check of Bidspoke's current code. Counts are workflows that are switched on, including test and old copies, so the real numbers will drop as your team switches more off.

Pipedream Workflows stops on 2027-03-31 and deletes everything, logins included, by 2027-04-30.

Tracked in milestone 56, "Move every Pipedream workflow to Bidspoke" (https://github.com/Try-Pennie/bidspoke/milestone/56). The plan that builds these lives in Discussion #1684 (https://github.com/Try-Pennie/bidspoke/discussions/1684). Every "Decided" line below summarises one of Dan's decisions of 2026-09-30 in plain words and names its number in the record, which holds the exact wording: https://github.com/Try-Pennie/bidspoke/discussions/1684#discussioncomment-18687008. The counts come from the 2026-09-30 snapshot and will be refreshed from the fresh export taken before porting starts.

---

## A. Features to build

### 1. Scheduled runs (67 workflows)
Today: a Bidspoke workflow can only start when something calls its web address.
Need: run on a schedule (every day at 8am New York time, every 15 minutes, and so on), with daylight saving handled, never running twice for the same slot, and a clear view of the last and next run.
Also borrowed from Automatisch: simple presets (hourly, daily, weekdays only) with full schedule syntax as an advanced option.

### 2. Code libraries in code steps (76 workflows)
Today: a Bidspoke code step cannot load any outside library, and lacks the basic helper for files and encoded data (63 workflows use it).
Need: an approved, pinned, security scanned set of libraries (Google's toolkit, CSV parsers, date libraries, the Supabase client and so on). Anything outside the set is refused when saved, with the reason. Decided (decision 16): an approved, pinned set.
Also: the code steps' outbound traffic gets a checkpoint (today they can call anything, issue #1390).

### 3. Partner token logins (about 16 workflows, #1676)
Today: Bidspoke only accepts a fixed key from a caller.
Need (decisions 7 and 10): the same login Pipedream gives partners today, matched exactly so partners notice nothing. The partner sends its client ID and secret and gets a token starting `at_`, valid for 6 hours, which every bid is checked against. Each partner's existing ID and secret carry over, live tokens carry over at cutover, and each workflow keeps its own exact rejection message.
Partners: Engine, Borrow Better, LendingTree, Lead Economy, AmOne, EPCVIP, Pivot Debt, TLG, Smartly, RML.

### 4. Seeing the whole incoming request (32 read headers, 18 read the address's query, some send forms or plain text)
Today: a workflow only sees the JSON body. Bidspoke refuses anything that isn't JSON, accepts only POST, and some addresses can only answer in JSON.
Need: headers, query string, form and text bodies, other request methods, and replies in any format.

### 5. Connections to other services
Today: none of these exist as steps in Bidspoke, and there is no way to connect an account.
Need, with counts:
1. Google Sheets (30), Gmail (12), Google Calendar (7), Google Drive (5)
2. Supabase (23)
3. Snowflake (9)
4. Slack through its API (7). The 33 that post to Slack through a plain web address already work.
5. OpenAI and Anthropic (6)
6. Sendblue, Twilio, Regal, Cal.com, Taktile, Even Financial and Engine are plain web calls today and keep working through the web request step.

Decided (decision 17): company accounts by default (a Google service account, a Slack bot, one Salesforce login per org), with a personal login only where a workflow must act as a named person, flagged so we know it breaks if they leave.
Borrowed from Automatisch:
1. Each service described once (its login fields, actions and triggers), shared by the canvas, the converter and the Claude tool.
2. A raw API request step for every connection, so anything unusual still works without hand written code.
3. Dropdowns filled live from the service (pick the Salesforce object or the sheet column from a list).
4. A scheduled check that each connection still works, with a reconnect prompt before a workflow fails.

### 6. More than one Salesforce org
Today: Bidspoke logs into one Salesforce org.
Need: one connection per org. The export uses trypennie (47 workflows), pennie (3), tpl2 (2), Liberty1's (1) and Achieve's (1, `Import Tradelines`, through its own `ACHIEVE_SF_*` settings).

### 7. Data stores (104 workflows)
Today: Bidspoke has one shared store that can only save, read and delete, and code steps can't reach it.
Need: separate named stores, "get it or create it" (17), listing what's inside, expiry times, and access from inside code steps.
Also: Pipedream's store contents are NOT in the export and must be copied out before 2027-04-30. Some hold live state, such as phone line assignments and partner tokens.

### 8. Triggers other than a web address
Today: none.
Need:
1. A Slack keyword or channel message (18)
2. An email arriving at an address (7), such as partner reports sent by email
3. A new Gmail message (2), a new Google Calendar event (1), a new Google Sheets row (1)

Borrowed from Automatisch:
1. Polling that never floods through old items on its first run and never takes the same item twice.
2. Webhooks that register themselves with the service when a workflow is switched on, and remove themselves when it's switched off.
3. Sending something to a switched off workflow captures a sample to build with.

### 9. Long runs, waits and retries
Today: a step stops at 30 seconds by default, and there is no "wait, then carry on" step.
Need:
1. Runs of several minutes (44 allow over 2 minutes, up to 12.5).
2. A delay step of minutes to hours (4).
3. Automatic re-run of a failed run (47), done so that nothing already sent gets sent twice.
4. A limit on how many copies of a workflow run at once (2).

Decided (decision 5): we build this ourselves on the existing database and timer, not a paid Cloudflare service.

### 10. Keeping the new work away from bidding (a hard rule)
Today: Bidspoke only runs money flows.
Need: a separate lane, a second copy of Bidspoke, where all the new work runs, so a stuck importer, a flood of Slack events or a long AI call can never delay a bid or use up Salesforce capacity.
Decided (decisions 11 and 6):
1. Ops gets a Salesforce share set from bidding's measured peak, which you approve.
2. Whether ops also gets its own database is chosen on merit, not cost.

### 11. Workflows calling other workflows (31 calls)
Today: this works as a plain web call, so it's mostly a matter of order: a called workflow moves before the workflows that call it. The plan also adds a proper "call another workflow" step.
Most called: "Send rejection to Salesforce" (16 callers) and "Gather Webhook Responses After Send" (10).

### 12. Workflow scoped settings (#1681)
Today: Bidspoke lets you save a setting against one workflow, but runs never load it.
Need: fix it, since ported workflows keep their own settings.

---

## B. Tools for doing the move

### 13. A converter for the new export format
Today: the old importer was deleted in June because its output never ran.
Need: turn each exported workflow into a draft Bidspoke workflow plus a checklist of what it couldn't convert. It only counts as done when its drafts actually run correctly against real traffic. The export does include the steps inside branches.

### 14. A Claude tool (runs on your Mac)
Need (decision 13): a tool that lets me build, edit, check and test workflows on the same definitions you edit on the canvas, with a personal token you can revoke. Switching a workflow on stays a human click.

### 15. Side by side comparison before each cutover
Need: record real Pipedream traffic, run the Bidspoke version quietly against it, and compare. The bar is set per workflow by its volume, and you see the evidence before each switch (decision 12). Recordings are kept until cutover, never more than 90 days (decision 15).

### 16. Snapshot comparison
Need: compare a fresh Pipedream export with the previous one, so anything changed on Pipedream since a port was built gets caught.

### 17. Cutover and rollback checklist per workflow
Need: each workflow's steps to switch over, and to switch back if something's wrong.

### 18. A new fallback for engine bidding (#1675)
Today: the recovery plan says to fall back to the Pipedream copy of engine bidding. That disappears on 2027-03-31.
Need: a fallback that doesn't depend on Pipedream.

---

## C. Things to figure out (not software)

### 19. Copying out what Pipedream will delete
Decided (decisions 1 to 3): I build and run the tooling, and you approve each step. It covers:
1. Data store contents.
2. About 90 passwords and keys. You'll try Pipedream first, then existing copies, then the partner.
3. The step settings the export blanked (sheet IDs, Salesforce objects, filter rules, Slack channels, about 174 workflow files), read from your browser, read only, if Pipedream offers no better way.

### 20. SFTP file transfers and fixed IP addresses (12 workflows)
Cloudflare can do neither. Decided (decision 8): this work runs on Brian's AWS box, which has a fixed IP address and is already allowlisted with Achieve. Brian agreed the same day, as Dan reported in that session (decision 8 in the record linked above). The box fetches each file and hands it to Bidspoke, which does everything else, and Bidspoke alerts when an expected file does not arrive, because the box is a single machine one person looks after.

### 21. Repointing every caller
Every Pipedream workflow has its own web address, configured somewhere else. Each one needs changing, by us or by the owner:
1. Partners' systems
2. Your forms
3. Salesforce flows
4. Regal, Cal.com, Twilio and Sendblue webhooks
5. The vendors who email reports

### 22. Main Flow's two Pipedream helpers (#1680)
Both live Main Flows still call two Salesforce workflows that run on Pipedream. Those two move first.

### 23. Marcia and Zoe booking bots
Decided (decision 9): no browser capability is built for them now. Their booking moves off Cal.com onto Slate, and they are among the last workflows ported, because they are the most complex.

### 24. Which workflows to port
Decided (decision 4): every workflow that's switched on in the fresh export, with the Marcia and Zoe booking bots ported last (item 23). As of 2026-09-30 the team was switching more workflows off, so the fresh export, not this snapshot, decides the list.
