# @dorks/desktop

## 0.13.1

### Patch Changes

- [#292](https://github.com/handlemotion/dorks/pull/292) [`b097eb3`](https://github.com/handlemotion/dorks/commit/b097eb35431847a2c7b871f80eb74a57d5f4a895) Thanks [@handlemotion](https://github.com/handlemotion)! - Scrolling up a long chat keeps your place: reaching the top while older messages load no longer throws you to the start of the chat.

- [#296](https://github.com/handlemotion/dorks/pull/296) [`4f8524f`](https://github.com/handlemotion/dorks/commit/4f8524f711a95033dde84d3021659966e97a686f) Thanks [@handlemotion](https://github.com/handlemotion)! - A new preview comment is just its input box, without a card around it.

- [#286](https://github.com/handlemotion/dorks/pull/286) [`9fc629c`](https://github.com/handlemotion/dorks/commit/9fc629cb9129b6e5522b13b3d2173af8634116a2) Thanks [@handlemotion](https://github.com/handlemotion)! - The Mac download is now named `dorks-v<version>.dmg`, and https://dorks.build/download always gets the latest one.

- [#287](https://github.com/handlemotion/dorks/pull/287) [`6004ca2`](https://github.com/handlemotion/dorks/commit/6004ca2e58060d4b1e8c61f16240ff458989dee5) Thanks [@handlemotion](https://github.com/handlemotion)! - A nerd's details have the same tabs as a chat's: every tab closes, and the + New tab lists the crew's pull requests, Sessions and Artifacts, so a closed PR tab can be opened again.

- [#291](https://github.com/handlemotion/dorks/pull/291) [`5cbe5ce`](https://github.com/handlemotion/dorks/commit/5cbe5ce6c53c750b40f19bd3d38f58f5605d6ff6) Thanks [@handlemotion](https://github.com/handlemotion)! - A personal organization that already has automations keeps its Automations page, so it can still pause or delete them; it cannot create new ones.

- [#290](https://github.com/handlemotion/dorks/pull/290) [`cd4fd4c`](https://github.com/handlemotion/dorks/commit/cd4fd4c08d4e4807f79fca9be89396f3b0237427) Thanks [@handlemotion](https://github.com/handlemotion)! - Automations are now only in team organizations: a personal organization runs on your Mac, which can be asleep or offline when an automation is due, so its Automations page is hidden.

- [#285](https://github.com/handlemotion/dorks/pull/285) [`8f446ca`](https://github.com/handlemotion/dorks/commit/8f446ca4fb6a7b17dfda0f1df48f2332c87ef052) Thanks [@handlemotion](https://github.com/handlemotion)! - Danger buttons are now solid red with white text everywhere, and menu items stay on one line.

## 0.13.0

### Minor Changes

- [#273](https://github.com/handlemotion/dorks/pull/273) [`6374bd2`](https://github.com/handlemotion/dorks/commit/6374bd2101f37d27aee37ff4be0637b5fede0aa7) Thanks [@handlemotion](https://github.com/handlemotion)! - Teams and Cloud organizations that run in Dorks Cloud now stream their chats live from the cloud, resuming without gaps after a dropped connection.

- [#282](https://github.com/handlemotion/dorks/pull/282) [`c758922`](https://github.com/handlemotion/dorks/commit/c7589229b3a99e5b127c2a1e8f635db226516620) Thanks [@handlemotion](https://github.com/handlemotion)! - Skills: the skills already on your Mac (~/.agents/skills and ~/.claude/skills) now reach every session automatically and follow edits to their folder. Remove one from Dorks only, or from your Mac for every agent.

- [#278](https://github.com/handlemotion/dorks/pull/278) [`1cd82bc`](https://github.com/handlemotion/dorks/commit/1cd82bc3b53105abc205ab0e346c3aeaadfae011) Thanks [@handlemotion](https://github.com/handlemotion)! - Move to cloud: in Settings › Organization, owners and admins of a Teams or Cloud organization that runs on their Mac can move it to Dorks Cloud with its sessions, chats, automations, MCP servers, skills and shared variables.

### Patch Changes

- [#277](https://github.com/handlemotion/dorks/pull/277) [`1e4d712`](https://github.com/handlemotion/dorks/commit/1e4d71208b444e15b805e162414b63df7c1911af) Thanks [@handlemotion](https://github.com/handlemotion)! - Cloud sessions: secure input requests and answers appear in the session's transcript.

- [#275](https://github.com/handlemotion/dorks/pull/275) [`203d4e2`](https://github.com/handlemotion/dorks/commit/203d4e21e69c6e739594180307f5a337f34a026b) Thanks [@handlemotion](https://github.com/handlemotion)! - Cloud sessions: the sandbox's bridge can now talk to s2 and the cloud Worker directly instead of waiting for a server to dial it.

- [#281](https://github.com/handlemotion/dorks/pull/281) [`ca6196e`](https://github.com/handlemotion/dorks/commit/ca6196e2d650f4fb0b70277a0280e1fd0825aac4) Thanks [@handlemotion](https://github.com/handlemotion)! - The chat's message index sits 4px closer to the edge, and a message's hover time no longer lands on it: when the two would overlap, the time shows in the message's toolbar instead.

- [#276](https://github.com/handlemotion/dorks/pull/276) [`49f8d75`](https://github.com/handlemotion/dorks/commit/49f8d75a40ea99bd55c8c122090ab77d4f816b77) Thanks [@handlemotion](https://github.com/handlemotion)! - In Teams and Cloud organizations, a chat's header shows which teammates are looking at it.

- [#266](https://github.com/handlemotion/dorks/pull/266) [`50aee38`](https://github.com/handlemotion/dorks/commit/50aee385742cd364db9361bec03f0f9b8f3b0fe6) Thanks [@handlemotion](https://github.com/handlemotion)! - The composer now sends the effort it shows, and every model starts at the effort its maker recommends (Opus 5.5 at medium). An effort you pick for a model is remembered for your next sessions.

- [#272](https://github.com/handlemotion/dorks/pull/272) [`c723f30`](https://github.com/handlemotion/dorks/commit/c723f309adeeada144b1d66126b78a52a8412d97) Thanks [@handlemotion](https://github.com/handlemotion)! - When an agent is waiting on you (a permission, a question, a secure input) and that request is scrolled out of view, a small Needs action pill floats above the composer; click it to jump to the request. A failed ship no longer marks the session as needing you: the agent is already told to fix it.

- [#271](https://github.com/handlemotion/dorks/pull/271) [`39299bf`](https://github.com/handlemotion/dorks/commit/39299bf086d2a049f2c29e103f066fc135624c28) Thanks [@handlemotion](https://github.com/handlemotion)! - Nerds now hear what happens to their workers' pull requests: a merge or close (including your own), a conflict, or CI stalled for a human arrives as a report, so a nerd no longer waits on a PR that landed long ago.

- [#268](https://github.com/handlemotion/dorks/pull/268) [`4f25316`](https://github.com/handlemotion/dorks/commit/4f25316a0701820349c99c2fac35d1d241d590f1) Thanks [@handlemotion](https://github.com/handlemotion)! - Relayed requests from the phone and teammates can no longer reach local access, secure inputs or the box's desktop by percent-escaping the path.

- [#269](https://github.com/handlemotion/dorks/pull/269) [`e65af1a`](https://github.com/handlemotion/dorks/commit/e65af1a3cc16be2f2360504a3b00d9a9394be880) Thanks [@handlemotion](https://github.com/handlemotion)! - Team admins can no longer turn on "Always allow" for this computer through Settings: local access stays with the computer's owner.

## 0.12.1

### Patch Changes

- [#262](https://github.com/handlemotion/dorks/pull/262) [`0f94090`](https://github.com/handlemotion/dorks/commit/0f9409069420408e6b7e9d7f224fe25109bd4db7) Thanks [@handlemotion](https://github.com/handlemotion)! - The GitHub owner filter moved from beside the organization switcher into the archived sessions list, where it narrows archived sessions to one owner.

- [#254](https://github.com/handlemotion/dorks/pull/254) [`df0f4e9`](https://github.com/handlemotion/dorks/commit/df0f4e9db1768d3d1e4640afe90d6f0c2307d76c) Thanks [@handlemotion](https://github.com/handlemotion)! - The desktop app opens dorks:// links: an organization invitation email opens the invitation in Dorks, and a phone pairing link opens Settings › Phone.

- [#260](https://github.com/handlemotion/dorks/pull/260) [`79fd5df`](https://github.com/handlemotion/dorks/commit/79fd5df573504bc4abd6a8fb0c2e28af6b17595d) Thanks [@handlemotion](https://github.com/handlemotion)! - Nerds no longer wear a green mark in the sidebar: their own Nerds group sets them apart, so their mark shows their state like any session.

- [#263](https://github.com/handlemotion/dorks/pull/263) [`f3a6179`](https://github.com/handlemotion/dorks/commit/f3a6179044ea95d309768a3206ab6b620889ae2d) Thanks [@handlemotion](https://github.com/handlemotion)! - A personal organization no longer shows any team UI: no sender names over your messages, no initials on chats, no presence avatars and no members list.

- [#264](https://github.com/handlemotion/dorks/pull/264) [`faf7c0a`](https://github.com/handlemotion/dorks/commit/faf7c0a5cae9503f94ae69300aa8d92055818d87) Thanks [@handlemotion](https://github.com/handlemotion)! - An organization with nothing to run it yet now suggests moving it to Dorks Teams, in the plan names Dorks Cloud uses.

- [#265](https://github.com/handlemotion/dorks/pull/265) [`58abe67`](https://github.com/handlemotion/dorks/commit/58abe673a5f8dd6596968081e60fd068a06d7bd4) Thanks [@handlemotion](https://github.com/handlemotion)! - Secure input forms are simpler: a form asking for one value no longer repeats its title and description on the field, and the agent can link each field to the page where you get it (like Cloudflare's API tokens page).

## 0.12.0

### Minor Changes

- [#246](https://github.com/handlemotion/dorks/pull/246) [`5df5d71`](https://github.com/handlemotion/dorks/commit/5df5d71b525a0987b8516b6abbc1f8eb46638041) Thanks [@handlemotion](https://github.com/handlemotion)! - The sidebar's top switcher now lists your Dorks Cloud organizations: sign in from Settings with an emailed code, create an organization, and switch the whole app to its server (your other Macs or an organization's hosted server). The GitHub owner filter moved to a button beside it.

- [#245](https://github.com/handlemotion/dorks/pull/245) [`25a36e6`](https://github.com/handlemotion/dorks/commit/25a36e6ce7d5e3917fee6d291e7188f0a0c6248a) Thanks [@handlemotion](https://github.com/handlemotion)! - Shared chats for teams: a teammate's messages show who sent them and the agent is told who wrote each one, chats show who started them, and the chat header shows who else is looking. Teammates reaching your server through the Dorks cloud are checked against their team role.

### Patch Changes

- [#247](https://github.com/handlemotion/dorks/pull/247) [`ceebc17`](https://github.com/handlemotion/dorks/commit/ceebc17b5daebe133f8b25b5f1443f17cbd4909d) Thanks [@handlemotion](https://github.com/handlemotion)! - Chat has its own automations: on a schedule, a GitHub event or a Sentry issue, they start a chat instead of a code session, and a schedule needs no repository.

- [#255](https://github.com/handlemotion/dorks/pull/255) [`8133d4f`](https://github.com/handlemotion/dorks/commit/8133d4f3b6fb403c9854c8247da9b5409731605b) Thanks [@handlemotion](https://github.com/handlemotion)! - Signed in to Dorks Cloud with no organization picked, the app now works in your personal organization (so its other Macs can be connected to), and an ended Dorks Cloud session is noticed while another server is shown.

- [#252](https://github.com/handlemotion/dorks/pull/252) [`92988d3`](https://github.com/handlemotion/dorks/commit/92988d3764d595c1e4f346c8ea37736f3f504199) Thanks [@handlemotion](https://github.com/handlemotion)! - A nerd's pull request tabs now show their next step, like "Resolve conflicts" on a conflicting PR, which asks the worker that opened it. PR tabs in a nerd's details can be closed.

- [#259](https://github.com/handlemotion/dorks/pull/259) [`f6d657c`](https://github.com/handlemotion/dorks/commit/f6d657caf2907223af0d244f01d33052cab14acf) Thanks [@handlemotion](https://github.com/handlemotion)! - Nerds keep their messages short: at most four lines and one small list, and a longer one is sent back to be cut before you see it.

- [#258](https://github.com/handlemotion/dorks/pull/258) [`035b131`](https://github.com/handlemotion/dorks/commit/035b13166aa60a8de3448afe07c9f655e90333f4) Thanks [@handlemotion](https://github.com/handlemotion)! - Plans now carry their names in the app: Dorks Local, Dorks Teams and Dorks Cloud, in the organization switcher and Settings › Organization.

- [#257](https://github.com/handlemotion/dorks/pull/257) [`6e16b96`](https://github.com/handlemotion/dorks/commit/6e16b96b7ae4e1915054e055eebe66ad8f7564a1) Thanks [@handlemotion](https://github.com/handlemotion)! - A pull request tab no longer shows the session's previous pull request after it opens a new one.

- [#240](https://github.com/handlemotion/dorks/pull/240) [`b6ebdfc`](https://github.com/handlemotion/dorks/commit/b6ebdfc465f643af2b0de785a6910109ea108229) Thanks [@handlemotion](https://github.com/handlemotion)! - Pairing a phone now goes through api.dorks.build, Dorks Cloud's own address.

- [#250](https://github.com/handlemotion/dorks/pull/250) [`fc263ba`](https://github.com/handlemotion/dorks/commit/fc263ba6e46529ccad616b284cd12f63c4197fbe) Thanks [@handlemotion](https://github.com/handlemotion)! - What you type when replying to a passage now rides with the reply instead of filling the composer, and a reply with a note sends on its own. The model menu is a short list across Claude, GPT and Gemini with search over every model, effort and fast mode on top. Toasts are tidier.

- [#248](https://github.com/handlemotion/dorks/pull/248) [`7567ea9`](https://github.com/handlemotion/dorks/commit/7567ea9446204f53905a65f15cbda410d00ad608) Thanks [@handlemotion](https://github.com/handlemotion)! - On a team server, only the person who wrote a preview comment can edit it; they, the team's admins and the owner can delete it.

- [#243](https://github.com/handlemotion/dorks/pull/243) [`68dc5cd`](https://github.com/handlemotion/dorks/commit/68dc5cd45595287c1df1cb2ce12465ec369b7ec7) Thanks [@handlemotion](https://github.com/handlemotion)! - Ship, build and todo cards in the chat reach a little past the text column, so what's inside them lines up with the thread. The avatar in the account menu is a little smaller.

- [#244](https://github.com/handlemotion/dorks/pull/244) [`48178da`](https://github.com/handlemotion/dorks/commit/48178da8061094749c3522c785e878adb1d266ff) Thanks [@handlemotion](https://github.com/handlemotion)! - The title bar switches between two workspaces, Agents (code sessions and nerds) and Chat, instead of listing chats and code together. Nerds have their own group in the sidebar and are always green; the composer drops its mode menu and names the session's build.

## 0.11.0

### Minor Changes

- [#239](https://github.com/handlemotion/dorks/pull/239) [`c31371b`](https://github.com/handlemotion/dorks/commit/c31371bf2338d2a95d6f007b7d6a7e5382ee8ec8) Thanks [@handlemotion](https://github.com/handlemotion)! - Builds show in the chat as cards: a machine change the agent proposes comes with a short scrollable diff and turns into the build's live steps once you approve it, and every trial run the agent starts shows its steps too.

- [#236](https://github.com/handlemotion/dorks/pull/236) [`b25f690`](https://github.com/handlemotion/dorks/commit/b25f690409a157732ff55c4ac6ace3eb11cc5e95) Thanks [@handlemotion](https://github.com/handlemotion)! - Right-clicking a chat in the sidebar, a step in Progress or a file in Files now opens a native menu with actions for it (open, copy the link, path, command or output, archive), and the app no longer shows the webview's Reload menu. Dragging across the app no longer paints its rows and labels blue: only messages, code and fields select, like a native app.

### Patch Changes

- [#237](https://github.com/handlemotion/dorks/pull/237) [`3b799fe`](https://github.com/handlemotion/dorks/commit/3b799fe5b3ca726d91c6e7540de79498b1556c73) Thanks [@handlemotion](https://github.com/handlemotion)! - Long chats open, switch and scroll faster: only the newest messages are drawn at first and older ones come in as you scroll up, already loaded. Progress, the image viewer and typing in the composer stay quick in long sessions too.

## 0.10.0

### Minor Changes

- [#228](https://github.com/handlemotion/dorks/pull/228) [`9061dfc`](https://github.com/handlemotion/dorks/commit/9061dfcf92b8036ca74558c64793835806ab5374) Thanks [@handlemotion](https://github.com/handlemotion)! - Your GitHub avatar now sits at the bottom of the sidebar and opens one menu with Settings (⌘,), usage, what's new in the latest releases with a link to the full changelog, the docs, a way to report a problem, and Change server.

- [#234](https://github.com/handlemotion/dorks/pull/234) [`28ece60`](https://github.com/handlemotion/dorks/commit/28ece60d27f6743adeb9a67283b8e0f8bd110190) Thanks [@handlemotion](https://github.com/handlemotion)! - A chat with several pull requests shows their count and icon in the sidebar, with a spinner while a merge ships; hovering lists the PRs and the checks still running. A PR closed or merged after the agent stopped watching it now turns red or violet.

### Patch Changes

- [#232](https://github.com/handlemotion/dorks/pull/232) [`1445522`](https://github.com/handlemotion/dorks/commit/1445522509030ad0796fd05206d3d051040e0bef) Thanks [@handlemotion](https://github.com/handlemotion)! - The show/hide comments button in the image viewer and preview toolbars is now an eye that crosses out when comments are hidden, instead of a speech-bubble icon with a count.

- [#235](https://github.com/handlemotion/dorks/pull/235) [`b32e64b`](https://github.com/handlemotion/dorks/commit/b32e64bbc91da0099edfb1e0fe286aba236b8a1a) Thanks [@handlemotion](https://github.com/handlemotion)! - Session status icons are now flat colours: no more gradients on the working, unread, attention or nerd marks.

- [#227](https://github.com/handlemotion/dorks/pull/227) [`85149a2`](https://github.com/handlemotion/dorks/commit/85149a220336e6e9652a1123cd30c9d7621785cd) Thanks [@handlemotion](https://github.com/handlemotion)! - A dork's icon is now a flat, lighter grey while it works or waits (no gradient), and a sleeping dork's outline is thinner. Message times show only in the left gutter on hover, so a final answer no longer leaves a gap under it, and a message's copy and reply buttons stay up while you move the pointer to them.

- [#229](https://github.com/handlemotion/dorks/pull/229) [`44e1453`](https://github.com/handlemotion/dorks/commit/44e1453a9aef685d6512800aa8a29368bba44f36) Thanks [@handlemotion](https://github.com/handlemotion)! - Dorks uses less memory and CPU when left open for days: chats you have left are released from memory, a hidden window stops following the agent's output until you open it again, and the server log no longer grows without limit.

- [#233](https://github.com/handlemotion/dorks/pull/233) [`c31e034`](https://github.com/handlemotion/dorks/commit/c31e034fb441b45d5570a8359d32751eea0c9910) Thanks [@handlemotion](https://github.com/handlemotion)! - Chats in the sidebar stay in the order they were created (newest first) instead of jumping to the top on activity; drag them to reorder.

## 0.9.0

### Minor Changes

- [#224](https://github.com/handlemotion/dorks/pull/224) [`47c9460`](https://github.com/handlemotion/dorks/commit/47c94601178cb8d1f8f22d76e24f77f5c16f29aa) Thanks [@handlemotion](https://github.com/handlemotion)! - Comment on images: in the image viewer, click or drag on a screenshot to leave a comment for the agent, like on a running preview. The viewer is cleaner too: thumbnails down the side, one toolbar under the image with the count and caption, and a soft blurred backdrop.

- [#223](https://github.com/handlemotion/dorks/pull/223) [`7f178df`](https://github.com/handlemotion/dorks/commit/7f178df6b30a7a4664c849542f336c973d311312) Thanks [@handlemotion](https://github.com/handlemotion)! - Claude agents now keep a to-do list, and each time they create or update it a to-do card shows the whole list right there in the chat.

- [#218](https://github.com/handlemotion/dorks/pull/218) [`c13ed04`](https://github.com/handlemotion/dorks/commit/c13ed04d9e3c48038f453030faf46e24cbb51694) Thanks [@handlemotion](https://github.com/handlemotion)! - Chats now show when they're unread: a session's icon turns blue when the agent finishes a turn you haven't opened yet, on every device. Yellow now only means the agent needs your permission or an answer; a working chat is grey, and a sleeping one is an outline.

### Patch Changes

- [#226](https://github.com/handlemotion/dorks/pull/226) [`7920bd6`](https://github.com/handlemotion/dorks/commit/7920bd62c631fe751d36b559200b69bc4fdaf2ea) Thanks [@handlemotion](https://github.com/handlemotion)! - The message box keeps the cursor while a message sends, and typing anywhere in a chat with nothing else focused goes straight into it.

- [#220](https://github.com/handlemotion/dorks/pull/220) [`731352a`](https://github.com/handlemotion/dorks/commit/731352a6295c86bd4eafdaecdfcee6a19ff6e6f6) Thanks [@handlemotion](https://github.com/handlemotion)! - PRs that merge while an earlier one is still shipping share one ship card ("Shipping [#7](https://github.com/handlemotion/dorks/issues/7) and [#8](https://github.com/handlemotion/dorks/issues/8)"). The ship card's running stages use a single-arc spinner, and its icons line up with their text. The card, the "PR merged" style notices and the answer above them are spaced evenly, and a screenshot in a message has the same space below it as above. A command or read on your computer, or a secure input request, no longer also shows a "Used local run" line in the thread.

## 0.8.0

### Minor Changes

- [#214](https://github.com/handlemotion/dorks/pull/214) [`462fd15`](https://github.com/handlemotion/dorks/commit/462fd155be956c728419b386a23d63e9dc5c775b) Thanks [@handlemotion](https://github.com/handlemotion)! - A Files tab in Chat details: browse the repositories checked out in a session's sandbox and edit their files in place, with a chooser when the sandbox holds more than one.

- [#199](https://github.com/handlemotion/dorks/pull/199) [`217849e`](https://github.com/handlemotion/dorks/commit/217849e30e69040824791ce9eba8945f19d757b4) Thanks [@handlemotion](https://github.com/handlemotion)! - A stack of pull requests now opens as one tab, with the stack drawn as connected dots under the PR's title. Merging from the top of a stack merges the whole stack in one go, through GitHub's asynchronous merge.

- [#212](https://github.com/handlemotion/dorks/pull/212) [`7865ac6`](https://github.com/handlemotion/dorks/commit/7865ac631f2d9da2cecbdb11e46112dc0c5cd95f) Thanks [@handlemotion](https://github.com/handlemotion)! - Pair the Dorks iPhone app with this Mac from Settings, Phone: scan the code with your phone and it reaches your sessions through the Dorks cloud relay.

- [#209](https://github.com/handlemotion/dorks/pull/209) [`3d4bf0c`](https://github.com/handlemotion/dorks/commit/3d4bf0c53306a3b6a1d3bae8ba3ff552848c6409) Thanks [@handlemotion](https://github.com/handlemotion)! - Automations can now start on Sentry: a new issue, an error spike past a number of events an hour, or a failing uptime or cron monitor. Connect Sentry in Settings, then add a Sentry trigger or start from the "Respond to downtime" template.

- [#205](https://github.com/handlemotion/dorks/pull/205) [`6497d8d`](https://github.com/handlemotion/dorks/commit/6497d8dd4b385b8db50628eb6a4a8fe8372bbc2b) Thanks [@handlemotion](https://github.com/handlemotion)! - When a merged pull request goes live, the agent checks its change on the live site and reports on the Ship card; when a ship fails, the agent opens a fix-forward or revert pull request.

- [#200](https://github.com/handlemotion/dorks/pull/200) [`626dd62`](https://github.com/handlemotion/dorks/commit/626dd6226ea1d84e89180660d9413d028979a8bc) Thanks [@handlemotion](https://github.com/handlemotion)! - After a session's pull request merges, a Ship card follows what the merge set off: the workflows on the base branch, migration steps, other apps' checks such as Cloudflare Pages, and deployments. A failed ship marks the session as needing you.

### Patch Changes

- [#210](https://github.com/handlemotion/dorks/pull/210) [`dc870a9`](https://github.com/handlemotion/dorks/commit/dc870a96ef9babc7ea0c6d7fc38e4ddceaebc2a4) Thanks [@handlemotion](https://github.com/handlemotion)! - Build pages: an agent's proposed change now sits at the top of the build with a Review button and a count beside Builds in the sidebar. Rejecting asks for a reason in a dialog, inputs match the button height, and there is less explanatory text.

- [#211](https://github.com/handlemotion/dorks/pull/211) [`1944509`](https://github.com/handlemotion/dorks/commit/194450965959584b1fd735ce051f3bd016269a2a) Thanks [@handlemotion](https://github.com/handlemotion)! - Repository pickers (new session, a build's Add repository, automations) have a refresh button that reads GitHub again, so a repository you just created shows up. Every session's agent, not only setup sessions, now proposes a fix to its machine's build when it hits a setup problem, guided by a machine-setup skill its tools server ships over MCP 2026-07-28.

- [#206](https://github.com/handlemotion/dorks/pull/206) [`eabd1c9`](https://github.com/handlemotion/dorks/commit/eabd1c95b94cd3722b7ba78035a26f4ce8d5df0a) Thanks [@handlemotion](https://github.com/handlemotion)! - Plugins, Automations and Builds share one layout: search and buttons at the top of a wider column instead of a header bar, and the Plugins sidebar now matches the main sidebar's width. The All / Installed filter and the plugin count are gone. The composer's corners are a little squarer, and its send arrow is longer and centered.

- [#208](https://github.com/handlemotion/dorks/pull/208) [`36ae60b`](https://github.com/handlemotion/dorks/commit/36ae60ba63f311d8b789f5318c6fe0f8d41c89b2) Thanks [@handlemotion](https://github.com/handlemotion)! - Mark a draft pull request ready for review from its tab in Chat details.

- [#202](https://github.com/handlemotion/dorks/pull/202) [`3061a70`](https://github.com/handlemotion/dorks/commit/3061a70202a35fc06feb09423ccda91e26083664) Thanks [@handlemotion](https://github.com/handlemotion)! - The merge button of a branching stack counts only the PRs that merge with the shown one, and a stacked PR already in a merge queue is reported as queued, not merged.

## 0.7.0

### Minor Changes

- [#193](https://github.com/handlemotion/dorks/pull/193) [`f37ec10`](https://github.com/handlemotion/dorks/commit/f37ec103f79c1dbede6fa6218aaea19660d6f78d) Thanks [@handlemotion](https://github.com/handlemotion)! - Builds can list their dev servers and services: the build checks and warms each one, and agents start them on demand to test changes against the running app. Agents are now sent back once when they finish a code change without testing it against running software.

- [#195](https://github.com/handlemotion/dorks/pull/195) [`9ed9c85`](https://github.com/handlemotion/dorks/commit/9ed9c85490a78444650fb0d520f4736fa9cfb9cc) Thanks [@handlemotion](https://github.com/handlemotion)! - Sessions now have a mode: Chat for everyday conversation, writing and help with your computer (no repository needed), Code for repository work as before, and Nerd for running other sessions toward a goal. Pick it from the composer, and switch it any time.

- [#191](https://github.com/handlemotion/dorks/pull/191) [`cee8046`](https://github.com/handlemotion/dorks/commit/cee804655ee8399ffbd6e9ed9acaf88a5b05ddeb) Thanks [@handlemotion](https://github.com/handlemotion)! - Type `/` in the message box to pick one of the agent's skills or commands, or `@` to mention a file from the repository.

- [#187](https://github.com/handlemotion/dorks/pull/187) [`90b5868`](https://github.com/handlemotion/dorks/commit/90b5868aa55fdc0e111491fc880243d034b2e4e7) Thanks [@handlemotion](https://github.com/handlemotion)! - New sessions have one chooser for where they run: pick a build (shown with its repositories' owners) or a repository on the base machine, and a repository in a build always starts on that build. Builds add repositories from the same searchable list instead of a typed name.

- [#189](https://github.com/handlemotion/dorks/pull/189) [`c0c3e98`](https://github.com/handlemotion/dorks/commit/c0c3e981ed993052d0e44abb921137ff1cd55dce) Thanks [@handlemotion](https://github.com/handlemotion)! - Redesign Customize into Plugins with a secondary navigation column for Plugins, Skills, and installed items, plus a searchable grouped table view.

- [#194](https://github.com/handlemotion/dorks/pull/194) [`2a7a4ac`](https://github.com/handlemotion/dorks/commit/2a7a4ac8098faa54196c5178b697ed6dc99ccfd3) Thanks [@handlemotion](https://github.com/handlemotion)! - Agents can ask you for a login, a one-time code or another secret in a form in the chat; Claude uses what you type without ever seeing it.

- [#190](https://github.com/handlemotion/dorks/pull/190) [`7a52921`](https://github.com/handlemotion/dorks/commit/7a5292174e58454b4e3deb4dcfae5fffd3615861) Thanks [@handlemotion](https://github.com/handlemotion)! - With the sidebar collapsed, hovering its toggle slides the sidebar in above the page so you can jump to another page without opening it.

### Patch Changes

- [#198](https://github.com/handlemotion/dorks/pull/198) [`0950982`](https://github.com/handlemotion/dorks/commit/09509823a1286f8d353eca7630a9d34bc00e461b) Thanks [@handlemotion](https://github.com/handlemotion)! - With Antigravity (and other agents that cannot take a message mid-turn), messages you send while the agent works now reach it together in its next turn, instead of one turn each that answered them late and had to be stopped one by one.

- [#188](https://github.com/handlemotion/dorks/pull/188) [`035236d`](https://github.com/handlemotion/dorks/commit/035236d1559c8ddec297df9c3043d14a6a5763c9) Thanks [@handlemotion](https://github.com/handlemotion)! - The dork icon is blue only while the agent is working; an awake dork waiting for your next message is now yellow, like one asking for permission.

- [#196](https://github.com/handlemotion/dorks/pull/196) [`d170608`](https://github.com/handlemotion/dorks/commit/d17060831cf3181e5ac94fca008b7427604efd94) Thanks [@handlemotion](https://github.com/handlemotion)! - Preview comments and PR notifications no longer land in the middle of a turn the agent started on its own (after a background task finished), where it could overlook them; they now arrive as their own turn once it ends. The session also shows as working during those turns instead of idle.

- [#185](https://github.com/handlemotion/dorks/pull/185) [`8a1499c`](https://github.com/handlemotion/dorks/commit/8a1499c413243a2c2a1cb7a67d51b68a2da024e3) Thanks [@handlemotion](https://github.com/handlemotion)! - Large images in the chat and in attachments now open fitted to the image viewer instead of at their full pixel size.

- [#197](https://github.com/handlemotion/dorks/pull/197) [`66587d0`](https://github.com/handlemotion/dorks/commit/66587d0edfc8ce68f4f89c9cac100dc96566c821) Thanks [@handlemotion](https://github.com/handlemotion)! - Updating Dorks no longer leaves a second Dorks icon in the Dock: the new version opens once the old one has quit.

- [#192](https://github.com/handlemotion/dorks/pull/192) [`61e354d`](https://github.com/handlemotion/dorks/commit/61e354dadd8c968f7409a3ef964f4c0177257217) Thanks [@handlemotion](https://github.com/handlemotion)! - Your messages keep their line breaks (Shift Enter) in the chat instead of running together into one paragraph.

- [#194](https://github.com/handlemotion/dorks/pull/194) [`2a7a4ac`](https://github.com/handlemotion/dorks/commit/2a7a4ac8098faa54196c5178b697ed6dc99ccfd3) Thanks [@handlemotion](https://github.com/handlemotion)! - Chat details start wider and the chat narrower (600px), so pull requests and previews get more room.

## 0.6.0

### Minor Changes

- [#175](https://github.com/handlemotion/dorks/pull/175) [`1c075f2`](https://github.com/handlemotion/dorks/commit/1c075f24ba7c09e3a9305090f7a0d8da0b110e67) Thanks [@handlemotion](https://github.com/handlemotion)! - Added a compact left-edge table of contents in chat threads for user messages. Hovering a row previews the message, and clicking a row jumps straight to it.

- [#184](https://github.com/handlemotion/dorks/pull/184) [`ad174b7`](https://github.com/handlemotion/dorks/commit/ad174b783ea04dac9b9feb642739cbde2d38f952) Thanks [@handlemotion](https://github.com/handlemotion)! - Mermaid code blocks in messages now render as diagrams, in the same rounded island as code blocks. A diagram that fails to parse still shows as code.

- [#180](https://github.com/handlemotion/dorks/pull/180) [`93f8971`](https://github.com/handlemotion/dorks/commit/93f89712b85304a135692a382d6ccf3e83d6ab56) Thanks [@handlemotion](https://github.com/handlemotion)! - Comment on a running preview: pick an element or select text, and the agent hears about it, answers in the thread and resolves it, with bubbles and highlights right on the page. The preview shows at desktop, tablet or phone size, with rulers, and can capture an area into your message.

- [#174](https://github.com/handlemotion/dorks/pull/174) [`c8b215f`](https://github.com/handlemotion/dorks/commit/c8b215f36ba2651b045e4dd0f4e04dfa066ba77f) Thanks [@handlemotion](https://github.com/handlemotion)! - Pick an element in any running preview, not only local ones: hover and click in the preview to send the agent the element, its component and its source file. Previews also load without dev server host settings such as Vite's allowedHosts.

### Patch Changes

- [#179](https://github.com/handlemotion/dorks/pull/179) [`3d8df9a`](https://github.com/handlemotion/dorks/commit/3d8df9a0ad0a11d72014960e9bb0da9becbfef43) Thanks [@handlemotion](https://github.com/handlemotion)! - External links in the macOS desktop app now open in your default browser on a single click instead of requiring Cmd+click or middle-click.

- [#168](https://github.com/handlemotion/dorks/pull/168) [`88b5582`](https://github.com/handlemotion/dorks/commit/88b5582532a94468cdb34b40a68cdab9e84fa253) Thanks [@handlemotion](https://github.com/handlemotion)! - With a crew worker open beside the chat, an image dropped into the window now attaches only to the composer you dropped it on, not to both.

- [#173](https://github.com/handlemotion/dorks/pull/173) [`0f1c3b0`](https://github.com/handlemotion/dorks/commit/0f1c3b0b79278b54b4029d684a794769c9eadce1) Thanks [@handlemotion](https://github.com/handlemotion)! - The sidebar no longer shows the coordinator group (now called Nerds) while the feature is unfinished.

- [#178](https://github.com/handlemotion/dorks/pull/178) [`e08e23d`](https://github.com/handlemotion/dorks/commit/e08e23d7e245c31593bd346a61cc56767588ec52) Thanks [@handlemotion](https://github.com/handlemotion)! - Improved screenshot quality across the agent harness: `screenshot_share` now requires `url` or `path` (no silent 1x desktop fallback), flags JPEG or low-resolution captures, reminds agents to use `deviceScaleFactor: 2` PNGs, and inline chat screenshots serve higher-resolution (`1920px`, quality 92) WebP copies.

- [#182](https://github.com/handlemotion/dorks/pull/182) [`7c80952`](https://github.com/handlemotion/dorks/commit/7c809528f417041ff55bb29fa4c5b55cc61df24a) Thanks [@handlemotion](https://github.com/handlemotion)! - A dork that switched to another branch stays on it when its model, secrets or MCP servers change or its sandbox restarts, instead of being put back on its starting branch.

- [#172](https://github.com/handlemotion/dorks/pull/172) [`b7c81fc`](https://github.com/handlemotion/dorks/commit/b7c81fce487da5fc2dd05359e0a57575e5efe8e7) Thanks [@handlemotion](https://github.com/handlemotion)! - A scheduled automation run that starts late now names the day it was due when that was not today, so a run missed yesterday no longer reads as due later than it started.

- [#171](https://github.com/handlemotion/dorks/pull/171) [`e0936d4`](https://github.com/handlemotion/dorks/commit/e0936d444f4282d9e42f7e6b0b7aa3349b1fa913) Thanks [@handlemotion](https://github.com/handlemotion)! - While an automation has a schedule, Dorks opens at login so scheduled runs fire on time after a restart, and macOS no longer naps the app while it keeps the Mac awake.

- [#181](https://github.com/handlemotion/dorks/pull/181) [`3f091d7`](https://github.com/handlemotion/dorks/commit/3f091d73f254a1c155c1d824b22fb37c36066cb4) Thanks [@handlemotion](https://github.com/handlemotion)! - Every pull request the agent opens or subscribes to now gets its own tab in Chat details, including ones added while the panel was closed or another chat was open.

- [#169](https://github.com/handlemotion/dorks/pull/169) [`45f098b`](https://github.com/handlemotion/dorks/commit/45f098b799946826c29d2284fc13d1e02d163151) Thanks [@handlemotion](https://github.com/handlemotion)! - A scheduled automation run that starts late because Dorks was closed or asleep now says when it was due, and a scheduled run that could not start shows in the history as failed instead of disappearing.

- [#177](https://github.com/handlemotion/dorks/pull/177) [`ce26b5c`](https://github.com/handlemotion/dorks/commit/ce26b5cae8fc90d6bb598c73726fb5df2c116566) Thanks [@handlemotion](https://github.com/handlemotion)! - Stop gate now detects commits pushed to a branch whose pull request was already merged or closed, notifying the agent so it opens a new pull request instead of silently dropping the change.

- [#183](https://github.com/handlemotion/dorks/pull/183) [`5cca79e`](https://github.com/handlemotion/dorks/commit/5cca79e25c03c0267962925889c3a593964c2bf9) Thanks [@handlemotion](https://github.com/handlemotion)! - Reduce layout work in the chat transcript when the message composer changes height.

## 0.5.2

### Patch Changes

- [#166](https://github.com/handlemotion/dorks/pull/166) [`406d0e5`](https://github.com/handlemotion/dorks/commit/406d0e585d07f7796916fb465d7f730d3168a37d) Thanks [@handlemotion](https://github.com/handlemotion)! - Fix the desktop app failing to open with "Something went wrong" after the last update.

## 0.5.1

### Patch Changes

- [#163](https://github.com/handlemotion/dorks/pull/163) [`c95f3bd`](https://github.com/handlemotion/dorks/commit/c95f3bdd462f1eced6aff71a7408d2445b009e43) Thanks [@handlemotion](https://github.com/handlemotion)! - With an image attached, the composer's text stays level with the attach button. Queued messages now sit as rows in a frame joined to the top of the composer, like a code block, instead of reply-style cards. Tool summary lines and the agent status line can no longer be selected, so copying from a chat picks up only the messages. The usage menu has a single hairline border, and its links open Claude's and Boat's usage pages on the web. The sidebar's first row sits a little lower, at the same height in the app and in Settings.

- [#165](https://github.com/handlemotion/dorks/pull/165) [`22d22bd`](https://github.com/handlemotion/dorks/commit/22d22bdb9067650bad8f59359bf5c70e1159f6c9) Thanks [@handlemotion](https://github.com/handlemotion)! - Diffs in the agent's messages (`diff` code blocks) are drawn like the diffs in a pull request, with added and removed lines filled in instead of coloured text. In Progress, click a message to fold away the steps under it.

- [#161](https://github.com/handlemotion/dorks/pull/161) [`3249ec1`](https://github.com/handlemotion/dorks/commit/3249ec12f343a45bdd406a2d8d95666c3f9aa48a) Thanks [@handlemotion](https://github.com/handlemotion)! - Long chats stay smooth while the agent streams, and scrolling up loads older messages on its own, in bigger pages. Screenshots in Artifacts, the image viewer and the chat load as small thumbnails, so the grid scrolls and the viewer opens and swipes without stutter.

- [#165](https://github.com/handlemotion/dorks/pull/165) [`22d22bd`](https://github.com/handlemotion/dorks/commit/22d22bdb9067650bad8f59359bf5c70e1159f6c9) Thanks [@handlemotion](https://github.com/handlemotion)! - Agent messages now stream through Words, Pierre's faster markdown renderer. They look the same as before, and code blocks keep their state while a message streams in.

## 0.5.0

### Minor Changes

- [#157](https://github.com/handlemotion/dorks/pull/157) [`07214ca`](https://github.com/handlemotion/dorks/commit/07214ca71e591aa01268574bf1875ca0e8fa33ee) Thanks [@handlemotion](https://github.com/handlemotion)! - While the agent works, Enter steers its current turn and ⌘ Enter (Ctrl Enter) queues the message for when the turn ends. Queued messages show above the message box, where you can send one now or remove it.

- [#160](https://github.com/handlemotion/dorks/pull/160) [`ce80564`](https://github.com/handlemotion/dorks/commit/ce80564a39b1a4e8223835850ac8c732f9452343) Thanks [@handlemotion](https://github.com/handlemotion)! - Usage moves from the sidebar to a ring beside the model picker: click it for the chat's own model limits and your Boat plan's machine time, starts, running sandboxes and wallet. A running chat's repository shows its owner's avatar.

### Patch Changes

- [#158](https://github.com/handlemotion/dorks/pull/158) [`33e3087`](https://github.com/handlemotion/dorks/commit/33e3087cb3fcf4dd423b62550c10a3c8392b1eea) Thanks [@handlemotion](https://github.com/handlemotion)! - Add a bottom divider to the page header and align the Chat details and Dork details tab bars to the same 48px height so both top dividers meet seamlessly.

- [#152](https://github.com/handlemotion/dorks/pull/152) [`cee4fb2`](https://github.com/handlemotion/dorks/commit/cee4fb24ee98bcb14f7b9a2ca07c2c7389aafc7b) Thanks [@handlemotion](https://github.com/handlemotion)! - Starting a sandbox now rides out a short network drop instead of failing, and when it does fail the session says why in one red line (for example, that Boat couldn't be reached) instead of "create_box failed".

- [#154](https://github.com/handlemotion/dorks/pull/154) [`fa811ea`](https://github.com/handlemotion/dorks/commit/fa811ea0be78b5294c7f5ccd44a9331b52abc5b5) Thanks [@handlemotion](https://github.com/handlemotion)! - Drag images from Finder anywhere into a chat to attach them, click an attached image to open it full size, and attached images now stay in a chat's draft when you switch to another chat and back.

- [#156](https://github.com/handlemotion/dorks/pull/156) [`f399b37`](https://github.com/handlemotion/dorks/commit/f399b371721a2fe70f973b1c0f59d4614b5579aa) Thanks [@handlemotion](https://github.com/handlemotion)! - An image in a chat that cannot be shown (an unknown or deleted screenshot, a local file path) now shows its caption as "image not available" instead of the raw "[Image blocked: …]" text.

- [#153](https://github.com/handlemotion/dorks/pull/153) [`8a3079c`](https://github.com/handlemotion/dorks/commit/8a3079c4e91b53b81120dcf044444542ecb12e7b) Thanks [@handlemotion](https://github.com/handlemotion)! - Use a white background for the main app frame in light mode, tighten the gap between the top window controls and the organization switcher in the sidebar, redesign markdown code blocks with a card-on-card Pierre layout, add a subtle border around images in the lightbox viewer, hide scrollbars across all tabs in the right details sidebar, and darken the cancel button fill beside Confirm merge.

- [#159](https://github.com/handlemotion/dorks/pull/159) [`9cd8b31`](https://github.com/handlemotion/dorks/commit/9cd8b319049d7a7cda8479535d7c8b0397454dc0) Thanks [@handlemotion](https://github.com/handlemotion)! - The sidebar opens wider by default, and Chat details beside a chat starts narrower.

## 0.4.3

### Patch Changes

- [#151](https://github.com/handlemotion/dorks/pull/151) [`ce4b87f`](https://github.com/handlemotion/dorks/commit/ce4b87f09bacfd272cac03cb8c84474f3831d281) Thanks [@handlemotion](https://github.com/handlemotion)! - Update the app icon, menu-bar tray icon, and web favicon to the new Dork mark (white on solid electric blue for the app icon and favicon, monochrome template mark for the menu bar).

- [#149](https://github.com/handlemotion/dorks/pull/149) [`913a200`](https://github.com/handlemotion/dorks/commit/913a200447439eb7bba2d391356842045a6d0cab) Thanks [@handlemotion](https://github.com/handlemotion)! - The sidebar's usage meters now stay current: they refresh every 30 seconds while the app is open and whenever you switch back to it, instead of only on a full reload.

## 0.4.2

### Patch Changes

- [#146](https://github.com/handlemotion/dorks/pull/146) [`37e9ae1`](https://github.com/handlemotion/dorks/commit/37e9ae14d86775e96d45b6aeab9efff9b825359f) Thanks [@handlemotion](https://github.com/handlemotion)! - Antigravity sessions keep taking messages after you stop a turn that takes a few seconds to wind down.

- [#144](https://github.com/handlemotion/dorks/pull/144) [`aa21b28`](https://github.com/handlemotion/dorks/commit/aa21b284897dd23af66fddea71cde13a08d07376) Thanks [@handlemotion](https://github.com/handlemotion)! - Scheduled automations now start on time: the app keeps your Mac from idle-sleeping while an automation has a schedule. A new session's sandbox also gets up to 10 minutes to start instead of failing at 3.

- [#147](https://github.com/handlemotion/dorks/pull/147) [`ad6fdb0`](https://github.com/handlemotion/dorks/commit/ad6fdb0259e554b0f350c8af82b6a36373992e78) Thanks [@handlemotion](https://github.com/handlemotion)! - Long messages in the composer now wrap beside the + and send buttons instead of jumping above them.

- [#142](https://github.com/handlemotion/dorks/pull/142) [`4b336b5`](https://github.com/handlemotion/dorks/commit/4b336b546f5c0e380fe61b170e10e7d491b142e5) Thanks [@handlemotion](https://github.com/handlemotion)! - The Computer tab and running previews now load inside the desktop app instead of opening in your external browser.

- [#148](https://github.com/handlemotion/dorks/pull/148) [`b78680b`](https://github.com/handlemotion/dorks/commit/b78680b358f68625c849931bd59d359af7396721) Thanks [@handlemotion](https://github.com/handlemotion)! - Replace the status dot and sidebar orb with the new dork icon: animated cyan-to-violet while working, animated yellow-to-amber when waiting on you (such as computer-access prompts or build approvals), still and coloured when awake, and muted grey when asleep.

- [#140](https://github.com/handlemotion/dorks/pull/140) [`f221e61`](https://github.com/handlemotion/dorks/commit/f221e6184befe042e1709a003afb6424bbd8001c) Thanks [@handlemotion](https://github.com/handlemotion)! - The app checks for updates every 15 minutes instead of every 4 hours, so a new release shows up in the sidebar soon after it is published.

- [#143](https://github.com/handlemotion/dorks/pull/143) [`a70a44d`](https://github.com/handlemotion/dorks/commit/a70a44d2b99764c3f2089f9f97f7e4db1416bb96) Thanks [@handlemotion](https://github.com/handlemotion)! - Gemini (Antigravity) tool calls no longer show up as blank "Used" rows: each step now shows the command, file or search it ran.

- [#145](https://github.com/handlemotion/dorks/pull/145) [`5c47dc6`](https://github.com/handlemotion/dorks/commit/5c47dc65454a77274471a4cf258742ed3290e1b2) Thanks [@handlemotion](https://github.com/handlemotion)! - PR events in a chat now read as short lines with their own icons ("Got a comment from octocat on [#12](https://github.com/handlemotion/dorks/issues/12)", "Opened PR [#12](https://github.com/handlemotion/dorks/issues/12)"), and Progress groups the agent's work under the PR event it answered instead of under your last message.

## 0.4.1

### Patch Changes

- [#138](https://github.com/handlemotion/dorks/pull/138) [`01bf9c5`](https://github.com/handlemotion/dorks/commit/01bf9c5f15ab014387610a3f620cdf1848a20d2e) Thanks [@handlemotion](https://github.com/handlemotion)! - New Antigravity sessions can pick their model (Gemini 4 Neon, Argon, Hydrogen, Gemini 3.8 Flash and the rest your Google AI plan offers) before they start.
  Antigravity sessions on a build made before Antigravity existed now install the Antigravity CLI in their sandbox instead of failing with "agent exited", and an agent that exits says why in the thread.

- [#136](https://github.com/handlemotion/dorks/pull/136) [`7cc1933`](https://github.com/handlemotion/dorks/commit/7cc19335690990e5907bdcbe85be4f4eabfc3cbd) Thanks [@handlemotion](https://github.com/handlemotion)! - The usage panel shows your Google AI plan's Gemini session and weekly limits when Antigravity is signed in, and the window's traffic lights line up with the sidebar's header icons.

- [#139](https://github.com/handlemotion/dorks/pull/139) [`d775214`](https://github.com/handlemotion/dorks/commit/d77521476de7434e36d97a1a385b19ca706c2cd4) Thanks [@handlemotion](https://github.com/handlemotion)! - Updating the app no longer rebuilds your Boat base snapshot unless the tools it installs changed; sandboxes pick up the new bridge when they start.

## 0.4.0

### Minor Changes

- [#134](https://github.com/handlemotion/dorks/pull/134) [`3ca7f8f`](https://github.com/handlemotion/dorks/commit/3ca7f8f767e40164f8060339bb48a72c8f18e36e) Thanks [@handlemotion](https://github.com/handlemotion)! - Antigravity (Google's `agy` CLI, with the Gemini models your Google AI plan includes) is now an agent next to Claude Code, Codex and OpenCode, with the same PR hooks, done gate, autonomy, MCP tools, skills and model choice. Connect it with one "Sign in with Google" button in setup, onboarding or Settings; a Gemini API key (`GEMINI_API_KEY` shared secret) also works.

- [#132](https://github.com/handlemotion/dorks/pull/132) [`441a919`](https://github.com/handlemotion/dorks/commit/441a919a5fd2f1e2330650b45e2b61997fdd31f8) Thanks [@handlemotion](https://github.com/handlemotion)! - OpenCode is now a third agent next to Claude Code and Codex: pick any of its providers' models (OpenCode Zen, DeepSeek and the rest) and it gets the same PR hooks, done gate and autonomy. Save the provider's key (such as `OPENCODE_API_KEY` or `DEEPSEEK_API_KEY`) as a shared secret.

## 0.3.1

### Patch Changes

- [#130](https://github.com/handlemotion/dorks/pull/130) [`90f63bf`](https://github.com/handlemotion/dorks/commit/90f63bf7d1a0a97b3e5afc8279791838f33e94d4) Thanks [@handlemotion](https://github.com/handlemotion)! - Dorks made before updating to 0.3.0 wake again instead of timing out waiting for the sandbox: the app now updates a sandbox's bridge to its own version before starting it.

## 0.3.0

### Minor Changes

- [#126](https://github.com/handlemotion/dorks/pull/126) [`5d77a6f`](https://github.com/handlemotion/dorks/commit/5d77a6f2766246113059188fa073a59aa097aa8f) Thanks [@handlemotion](https://github.com/handlemotion)! - Setup happens in the checklist under the message box: Boat connects by itself with your Boat login (one browser sign-in if you are signed out, no API key to paste), and GitHub connects by itself with the GitHub CLI's login.
  Links in messages are blue and open in your default browser with one click, with no confirmation dialog.

- [#128](https://github.com/handlemotion/dorks/pull/128) [`1a0e0cc`](https://github.com/handlemotion/dorks/commit/1a0e0cce0715f2e4008800d9b32e02a2f3425dda) Thanks [@handlemotion](https://github.com/handlemotion)! - Sandboxes no longer need a tunnel or public URL to reach your Mac: the app now connects out to each sandbox through Boat's own URL for it, so the "Let sandboxes reach this Mac" setup step is gone.

- [#127](https://github.com/handlemotion/dorks/pull/127) [`46aa841`](https://github.com/handlemotion/dorks/commit/46aa8413a2e1a299952a21912cf37f4bcc652f70) Thanks [@handlemotion](https://github.com/handlemotion)! - Agents ask once per session to access your computer (Allow for this session, Always allow or Deny) instead of for every command, and each command shows as one line with its output. Turn Always allow off again in Settings › Your computer.

- [#121](https://github.com/handlemotion/dorks/pull/121) [`09bb26a`](https://github.com/handlemotion/dorks/commit/09bb26a2fb2ff54ab3598852d9b8d303451e0151) Thanks [@handlemotion](https://github.com/handlemotion)! - Tool calls in a chat are one plain line, "Ran 2 commands ›", that opens Progress with those steps selected, and the status line under the chat names the step the agent is on and opens it in Progress. Chat details now open on a New tab instead of Progress.

### Patch Changes

- [#129](https://github.com/handlemotion/dorks/pull/129) [`dc68c36`](https://github.com/handlemotion/dorks/commit/dc68c36d266047b76bd1260ca5c7845f9a375700) Thanks [@handlemotion](https://github.com/handlemotion)! - A malformed or oversized message on a sandbox connection now closes only that connection instead of stopping the agent.

- [#122](https://github.com/handlemotion/dorks/pull/122) [`26239d7`](https://github.com/handlemotion/dorks/commit/26239d76eb996b79c0cdf656186fff365f14d355) Thanks [@handlemotion](https://github.com/handlemotion)! - New Claude sessions run in Claude Code's Code Mode, which batches several tool calls into one step; turn it off for new sessions in Settings › Sessions.

- [#125](https://github.com/handlemotion/dorks/pull/125) [`52deac5`](https://github.com/handlemotion/dorks/commit/52deac513c237fd70a19580b6af8e211245a492a) Thanks [@handlemotion](https://github.com/handlemotion)! - The thread no longer fades out above the composer, stays at the latest message when you send one, a multi-line message sits closer to the composer's buttons, and every pull request a dork opens or subscribes to opens in its own tab in Chat details. Dorks hear about CI failures, reviews and conflicts within about 15 seconds instead of over a minute, and finish their changes as pull requests instead of stopping with uncommitted work.

- [#123](https://github.com/handlemotion/dorks/pull/123) [`75ccb33`](https://github.com/handlemotion/dorks/commit/75ccb33316d39d365a7323cd4f37bb7bdb004396) Thanks [@handlemotion](https://github.com/handlemotion)! - The Computer tab and running previews show again in the desktop app: they were stuck on Connecting because the app blocked their frames.

## 0.2.0

### Minor Changes

- [#116](https://github.com/handlemotion/dorks/pull/116) [`b1822d1`](https://github.com/handlemotion/dorks/commit/b1822d1637c4c0a93ceec67abbdbf1552ad92ea9) Thanks [@handlemotion](https://github.com/handlemotion)! - Automations: agents that run on a schedule, or when a pull request is opened, pushed or merged, an issue is opened or someone comments in a repository. Start from a template, try one with Run now, and see every run and the session it started in its history.

- [#119](https://github.com/handlemotion/dorks/pull/119) [`b6a2be3`](https://github.com/handlemotion/dorks/commit/b6a2be383a09e51c4ed470937647bb74c8c39c34) Thanks [@handlemotion](https://github.com/handlemotion)! - The chat thread now shows every message the agent writes, with its tool calls in between, instead of only its first and last message. The agent's thinking stays hidden.

### Patch Changes

- [#115](https://github.com/handlemotion/dorks/pull/115) [`0d26bf6`](https://github.com/handlemotion/dorks/commit/0d26bf678473d7192dde4b8db894e0089fac3424) Thanks [@handlemotion](https://github.com/handlemotion)! - Tables in chat messages show as a plain table instead of a table inside a card.

- [#120](https://github.com/handlemotion/dorks/pull/120) [`8524faa`](https://github.com/handlemotion/dorks/commit/8524faaa2102aee4801b74d1506acd2eb76ffdad) Thanks [@handlemotion](https://github.com/handlemotion)! - New session puts the cursor in the message box. The Artifacts panel scrolls when it has more than fits, and its grid sits evenly under the tabs.

- [#118](https://github.com/handlemotion/dorks/pull/118) [`832c58a`](https://github.com/handlemotion/dorks/commit/832c58af390fb5fec4ca6895be4e0c3232741796) Thanks [@handlemotion](https://github.com/handlemotion)! - The pull request panel shows its repository above the title and who, which branches and how big on one line under it, instead of a block of properties.

- [#117](https://github.com/handlemotion/dorks/pull/117) [`78f68b1`](https://github.com/handlemotion/dorks/commit/78f68b1e71ae1bd94835d2c09a45ba46a33ae47e) Thanks [@handlemotion](https://github.com/handlemotion)! - New sessions show a "Set up Dorks" checklist under the message box instead of a large progress bar. Updating Boat after an app update shows in its row, and sessions keep starting meanwhile.

## 0.1.0

### Minor Changes

- [#105](https://github.com/handlemotion/dorks/pull/105) [`2334ff5`](https://github.com/handlemotion/dorks/commit/2334ff5d9ed447033e64d61d59f3767343b477d4) Thanks [@handlemotion](https://github.com/handlemotion)! - Dorks 0.1.0, the first release for Macs with Apple silicon (M1 and later). Dorks now updates itself: when a new version is out, a blue bar in the sidebar offers it, and Update installs it and restarts the app. Since 0.0.1: crews of dorks that a coordinator runs, many pull requests per chat with stacked PRs and a merge button, named builds for each repository, skills and MCP connectors in Customize, agents that can ask to use your computer, screenshots and images in the chat, and a reworked sidebar, chat details and settings.
