const fs = require("node:fs");
const path = require("node:path");

function decodeJwtPayload(token) {
  if (!token || typeof token !== "string") return null;
  const [, payload] = token.split(".");
  if (!payload) return null;

  try {
    const normalized = payload.replace(/-/g, "+").replace(/_/g, "/");
    return JSON.parse(Buffer.from(normalized, "base64").toString("utf8"));
  } catch {
    return null;
  }
}

function initialsFromName(name) {
  const parts = String(name || "")
    .trim()
    .split(/\s+/)
    .filter(Boolean);

  if (parts.length === 0) return "CD";
  return parts
    .slice(0, 2)
    .map((part) => part[0])
    .join("")
    .toUpperCase();
}

function readCodexAccount(codexHome) {
  const authPath = path.join(codexHome, "auth.json");
  let claims = null;

  try {
    const auth = JSON.parse(fs.readFileSync(authPath, "utf8"));
    claims = decodeJwtPayload(auth.tokens?.id_token);
  } catch {
    claims = null;
  }

  const displayName = claims?.name || claims?.nickname || claims?.email || "Codex";

  return {
    displayName,
    initials: initialsFromName(displayName)
  };
}

function formatPlanType(planType) {
  if (!planType) return "Codex";
  const normalized = String(planType).trim().toLowerCase();
  if (normalized === "prolite") return "Pro";
  return normalized[0].toUpperCase() + normalized.slice(1);
}

function planMonthlyUsd(planType) {
  const normalized = String(planType || "").trim().toLowerCase();
  if (normalized === "free") return 0;
  if (normalized === "go") return 8;
  if (normalized === "plus") return 20;
  if (normalized === "pro" || normalized === "prolite") return 100;
  if (normalized === "business" || normalized === "team") return 20;
  return null;
}

module.exports = {
  decodeJwtPayload,
  formatPlanType,
  initialsFromName,
  planMonthlyUsd,
  readCodexAccount
};
