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

async function fetchWithRetry(
  url,
  init,
  { attempts, delayMs, timeoutMs, fetchImpl, label, allowRedirect = false },
) {
  let lastError;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      const response = await fetchImpl(url, {
        ...init,
        signal: AbortSignal.timeout(timeoutMs),
      });
      if (responseAvailable(response, allowRedirect)) {
        return response;
      }
      lastError = new Error(`${label} returned HTTP ${response.status}.`);
    } catch (error) {
      lastError = new Error(`${label} failed: ${error.message}`);
    }

    if (attempt < attempts && delayMs > 0) {
      await new Promise((resolve) => setTimeout(resolve, delayMs));
    }
  }
  throw lastError;
}

async function verifyUpdaterRelease({
  repo,
  tag,
  attempts = 6,
  delayMs = 5000,
  timeoutMs = 15000,
  fetchImpl = globalThis.fetch,
  log = console.log,
}) {
  if (!repo || !tag) {
    throw new Error("Both --repo and --tag are required.");
  }
  if (typeof fetchImpl !== "function") {
    throw new Error("This command requires Node.js with fetch support.");
  }

  const manifestUrl = `https://github.com/${repo}/releases/download/${tag}/latest.json`;
  const manifestResponse = await fetchWithRetry(
    manifestUrl,
    { redirect: "follow" },
    { attempts, delayMs, timeoutMs, fetchImpl, label: "Updater manifest" },
  );
  const manifest = validateManifest(await manifestResponse.json(), repo, tag);

  for (const platform of Object.keys(REQUIRED_PLATFORMS)) {
    const entry = manifest.platforms[platform];
    await fetchWithRetry(
      entry.url,
      { method: "HEAD", redirect: "manual" },
      {
        attempts,
        delayMs,
        timeoutMs,
        fetchImpl,
        label: `${platform} updater asset`,
        allowRedirect: true,
      },
    );
    const signatureResponse = await fetchWithRetry(
      `${entry.url}.sig`,
      { redirect: "follow" },
      { attempts, delayMs, timeoutMs, fetchImpl, label: `${platform} updater signature` },
    );
    const releasedSignature = (await signatureResponse.text()).trim();
    if (releasedSignature !== entry.signature.trim()) {
      throw new Error(`${platform} signature does not match latest.json.`);
    }
    log(`${platform}: asset and signature verified`);
  }

  log(`Updater release ${tag} verified successfully.`);
  return manifest;
}

async function main() {
  await verifyUpdaterRelease({
    repo: argValue("--repo", process.env.GITHUB_REPOSITORY || ""),
    tag: argValue("--tag", process.env.GITHUB_REF_NAME || ""),
    attempts: positiveInteger(argValue("--attempts", ""), 6),
    delayMs: positiveInteger(argValue("--delay-ms", ""), 5000),
    timeoutMs: positiveInteger(argValue("--timeout-ms", ""), 15000),
  });
}

if (require.main === module) {
  main().catch((error) => {
    console.error(error.message);
    process.exitCode = 1;
  });
}

module.exports = { validateManifest, verifyUpdaterRelease };
