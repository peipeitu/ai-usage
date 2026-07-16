const { verifyUpdaterSignature } = require("./verify-updater-signatures.js");

const REQUIRED_PLATFORMS = {
  "windows-x86_64": ".exe",
  "linux-x86_64": ".AppImage",
};

function argValue(name, fallback = "") {
  const prefix = `${name}=`;
  const inline = process.argv.find((arg) => arg.startsWith(prefix));
  if (inline) return inline.slice(prefix.length);
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] || fallback : fallback;
}

function positiveInteger(value, fallback) {
  const parsed = Number.parseInt(value, 10);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
}

function validateManifest(manifest, repo, tag) {
  if (!manifest || typeof manifest !== "object") {
    throw new Error("Updater manifest is not a JSON object.");
  }

  const expectedVersion = tag.replace(/^v/, "");
  if (manifest.version !== expectedVersion) {
    throw new Error(
      `Updater manifest version ${manifest.version || "<missing>"} does not match ${expectedVersion}.`,
    );
  }

  for (const [platform, suffix] of Object.entries(REQUIRED_PLATFORMS)) {
    const entry = manifest.platforms?.[platform];
    if (!entry || typeof entry !== "object") {
      throw new Error(`Updater manifest is missing ${platform}.`);
    }
    if (typeof entry.signature !== "string" || !entry.signature.trim()) {
      throw new Error(`Updater manifest has no signature for ${platform}.`);
    }
    if (typeof entry.url !== "string" || !entry.url.trim()) {
      throw new Error(`Updater manifest has no URL for ${platform}.`);
    }

    const url = new URL(entry.url);
    const expectedPrefix = `/${repo}/releases/download/${encodeURIComponent(tag)}/`;
    if (url.protocol !== "https:" || url.hostname !== "github.com" || !url.pathname.startsWith(expectedPrefix)) {
      throw new Error(`Updater URL for ${platform} does not target ${repo} ${tag}.`);
    }
    const assetName = decodeURIComponent(url.pathname.split("/").pop() || "");
    if (!assetName.endsWith(suffix)) {
      throw new Error(`Updater URL for ${platform} does not end with ${suffix}.`);
    }
    if (/\s/.test(assetName)) {
      throw new Error(`Updater URL for ${platform} contains whitespace that GitHub normalizes.`);
    }
  }

  return manifest;
}

function responseAvailable(response, allowRedirect = false) {
  return response.ok || (allowRedirect && response.status >= 300 && response.status < 400);
}

async function fetchChecked(
  url,
  init,
  { timeoutMs, fetchImpl, label, allowRedirect = false },
) {
  let response;
  try {
    response = await fetchImpl(url, {
      ...init,
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (error) {
    throw new Error(`${label} failed: ${error.message}`);
  }
  if (!responseAvailable(response, allowRedirect)) {
    throw new Error(`${label} returned HTTP ${response.status}.`);
  }
  return response;
}

async function retryOperation(label, attempts, delayMs, operation) {
  let lastError;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      return await operation();
    } catch (error) {
      lastError = error;
    }
    if (attempt < attempts && delayMs > 0) {
      await new Promise((resolve) => setTimeout(resolve, delayMs));
    }
  }
  throw new Error(`${label} failed after ${attempts} attempt(s): ${lastError.message}`);
}

function assertLatestManifest(tagManifest, latestManifest) {
  for (const platform of Object.keys(REQUIRED_PLATFORMS)) {
    const tagEntry = tagManifest.platforms[platform];
    const latestEntry = latestManifest.platforms[platform];
    if (
      tagEntry.url !== latestEntry.url ||
      tagEntry.signature.trim() !== latestEntry.signature.trim()
    ) {
      throw new Error(`Latest updater manifest does not match ${platform} for the release tag.`);
    }
  }
}

async function verifyUpdaterReleaseOnce({ repo, tag, encodedPublicKey, timeoutMs, fetchImpl }) {
  const requestOptions = { timeoutMs, fetchImpl };
  const tagManifestUrl = `https://github.com/${repo}/releases/download/${tag}/latest.json`;
  const tagManifestResponse = await fetchChecked(
    tagManifestUrl,
    { redirect: "follow" },
    { ...requestOptions, label: "Tagged updater manifest" },
  );
  const tagManifest = validateManifest(await tagManifestResponse.json(), repo, tag);

  const latestManifestUrl = `https://github.com/${repo}/releases/latest/download/latest.json`;
  const latestManifestResponse = await fetchChecked(
    latestManifestUrl,
    { redirect: "follow" },
    { ...requestOptions, label: "Latest updater manifest" },
  );
  const latestManifest = validateManifest(await latestManifestResponse.json(), repo, tag);
  assertLatestManifest(tagManifest, latestManifest);

  for (const platform of Object.keys(REQUIRED_PLATFORMS)) {
    const entry = tagManifest.platforms[platform];
    const signatureResponse = await fetchChecked(
      `${entry.url}.sig`,
      { redirect: "follow" },
      { ...requestOptions, label: `${platform} updater signature` },
    );
    const releasedSignature = (await signatureResponse.text()).trim();
    if (releasedSignature !== entry.signature.trim()) {
      throw new Error(`${platform} signature does not match latest.json.`);
    }
    const artifactResponse = await fetchChecked(
      entry.url,
      { redirect: "follow" },
      { ...requestOptions, label: `${platform} updater asset` },
    );
    try {
      verifyUpdaterSignature(
        Buffer.from(await artifactResponse.arrayBuffer()),
        releasedSignature,
        encodedPublicKey,
      );
    } catch (error) {
      throw new Error(`${platform} released artifact verification failed: ${error.message}`);
    }
  }

  return tagManifest;
}

async function verifyUpdaterRelease({
  repo,
  tag,
  encodedPublicKey,
  attempts = 6,
  delayMs = 5000,
  timeoutMs = 60000,
  fetchImpl = globalThis.fetch,
  log = console.log,
}) {
  if (!repo || !tag) {
    throw new Error("Both --repo and --tag are required.");
  }
  if (typeof encodedPublicKey !== "string" || !encodedPublicKey.trim()) {
    throw new Error("AI_USAGE_UPDATER_PUBLIC_KEY is required to verify released artifacts.");
  }
  if (typeof fetchImpl !== "function") {
    throw new Error("This command requires Node.js with fetch support.");
  }

  const manifest = await retryOperation(
    `Updater release ${tag}`,
    attempts,
    delayMs,
    () => verifyUpdaterReleaseOnce({ repo, tag, encodedPublicKey, timeoutMs, fetchImpl }),
  );

  for (const platform of Object.keys(REQUIRED_PLATFORMS)) {
    log(`${platform}: asset and signature verified`);
  }

  log(`Updater release ${tag} verified successfully.`);
  return manifest;
}

async function main() {
  await verifyUpdaterRelease({
    repo: argValue("--repo", process.env.GITHUB_REPOSITORY || ""),
    tag: argValue("--tag", process.env.GITHUB_REF_NAME || ""),
    encodedPublicKey: process.env.AI_USAGE_UPDATER_PUBLIC_KEY || "",
    attempts: positiveInteger(argValue("--attempts", ""), 6),
    delayMs: positiveInteger(argValue("--delay-ms", ""), 5000),
    timeoutMs: positiveInteger(argValue("--timeout-ms", ""), 60000),
  });
}

if (require.main === module) {
  main().catch((error) => {
    console.error(error.message);
    process.exitCode = 1;
  });
}

module.exports = { assertLatestManifest, validateManifest, verifyUpdaterRelease };
