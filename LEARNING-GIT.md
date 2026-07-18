# Learning Git & GitHub — a Dominus-flavored guide

A personal reference for understanding the git commands used on this project, and
where to look on GitHub. Everything here is grounded in things we actually did while
building Dominus, so the commands should map to real memories.

---

## 1. The mental model

Git has **four places** your code lives. Almost every command just moves work between them:

```
Working directory  →  Staging area  →  Local repo  →  Remote (GitHub)
   (your edits)         (git add)       (git commit)     (git push)
```

If you remember this one diagram, most commands stop feeling random.
`git status` shows where things are in this pipeline — run it often; it even suggests
the next command to run.

---

## 2. Commands used on Dominus (personalized cheat sheet)

### Seeing state
| Command | What it does |
|---|---|
| `git status` | Which files are modified / staged / untracked |
| `git status --short` | Compact view — `M`=modified, `A`=added, `??`=untracked |
| `git log --oneline` | History, one line per commit |
| `git branch --show-current` | Which branch am I on? |

### The core save-and-share loop
| Command | What it does |
|---|---|
| `git add -A` | Stage all changes (`-A` = everything; or `git add <file>`) |
| `git commit -m "message"` | Snapshot the staged changes with a message |
| `git push origin main` | Upload commits to GitHub |
| `git pull origin main` | Download + merge remote changes (e.g. after a PR merges) |

### Branching (isolating work)
| Command | What it does |
|---|---|
| `git checkout -b features/dominus-1.4` | Create **and** switch to a new branch |
| `git checkout main` | Switch back to main |
| `git merge --ff-only origin/main` | Fast-forward a branch up to main |
| `git push -u origin <branch>` | Push a new branch **and** link it (`-u`) so later pushes need no arguments |

### Tags / releases
| Command | What it does |
|---|---|
| `git tag -a v1.4 -m "message"` | Create a permanent, annotated bookmark at a commit |
| `git push origin v1.4` | Push that tag (tags do **not** go up with a normal `git push`) |

### Inspection helpers
| Command | What it does |
|---|---|
| `git remote -v` | Show the GitHub URL this repo pushes to |
| `git fetch origin main` | Download remote changes **without** merging |
| `git check-ignore <file>` | Confirm a file is being ignored by `.gitignore` |

---

## 3. Worth learning next (not used yet, but you will)

- `git diff` — see exactly what changed, line by line, **before** committing.
- `git restore <file>` — discard changes to a file you messed up.
- `git restore --staged <file>` — unstage something you `git add`ed by mistake.
- `git commit --amend` — fix the **last** commit's message or add a forgotten file (only before pushing).
- `git stash` … `git stash pop` — temporarily shelve changes to switch branches, then bring them back.
- `git log --graph --oneline --all` — a visual tree of branches and merges.
- `.gitignore` patterns — `*.zip`, `folder/`, `!keep-this` (we used this for `.docx` and `.zip`).

---

## 4. GitHub sections to explore

Click around your own repo — that's the fastest way to learn:
`https://github.com/justinnyakundi232-art/Dominus`

- **Code tab** — file browser; the **branch dropdown** and **Tags** (you'll see `v1.4`).
- **Commits** — the history, matching `git log`.
- **Pull Requests** — the PRs we merged; open one and read **Files changed** and **Conversation**.
- **Releases** (right sidebar of Code) — where a Release appears once cut from a tag.
- **Insights → Network** — a visual graph of all branches and merges over time.
- **Settings → Branches** — branch protection and rules.
- **Issues** — task tracking (core to real projects, even solo).

---

## 5. Concepts to nail down

1. **Branch vs. tag** — a branch moves as you commit; a tag is frozen forever.
2. **Local vs. remote** — `main` (your machine) and `origin/main` (GitHub) are *separate*; `push` / `pull` / `fetch` sync them.
3. **The PR lifecycle** — branch → commit → push → open PR → review → merge → pull.
4. **Fast-forward vs. merge commit** — why some merges add a "Merge pull request #N" commit and some don't.
5. **`origin` and `HEAD`** — `origin` is the default name for your GitHub remote; `HEAD` means "where I am right now."

---

## 6. Free resources

- **[Pro Git book](https://git-scm.com/book/en/v2)** — free & official. Chapters 2 (Basics), 3 (Branching), 6 (GitHub) map to what we did.
- **[Learn Git Branching](https://learngitbranching.js.org/)** — interactive visual game; best way to *feel* branches & merges.
- **[GitHub Docs — Get started](https://docs.github.com/en/get-started)** — short articles for the GitHub-specific side.
- **[Oh Shit, Git!?!](https://ohshitgit.com/)** — plain-language fixes for when you get stuck.

---

## 7. The Dominus release workflow (what we did, start to finish)

A concrete end-to-end example you can reuse for version 1.5:

```bash
# 1. Start a feature branch off an up-to-date main
git checkout main
git pull origin main
git checkout -b features/dominus-1.5

# 2. Make changes, then stage & commit
git add -A
git commit -m "Describe what changed"

# 3. Publish the branch and open a Pull Request on GitHub
git push -u origin features/dominus-1.5
#    → open the PR link GitHub prints, review, then Merge on the website

# 4. Bring the merge back to your local main
git checkout main
git pull origin main

# 5. Bump the version, update the changelog, commit
#    (edit manifest.json "version" and CHANGELOG.md)
git add manifest.json CHANGELOG.md
git commit -m "Bump extension version to 1.5"
git push origin main

# 6. Tag the release
git tag -a v1.5 -m "Dominus 1.5 — summary"
git push origin v1.5

# 7. Package the zip and upload to the Chrome Web Store
#    (manifest.json must be at the root of the zip)
```
