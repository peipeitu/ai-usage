const assert = require("node:assert/strict");
const test = require("node:test");

const { validateManifest, verifyUpdaterRelease } = require("../scripts/verify-updater-release.js");

function manifestFixture() {
  return {
    version: "1.2.3",
    platforms: {
      "windows-x86_64": {
        signature: "windows signature",
        url: "https://github.com/owner/repo/releases/download/v1.2.3/AI.Usage_1.2.3_x64-setup.exe",
      },
      "linux-x86_64": {
        signature: "linux signature",
        url: "https://github.com/owner/repo/releases/download/v1.2.3/AI.Usage_1.2.3_amd64.AppImage",
      },
    },
  };
}

function mockResponse({ status = 200, json, text = "" } = {}) {
  return {
    ok: status >= 200 && status < 300,
    status,
    async json() {
      return json;
    },
    async text() {
      return text;
    },
  };
}

test("manifest validation rejects asset names that GitHub normalizes", () => {
  const manifest = manifestFixture();
  manifest.platforms["windows-x86_64"].url =
    "https://github.com/owner/repo/releases/download/v1.2.3/AI%20Usage_1.2.3_x64-setup.exe";

  assert.throws(
    () => validateManifest(manifest, "owner/repo", "v1.2.3"),
    /contains whitespace/,
  );
});

test("release verification checks assets and exact signature contents", async () => {
  const manifest = manifestFixture();
  const requested = [];
  const fetchImpl = async (url, init = {}) => {
    requested.push([url, init.method || "GET"]);
    assert.ok(init.signal instanceof AbortSignal);
    if (url.endsWith("/latest.json")) {
      return mockResponse({ json: manifest });
    }
    if (init.method === "HEAD") {
      return mockResponse({ status: 302 });
    }
    if (url.endsWith(".exe.sig")) {
      return mockResponse({ text: "windows signature\n" });
    }
    if (url.endsWith(".AppImage.sig")) {
      return mockResponse({ text: "linux signature\n" });
    }
    throw new Error(`Unexpected URL: ${url}`);
  };

  await verifyUpdaterRelease({
    repo: "owner/repo",
    tag: "v1.2.3",
    attempts: 1,
    delayMs: 0,
    timeoutMs: 1000,
    fetchImpl,
    log() {},
  });

  assert.deepEqual(
    requested.filter(([, method]) => method === "HEAD").map(([url]) => url),
    [
      manifest.platforms["windows-x86_64"].url,
      manifest.platforms["linux-x86_64"].url,
    ],
  );
  assert.deepEqual(
    requested.filter(([url]) => url.endsWith("/latest.json")).map(([url]) => url),
    [
      "https://github.com/owner/repo/releases/download/v1.2.3/latest.json",
      "https://github.com/owner/repo/releases/latest/download/latest.json",
    ],
  );
});

test("release verification rejects a signature mismatch", async () => {
  const manifest = manifestFixture();
  const fetchImpl = async (url, init = {}) => {
    if (url.endsWith("/latest.json")) return mockResponse({ json: manifest });
    if (init.method === "HEAD") return mockResponse({ status: 302 });
    return mockResponse({ text: "wrong signature" });
  };

  await assert.rejects(
    verifyUpdaterRelease({
      repo: "owner/repo",
      tag: "v1.2.3",
      attempts: 1,
      delayMs: 0,
      timeoutMs: 1000,
      fetchImpl,
      log() {},
    }),
    /signature does not match/,
  );
});

test("release verification retries content mismatches and refetches manifests", async () => {
  const manifest = manifestFixture();
  let taggedManifestReads = 0;
  let windowsSignatureReads = 0;
  const fetchImpl = async (url, init = {}) => {
    if (url.includes("/releases/download/") && url.endsWith("/latest.json")) {
      taggedManifestReads += 1;
      return mockResponse({ json: manifest });
    }
    if (url.includes("/releases/latest/") && url.endsWith("/latest.json")) {
      return mockResponse({ json: manifest });
    }
    if (init.method === "HEAD") return mockResponse({ status: 302 });
    if (url.endsWith(".exe.sig")) {
      windowsSignatureReads += 1;
      return mockResponse({
        text: windowsSignatureReads === 1 ? "stale signature" : "windows signature",
      });
    }
    return mockResponse({ text: "linux signature" });
  };

  await verifyUpdaterRelease({
    repo: "owner/repo",
    tag: "v1.2.3",
    attempts: 2,
    delayMs: 0,
    timeoutMs: 1000,
    fetchImpl,
    log() {},
  });

  assert.equal(windowsSignatureReads, 2);
  assert.equal(taggedManifestReads, 2);
});

test("release verification rejects a latest alias that points to another version", async () => {
  const manifest = manifestFixture();
  const staleManifest = manifestFixture();
  staleManifest.version = "1.2.2";
  const fetchImpl = async (url) => {
    if (url.includes("/releases/latest/")) return mockResponse({ json: staleManifest });
    return mockResponse({ json: manifest });
  };

  await assert.rejects(
    verifyUpdaterRelease({
      repo: "owner/repo",
      tag: "v1.2.3",
      attempts: 1,
      delayMs: 0,
      timeoutMs: 1000,
      fetchImpl,
      log() {},
    }),
    /does not match 1\.2\.3/,
  );
});
