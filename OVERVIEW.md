# GitHub Copilot (cloud) for Paseo

Adds a **GitHub Copilot (cloud)** provider. Each agent follows one GitHub Copilot cloud agent task, running
in GitHub's cloud and billed to your Copilot plan.

- **Login:** your `gh` login (`gh auth login`), or `GH_TOKEN` in the daemon environment. The token needs
  Copilot cloud agent access to the repository.
- **New agents:** the first message starts a task on the workspace's GitHub repository (its `origin`). The
  mode picks the kind:
  - **Interactive**, **Plan** or **Autopilot**: an interactive cloud sandbox, like the chat on github.com.
    You talk to it, answer its questions, approve its plans and permissions, switch modes and stop it.
  - **Pull request agent**: GitHub's coding agent works on a branch and opens a pull request. Later
    messages steer it; Stop aborts it.
- **Task links:** a `github.com/<owner>/<repo>/tasks/<id>` link in chat opens the task as a Paseo agent,
  with its history, in a workspace on that repository. Right-click a link for **Open as Paseo agent**.
  Opening the same task again reuses its agent.
- **Questions and plans:** they show as cards. Pick an answer on the card, or type a reply in the composer.
- **Sleeping sandboxes:** a sandbox sleeps when idle. Your next message wakes it, which can take a minute;
  Paseo says "Waking the cloud sandbox…" meanwhile.
- **Work started elsewhere:** messages sent from github.com show up in Paseo, which polls the task every
  2 s while it works and every 10 s while it rests.

Interactive sandboxes take input over GitHub's Agent Host Protocol relay (the protocol github.com and
VS Code use), built on `@microsoft/agent-host-protocol`. Both it and the task API are internal to GitHub
and can change without notice.
