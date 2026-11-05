---
name: repo-hygiene
description: Housekeeping after a release or when asked to "clean up", "remove stale branches", "check open issues/PRs". Use after every few betas: merged and stale branches, worktrees, superseded Dependabot PRs, issues whose work shipped, stray tags.
---

# Repo hygiene

Read-only first, then delete only what you have proven stale, **by explicit name**. Ask before closing issues or deleting
anything that is not provably merged.

## Once per repo
`gh repo edit --delete-branch-on-merge` so merged PR branches disappear by themselves (most of this skill is then only for
leftovers). Check: `gh repo view --json deleteBranchOnMerge`.

## Branches
1. `git fetch --prune origin && git branch -r --merged origin/main` (merged remote) and `git branch --merged origin/main`
   (merged local). Delete each by name: `git push origin --delete <name>` and `git branch -d <name>`. Never from an `xargs`
   list; classifiers reject it, and a typo deletes live work.
2. A branch `-d` refuses but that looks old: `git rev-list --left-right --count origin/main...<branch>` (how far behind) and
   `git cherry origin/main <branch>`. Every line starting with `-` means that commit is already in `main` as an
   equivalent patch (a squash or cherry-pick landed it): stale, safe for `git branch -D`. Any `+` line is unmerged work;
   keep it and ask.
3. `git worktree list`; remove agent worktrees that are done (`git worktree remove <path>`), then `git worktree prune`.

## Pull requests
Open Dependabot PRs that a bundle PR already applied: `gh pr close <n> --comment "Applied in #<bundle>"`. Anything else open
and old: ask.

## Issues
For each open issue whose feature shipped: **read the body first** (unticked checklist items may be real leftovers). Then
comment with the release tag and close: `gh issue close <n> --comment "Shipped in <tag>."`. Closing is visible to others, so
ask first unless the owner already told you to.

## Tags
`git ls-remote --tags origin` vs `gh release list`: a tag with no release is a failed run. Harmless; do not reuse its
number. Delete only on the owner's go-ahead.

## Finish
Report what was removed, what was kept and why. `git status` should show only intended changes (note any uncommitted
`.claude/settings.json`).
