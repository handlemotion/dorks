# @dorks/desktop

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
