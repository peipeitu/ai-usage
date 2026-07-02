const fs = require("fs");
const path = require("path");

const pubkey = (process.env.AI_USAGE_UPDATER_PUBLIC_KEY || "").trim();

if (!pubkey) {
  console.error("AI_USAGE_UPDATER_PUBLIC_KEY is required for signed updater builds.");
  process.exit(1);
}

const config = {
  bundle: {
    createUpdaterArtifacts: true,
  },
  plugins: {
    updater: {
      pubkey,
      windows: {
        installMode: "passive",
      },
    },
  },
};

const outputPath = path.join(
  __dirname,
  "..",
  "src-tauri",
  "tauri.updater.generated.conf.json",
);

fs.writeFileSync(outputPath, `${JSON.stringify(config, null, 2)}\n`);
console.log(`Wrote updater config to ${outputPath}`);
