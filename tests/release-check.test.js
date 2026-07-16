const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawnSync } = require("node:child_process");
const test = require("node:test");

const root = path.resolve(__dirname, "..");
const script = path.join(root, "scripts", "check-release.js");

function releaseFixture(t, versions = {}) {
  const fixture = fs.mkdtempSync(path.join(os.tmpdir(), "ai-usage-release-check-"));
  t.after(() => fs.rmSync(fixture, { recursive: true, force: true }));
  fs.mkdirSync(path.join(fixture, "src-tauri"), { recursive: true });

  const version = versions.packageJson || "1.2.3";
  fs.writeFileSync(
    path.join(fixture, "package.json"),
    JSON.stringify({ name: "ai-usage", version }),
  );
  fs.writeFileSync(
    path.join(fixture, "package-lock.json"),
    JSON.stringify({
      version: versions.packageLock || version,
      packages: { "": { version: versions.packageLockRoot || version } },
    }),
  );
  fs.writeFileSync(
    path.join(fixture, "src-tauri", "Cargo.toml"),
    `[package]\nname = "ai-usage"\nversion = "${versions.cargoToml || version}"\n\n[dependencies]\n`,
  );
  fs.writeFileSync(
    path.join(fixture, "src-tauri", "Cargo.lock"),
    `version = 4\n\n[[package]]\nname = "ai-usage"\nversion = "${versions.cargoLock || version}"\n`,
  );
  fs.writeFileSync(
    path.join(fixture, "src-tauri", "tauri.conf.json"),
    JSON.stringify({ version: versions.tauri || version }),
  );
  fs.writeFileSync(path.join(fixture, "CHANGELOG.md"), `# Changelog\n\n## ${version} - 2026-07-16\n`);
  return fixture;
}

function runCheck(fixture, tag) {
  return spawnSync(process.execPath, [script, "--root", fixture, "--tag", tag], {
    encoding: "utf8",
  });
}

test("release check accepts synchronized versions and matching tag", (t) => {
  const result = runCheck(releaseFixture(t), "v1.2.3");

  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /synchronized at 1\.2\.3 \(v1\.2\.3\)/);
});

test("release check rejects mismatched metadata", (t) => {
  const result = runCheck(releaseFixture(t, { tauri: "1.2.4" }), "v1.2.3");

  assert.equal(result.status, 1);
  assert.match(result.stderr, /versions are not synchronized/);
});

test("release check rejects a tag that does not match the app version", (t) => {
  const result = runCheck(releaseFixture(t), "v1.2.4");

  assert.equal(result.status, 1);
  assert.match(result.stderr, /does not match version v1\.2\.3/);
});
