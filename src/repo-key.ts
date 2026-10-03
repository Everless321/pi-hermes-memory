/**
 * Repo key: the repository identity company memory sync keys a project by.
 * Specified in docs/company/repo-key.md; tests/fixtures/repo-keys.json is the
 * shared conformance list (dibs implements the same rules).
 */

export type RepoKind = "git" | "svn";

const DEFAULT_PORTS: Record<string, string> = {
  http: "80",
  https: "443",
  ssh: "22",
  "git+ssh": "22",
  "ssh+git": "22",
  "svn+ssh": "22",
  git: "9418",
  svn: "3690",
};

type ParsedRemote = { scheme: string | null; host: string; port: string | null; path: string };

function parseRemote(raw: string): ParsedRemote | null {
  const url = raw.trim();
  if (!url) return null;

  const withScheme = /^([a-z][a-z0-9+.-]*):\/\/([^/?#]*)([^?#]*)/i.exec(url);
  if (withScheme) {
    const scheme = withScheme[1].toLowerCase();
    if (scheme === "file") return null;
    const authority = withScheme[2].replace(/^.*@/, "");
    const hostPort = /^(\[[^\]]+\]|[^:]*)(?::(\d*))?$/.exec(authority);
    if (!hostPort || !hostPort[1]) return null;
    return { scheme, host: hostPort[1], port: hostPort[2] || null, path: withScheme[3] };
  }

  // scp form: [user@]host:path — a ':' before any '/', and not a drive letter.
  const scp = /^(?:[^@/\s]+@)?([^:/\s]+):(?!\/\/)([^?#]*)/.exec(url);
  if (scp && !/^[a-z]$/i.test(scp[1])) {
    return { scheme: null, host: scp[1], port: null, path: scp[2] };
  }
  return null;
}

function cutSvnLayout(segments: string[]): string[] {
  for (let index = 0; index < segments.length; index += 1) {
    const segment = segments[index];
    if (segment === "trunk") return segments.slice(0, index);
    if ((segment === "branches" || segment === "tags") && index + 1 < segments.length) {
      return segments.slice(0, index);
    }
  }
  return segments;
}

/** Normalize a repository URL to `<kind>:<host>[:<port>]/<path>`, or null. */
export function repoKey(kind: RepoKind, url: string): string | null {
  const parsed = parseRemote(url);
  if (!parsed) return null;

  const host = parsed.host.toLowerCase();
  const port = parsed.port && parsed.scheme && DEFAULT_PORTS[parsed.scheme] === parsed.port ? null : parsed.port;

  let segments = parsed.path.split("/").filter(Boolean);
  if (kind === "git") {
    if (segments.length > 0) {
      const last = segments[segments.length - 1].replace(/\.git$/i, "");
      segments[segments.length - 1] = last;
      segments = segments.filter(Boolean).map((segment) => segment.toLowerCase());
    }
  } else {
    segments = cutSvnLayout(segments);
  }
  if (segments.length === 0) return null;
  return `${kind}:${host}${port ? `:${port}` : ""}/${segments.join("/")}`;
}
