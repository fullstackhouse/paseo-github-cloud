import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

export interface GitHubRepo {
  owner: string;
  name: string;
}

/** The GitHub repository behind `cwd`'s `origin` remote. */
export async function readRepo(cwd: string): Promise<GitHubRepo> {
  let url: string;
  try {
    url = (await git(cwd, ["remote", "get-url", "origin"])).trim();
  } catch {
    throw new Error("The workspace needs a git repository with a GitHub `origin` remote.");
  }
  const repo = parseGitHubRemote(url);
  if (!repo) throw new Error(`The workspace's origin is not a github.com repository: ${url}`);
  return repo;
}

export function parseGitHubRemote(url: string): GitHubRepo | null {
  const match = url.match(/github\.com[:/]+([^/]+)\/([^/]+?)(?:\.git)?\/?$/);
  return match ? { owner: match[1], name: match[2] } : null;
}

async function git(cwd: string, args: string[]): Promise<string> {
  const { stdout } = await execFileAsync("git", args, { cwd });
  return stdout;
}
