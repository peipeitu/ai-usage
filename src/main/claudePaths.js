const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

function getClaudeHome(env = process.env) {
  if (env.CLAUDE_CONFIG_DIR && env.CLAUDE_CONFIG_DIR.trim()) {
    return env.CLAUDE_CONFIG_DIR;
  }

  if (env.CLAUDE_HOME && env.CLAUDE_HOME.trim()) {
    return env.CLAUDE_HOME;
  }

  return path.join(os.homedir(), ".claude");
}

function getClaudePaths(claudeHome = getClaudeHome()) {
  return {
    claudeHome,
    projectsPath: path.join(claudeHome, "projects"),
    settingsPath: path.join(claudeHome, "settings.json"),
    historyPath: path.join(claudeHome, "history.jsonl")
  };
}

function listClaudeSessionFiles(projectsPath) {
  if (!fs.existsSync(projectsPath)) {
    return [];
  }

  const files = [];
  const stack = [projectsPath];

  while (stack.length > 0) {
    const current = stack.pop();
    let entries = [];

    try {
      entries = fs.readdirSync(current, { withFileTypes: true });
    } catch {
      continue;
    }

    for (const entry of entries) {
      const entryPath = path.join(current, entry.name);
      if (entry.isDirectory()) {
        stack.push(entryPath);
      } else if (entry.isFile() && entry.name.endsWith(".jsonl")) {
        files.push(entryPath);
      }
    }
  }

  return files.sort();
}

module.exports = {
  getClaudeHome,
  getClaudePaths,
  listClaudeSessionFiles
};
