# @dorks/desktop

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
