const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");

const ED25519_SPKI_PREFIX = Buffer.from("302a300506032b6570032100", "hex");

function argValue(name, fallback = "") {
  const prefix = `${name}=`;
  const inline = process.argv.find((arg) => arg.startsWith(prefix));
  if (inline) return inline.slice(prefix.length);
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] || fallback : fallback;
}

function decodeBase64(value, label) {
  const encoded = value.trim();
  const decoded = Buffer.from(encoded, "base64");
  const canonical = decoded.toString("base64").replace(/=+$/, "");
  if (!encoded || canonical !== encoded.replace(/=+$/, "")) {
    throw new Error(`${label} is not valid base64.`);
  }
  return decoded;
}

function decodeTauriText(value, label) {
  const decoded = decodeBase64(value, label);
  const text = decoded.toString("utf8");
  if (!Buffer.from(text, "utf8").equals(decoded)) {
    throw new Error(`${label} does not contain UTF-8 Minisign data.`);
  }
  return text;
}

function signatureAlgorithm(packet, label) {
  const algorithm = packet.subarray(0, 2).toString("ascii");
  if (algorithm !== "Ed" && algorithm !== "ED") {
    throw new Error(`${label} uses an unsupported Minisign algorithm.`);
  }
  return algorithm;
}

function parsePublicKey(encodedPublicKey) {
  const lines = decodeTauriText(encodedPublicKey, "Updater public key").trim().split(/\r?\n/);
  if (lines.length !== 2 || !lines[0].startsWith("untrusted comment: ")) {
    throw new Error("Updater public key has an invalid Minisign format.");
  }

  const packet = decodeBase64(lines[1], "Updater public key packet");
  if (packet.length !== 42) {
    throw new Error("Updater public key packet has an invalid length.");
  }
  signatureAlgorithm(packet, "Updater public key");

  return {
    keyId: packet.subarray(2, 10),
    keyObject: crypto.createPublicKey({
      key: Buffer.concat([ED25519_SPKI_PREFIX, packet.subarray(10)]),
      format: "der",
      type: "spki",
    }),
  };
}

function parseSignature(encodedSignature) {
  const lines = decodeTauriText(encodedSignature, "Updater signature").trim().split(/\r?\n/);
  if (
    lines.length !== 4 ||
    !lines[0].startsWith("untrusted comment: ") ||
    !lines[2].startsWith("trusted comment: ")
  ) {
    throw new Error("Updater signature has an invalid Minisign format.");
  }

  const packet = decodeBase64(lines[1], "Updater signature packet");
  const globalSignature = decodeBase64(lines[3], "Updater global signature");
  if (packet.length !== 74 || globalSignature.length !== 64) {
    throw new Error("Updater signature has an invalid packet length.");
  }

  return {
    algorithm: signatureAlgorithm(packet, "Updater signature"),
    keyId: packet.subarray(2, 10),
    signature: packet.subarray(10),
    trustedComment: lines[2].slice("trusted comment: ".length),
    globalSignature,
  };
}

function verifyUpdaterSignature(data, encodedSignature, encodedPublicKey) {
  const publicKey = parsePublicKey(encodedPublicKey);
  const signature = parseSignature(encodedSignature);
  if (!publicKey.keyId.equals(signature.keyId)) {
    throw new Error("Updater signature was created by a different key.");
  }

  const signedData =
    signature.algorithm === "ED"
      ? crypto.createHash("blake2b512").update(data).digest()
      : data;
  if (!crypto.verify(null, signedData, publicKey.keyObject, signature.signature)) {
    throw new Error("Updater artifact signature verification failed.");
  }

  const trustedData = Buffer.concat([
    signature.signature,
    Buffer.from(signature.trustedComment, "utf8"),
  ]);
  if (
    !crypto.verify(null, trustedData, publicKey.keyObject, signature.globalSignature)
  ) {
    throw new Error("Updater signature trusted comment verification failed.");
  }
}

function walkFiles(dir) {
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const fullPath = path.join(dir, entry.name);
    return entry.isDirectory() ? walkFiles(fullPath) : [fullPath];
  });
}

function findOne(files, suffix, label) {
  const matches = files.filter((file) => file.endsWith(suffix));
  if (matches.length !== 1) {
    throw new Error(`Expected exactly one ${label}, found ${matches.length}.`);
  }
  return matches[0];
}

function verifyUpdaterArtifacts(artifactsDir, encodedPublicKey) {
  if (!encodedPublicKey.trim()) {
    throw new Error("AI_USAGE_UPDATER_PUBLIC_KEY is required to verify updater signatures.");
  }

  const files = walkFiles(artifactsDir);
  const artifacts = [
    findOne(files, ".exe", "Windows NSIS installer"),
    findOne(files, ".AppImage", "Linux AppImage"),
  ];

  for (const artifact of artifacts) {
    const signaturePath = `${artifact}.sig`;
    if (!fs.existsSync(signaturePath)) {
      throw new Error(`Missing updater signature for ${artifact}.`);
    }
    verifyUpdaterSignature(
      fs.readFileSync(artifact),
      fs.readFileSync(signaturePath, "utf8").trim(),
      encodedPublicKey,
    );
    console.log(`Verified updater signature for ${path.basename(artifact)}`);
  }
}

function main() {
  const artifactsDir = path.resolve(
    argValue("--artifacts", path.join(__dirname, "..", "release-artifacts")),
  );
  verifyUpdaterArtifacts(artifactsDir, process.env.AI_USAGE_UPDATER_PUBLIC_KEY || "");
}

if (require.main === module) {
  try {
    main();
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}

module.exports = { parsePublicKey, parseSignature, verifyUpdaterArtifacts, verifyUpdaterSignature };
