const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const vm = require("node:vm");

function createElement() {
  return {
    addEventListener() {},
    disabled: false,
    setAttribute() {},
    style: {},
    textContent: ""
  };
}

function loadTrayScript() {
  const elements = new Map();
  const document = {
    body: { dataset: {} },
    documentElement: { lang: "" },
    getElementById(id) {
      if (!elements.has(id)) elements.set(id, createElement());
      return elements.get(id);
    }
  };
  const context = vm.createContext({
    document,
    window: {
      __TAURI__: {},
      addEventListener() {}
    }
  });
  const source = fs.readFileSync(path.join(__dirname, "..", "src", "renderer", "tray.js"), "utf8");

  vm.runInContext(source, context, { filename: "tray.js" });
  return { context, elements };
}

test("missing remaining usage stays unavailable", () => {
  const { context, elements } = loadTrayScript();

  assert.equal(context.normalizedPercent(null), null);
  assert.equal(context.normalizedPercent(undefined), null);
  assert.equal(context.normalizedPercent(0), 0);

  context.renderStatus({
    provider: "copilot",
    remainingPercent: null,
    statusLabel: "Usage unavailable"
  });

  assert.equal(elements.get("usageValue").textContent, "--");
  assert.equal(elements.get("usageFill").style.width, "0");
  assert.equal(elements.get("usageMeta").textContent, "Usage unavailable");
});
