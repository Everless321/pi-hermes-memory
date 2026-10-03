# Repo key: project identity for company memory sync

A project's team memory is keyed by its source repository, not by a local
folder. Every party that names a repository — the memory extension detecting a
working copy, and dibs storing a project's repository addresses — derives the
same **repo key** with the rules below. `tests/fixtures/repo-keys.json` is the
shared conformance list; any implementation must pass all of it.

## Detection order (working copy → repository URL)

1. **Git.** Walk up from the working directory to the repository root. A
   `.git` *file* is a linked worktree: follow `gitdir:` and `commondir` to the
   shared repository. Use remote `origin`; if absent, the first remote in
   `.git/config` order. Prefer `git config --get remote.<name>.url`; parse
   `.git/config` directly when `git` is unavailable. Kind = `git`.
2. **SVN.** Walk up to the directory holding `.svn`. Prefer
   `svn info --show-item url`; without the `svn` client, read `.svn/wc.db`
   (SQLite): `REPOSITORY.root` joined with the `repos_path` of the `NODES` row
   whose `local_relpath = ''`. Kind = `svn`.
3. Neither: the project is local-only and is never synced.

## Normalization `repoKey(kind, url)`

Input is the kind (`git` or `svn`) and a URL. Output is
`<kind>:<host>[:<port>]/<path>`, or `null` when the URL cannot name a remote
repository (empty, `file:`, a bare local path).

1. Trim whitespace. Accept `scheme://[userinfo@]host[:port]/path` and the git
   scp form `[user@]host:path` (no scheme, a `:` before any `/`, and a host
   that is not a Windows drive letter).
2. Drop the scheme and any userinfo (user names, passwords, tokens).
3. Host: lowercase. Port: kept unless it is the scheme's default
   (http 80, https 443, ssh/git+ssh/svn+ssh 22, git 9418, svn 3690). The scp
   form has no port.
4. Path: collapse repeated `/`, strip leading and trailing `/`, drop any query
   or fragment. Percent-encoding is left as written.
5. Kind `git`: strip one trailing `.git`, then lowercase the path (Git hosts
   treat owner/repository names case-insensitively).
6. Kind `svn`: keep path case. Cut the path at the first segment that is
   `trunk`, or at `branches/<name>` / `tags/<name>`, so every line of
   development maps to one project. A path with none of these is kept whole.
7. An empty path after these steps yields `null`.

dibs stores each repository address with an explicit kind: `svn://` and
`svn+ssh://` imply `svn`; for `http(s)://` the user picks git (default) or svn.
