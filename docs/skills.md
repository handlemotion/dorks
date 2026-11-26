# Skills (Customize)

[Agent Skills](https://agentskills.io) are folders with a `SKILL.md` (YAML frontmatter `name` and `description`, then instructions)
and any scripts, references and assets beside it. Claude Code loads them from `~/.claude/skills` and reloads that folder by itself.

Most harnesses only install skills from their own marketplace or by uploading a folder by hand, and a cloud session's skills vanish
with its sandbox. Skills are actually shared as commands (`npx skills add owner/repo --skill name`) and GitHub links. So in Dorks the
owner pastes that command or link **once** in **Customize, Skills**; the server keeps the files, and every sandbox, now and later,
gets them.

## Installing

The field takes what READMEs and skills.sh hand out (`apps/server/src/lib/skillSource.ts`):

| Pasted | Means |
|---|---|
| `npx skills add owner/repo` (also `bunx`, `pnpm dlx`, `npx -y skills@1.9 add`, `npx add-skill`, `npx openskills install`) | every skill in the repo; the dialog lets the owner choose |
| `… --skill a b`, `-s a`, `owner/repo@a` | those skills, preselected |
| `… --all`, `--skill '*'` | all of them, preselected |
| `owner/repo/sub/path`, `owner/repo#ref` | a folder, a branch or tag |
| `https://github.com/owner/repo[/tree/<ref>/<path>]`, a `/blob/…/SKILL.md` link, `git@github.com:owner/repo.git`, `git clone <url>`, `/plugin marketplace add owner/repo` | the same |

Flags that only matter to the CLI (`-g`, `-y`, `-a claude-code`, `--copy`) are ignored. GitHub only for now: GitLab, well-known URLs and
local folders are refused with a plain reason (skills already on this computer are added from [their own list](#from-this-computer)).

1. `POST /api/skills/resolve` resolves the ref to a commit (`GET /repos/{repo}/commits/{ref|HEAD}`; a `/tree/` URL tries the shortest ref
   first, since a branch may contain `/`), downloads the commit's tarball (64 MB cap) as the GitHub CLI's login when connected, so
   private repos work, and lists its skills. Discovery follows `npx skills add`: a `SKILL.md` right at the chosen folder is the one
   skill; otherwise every folder below with one (`node_modules` and `.git` skipped). A skill is its folder minus any skill folder nested
   in it. A `name` that breaks the Agent Skills rule (`^[a-z0-9]+(-[a-z0-9]+)*$`, at most 64) is made to fit; it is also the folder name.
2. The UI installs a lone skill straight away, else shows the list. `POST /api/skills` saves the chosen ones (`skills` table: the
   folder as gzipped JSON, its sha256 `digest`, the repo, ref, folder and commit). At most 200 skills, 1000 files and 8 MB each. The
   tarball is cached in memory for ten minutes, so Find then Install downloads it once.
3. **Update** downloads the skill again from the same repo and ref (a branch moves forward) and finds it by folder, else by name.

## From this computer

Skills people already use on their Mac live in `~/.agents/skills` (where `npx skills add -g` puts them, linking each into
`~/.claude/skills`) and `~/.claude/skills` (Claude Code's own). The server runs on that Mac, so it reads them from disk
(`apps/server/src/lib/localSkills.ts`):

- `GET /api/skills/local` lists every folder with a `SKILL.md` in those two, `~/.agents/skills` first. A folder linked from both
  counts once (by real path), and a name counts once. Symlinks are followed (each folder once), `node_modules`, `.git` and
  `.DS_Store` skipped, the same limits as GitHub apply. **Skills, Found on this computer** shows the ones not added yet.
- `POST /api/skills/local {skills}` adds them: the same `skills` row, with `local_dir` set to the folder (`repo` empty, `sha` the
  digest). A GitHub install of the same name replaces it, and the other way round.
- An added skill follows its folder: it is read again when `configure` is built (a session starts or wakes), when Skills is opened,
  and on **Update**. A change is saved under a new digest, so the bridge fetches it. Reads are at most every 5 s. A folder that is gone
  or now too large keeps the last copy; Update says so.
- Only the local owner may list or add them; a team's admins and members may not (`services/team.ts`).

## Reaching the sandboxes

- `configure` carries `skills: {name, digest}[]`, never the files.
- The bridge (`infra/bridge/src/skills.ts`) compares them with `<state dir>/skills.json` (what it wrote before), asks for changed ones
  with the `skill` rpc, writes each to a fresh folder beside `~/.claude/skills/<name>` (the run-as user's home, or
  `CLAUDE_CONFIG_DIR`), owned by that user, and swaps it in. Skills the owner removed are deleted. It runs before the agent starts, so
  the first turn has them.
- An install, update or removal re-sends `configure` to every awake Claude agent. Skills are not part of the agent's restart key:
  Claude Code reloads the folder, so the session keeps going.
- A path that would leave the skill folder is dropped; a script keeps its executable bit.

## Skills for one session

The agent is told (`SKILLS_GUIDANCE` in `infra/bridge/src/guidance.ts`) that the shared skills are managed by Dorks, and that when the
user asks for a skill in this session only it runs `npx -y skills add <source> -g -a claude-code -y` (never into the repo). That lasts
as long as the sandbox. The bridge only touches folders it wrote, so a session's own skill stays, and wins over a shared one of the same
name.

Codex sessions do not get skills yet.
