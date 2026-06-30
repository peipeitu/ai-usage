const os = require("node:os");
const path = require("node:path");
const fs = require("node:fs");

function getCodexHome(env = process.env) {
  if (env.CODEX_HOME && env.CODEX_HOME.trim()) {
    return env.CODEX_HOME;
  }

  return path.join(os.homedir(), ".codex");
}

function firstExisting(paths) {
  return paths.find((candidate) => fs.existsSync(candidate)) || paths[0];
}

function getCodexDatabasePaths(codexHome = getCodexHome()) {
  return {
    codexHome,
    stateDbPath: firstExisting([
      path.join(codexHome, "state_5.sqlite"),
      path.join(codexHome, "sqlite", "state_5.sqlite")
    ]),
    logsDbPath: firstExisting([
      path.join(codexHome, "logs_2.sqlite"),
      path.join(codexHome, "sqlite", "logs_2.sqlite")
    ]),
    sessionIndexPath: path.join(codexHome, "session_index.jsonl")
  };
}

module.exports = {
  getCodexHome,
  getCodexDatabasePaths
};
