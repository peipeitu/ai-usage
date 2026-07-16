const fs = require("fs");
const path = require("path");

function argValue(name, fallback = "") {
  const prefix = `${name}=`;
  const inline = process.argv.find((arg) => arg.startsWith(prefix));
  if (inline) return inline.slice(prefix.length);
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] || fallback : fallback;
}

function packageSectionVersion(content, fileName) {
  const section = content
    .split(/(?=^\[[^\]]+\]\s*$)/m)
    .find((candidate) => /^\[package\]\s*$/m.test(candidate));
  const version = section?.match(/^version\s*=\s*"([^"]+)"\s*$/m)?.[1];
  if (!version) {
    throw new Error(`Unable to read package version from ${fileName}.`);
  }
  return version;
}

function cargoLockVersion(content) {
  const section = content
    .split(/\n(?=\[\[package\]\]\n)/)
    .find((candidate) => /^name\s*=\s*"ai-usage"\s*$/m.test(candidate));
  const version = section?.match(/^version\s*=\s*"([^"]+)"\s*$/m)?.[1];
  if (!version) {
    throw new Error("Unable to read ai-usage version from src-tauri/Cargo.lock.");
  }
  return version;
}

function releaseVersions(root) {
  const packageJson = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8"));
  const packageLock = JSON.parse(fs.readFileSync(path.join(root, "package-lock.json"), "utf8"));
  const cargoToml = fs.readFileSync(path.join(root, "src-tauri", "Cargo.toml"), "utf8");
  const cargoLock = fs.readFileSync(path.join(root, "src-tauri", "Cargo.lock"), "utf8");
  const tauriConfig = JSON.parse(
    fs.readFileSync(path.join(root, "src-tauri", "tauri.conf.json"), "utf8"),
  );

  return {
    "package.json": packageJson.version,
    "package-lock.json": packageLock.version,
    "package-lock.json packages[\"\"]": packageLock.packages?.[""]?.version,
    "src-tauri/Cargo.toml": packageSectionVersion(cargoToml, "src-tauri/Cargo.toml"),
    "src-tauri/Cargo.lock": cargoLockVersion(cargoLock),
    "src-tauri/tauri.conf.json": tauriConfig.version,
  };
}

function checkRelease(root, tag = "") {
  const versions = releaseVersions(root);
  const entries = Object.entries(versions);
  const missing = entries.filter(([, version]) => !version).map(([file]) => file);
  if (missing.length) {
    throw new Error(`Missing version in ${missing.join(", ")}.`);
  }

  const expectedVersion = versions["package.json"];
  const mismatches = entries.filter(([, version]) => version !== expectedVersion);
  if (mismatches.length) {
    const details = entries.map(([file, version]) => `${file}=${version}`).join(", ");
    throw new Error(`Release versions are not synchronized: ${details}.`);
  }

  const changelog = fs.readFileSync(path.join(root, "CHANGELOG.md"), "utf8");
  if (!changelog.includes(`## ${expectedVersion} -`)) {
    throw new Error(`CHANGELOG.md has no release entry for ${expectedVersion}.`);
  }

  if (tag && tag !== `v${expectedVersion}`) {
    throw new Error(`Release tag ${tag} does not match version v${expectedVersion}.`);
  }

  return expectedVersion;
}

function main() {
  const root = path.resolve(argValue("--root", path.join(__dirname, "..")));
  const tag = argValue("--tag", process.env.RELEASE_TAG || "").trim();
  const version = checkRelease(root, tag);
  console.log(`Release configuration is synchronized at ${version}${tag ? ` (${tag})` : ""}.`);
}

if (require.main === module) {
  try {
    main();
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}

module.exports = { checkRelease, releaseVersions };
