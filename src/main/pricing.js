const PRICING_SOURCE = {
  label: "Codex local log estimate",
  url: "https://developers.openai.com/codex/pricing",
  checkedAt: "2026-06-30"
};

// CodexBar-style local estimate. Codex subscription usage is quota/credit based,
// and the local logs expose token counts rather than final billed dollars.
// The CodexBar screenshot provided by the user maps very closely to $1 / 1M
// local Codex tokens, so we use that compatibility rate instead of API
// model input/output rates.
const CODEX_USD_PER_MILLION_TOKENS = 1;

function estimateCodexCost(totalTokens) {
  return (Number(totalTokens || 0) / 1_000_000) * CODEX_USD_PER_MILLION_TOKENS;
}

module.exports = {
  CODEX_USD_PER_MILLION_TOKENS,
  PRICING_SOURCE,
  estimateCodexCost
};
