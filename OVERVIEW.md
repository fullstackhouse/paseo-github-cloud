# GitHub Copilot (cloud) for Paseo

Adds a **GitHub Copilot (cloud)** provider. Each agent follows one GitHub Copilot cloud agent task, which runs
in GitHub's sandbox and bills to your Copilot plan.

- **Login:** your `gh` login (`gh auth login`), or `GH_TOKEN` in the daemon environment. The token needs
  Copilot cloud agent access to the repository.
- **New agents:** the first message starts a task on the workspace's GitHub repository (its `origin`), with
  the model picked in the composer (`Auto` lets GitHub choose). Later messages are sent to the same task;
  sent while it works, they steer the running turn. Stop aborts it.
- **Task links:** a `github.com/<owner>/<repo>/tasks/<id>` link in chat opens the task as a Paseo agent,
  with its history, in a workspace on that repository. Right-click a link for **Open as Paseo agent**.
  Opening the same task again reuses its agent.
- **Interactive tasks:** tasks started on github.com in the interactive sandbox report their mode
  (Interactive, Plan, Autopilot). Plan approvals and the agent's questions show as cards; you can also
  answer a question by typing.
- **Work started elsewhere:** messages sent from github.com show up in Paseo, which polls the task every
  2 s while it works and every 10 s while it rests.

This uses GitHub's private task API (the one github.com and VS Code use). It can change without notice.
Starting the interactive sandbox from Paseo is not supported: new agents use the coding agent, which
opens a pull request.
