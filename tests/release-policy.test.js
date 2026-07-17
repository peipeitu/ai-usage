const assert = require("node:assert/strict");
const test = require("node:test");

const { releaseMutationPolicy } = require("../scripts/release-policy.js");

test("release policy creates a missing release", () => {
  assert.deepEqual(
    releaseMutationPolicy({ exists: false, isDraft: false, repair: false }),
    { shouldMutate: true },
  );
});

test("release policy resumes an existing draft", () => {
  assert.deepEqual(
    releaseMutationPolicy({ exists: true, isDraft: true, repair: false }),
    { shouldMutate: true },
  );
});

test("release policy keeps a published release read-only by default", () => {
  assert.deepEqual(
    releaseMutationPolicy({ exists: true, isDraft: false, repair: false }),
    { shouldMutate: false },
  );
});

test("release policy permits an explicit published-release repair", () => {
  assert.deepEqual(
    releaseMutationPolicy({ exists: true, isDraft: false, repair: true }),
    { shouldMutate: true },
  );
});

test("release policy resumes a draft during explicit repair", () => {
  assert.deepEqual(
    releaseMutationPolicy({ exists: true, isDraft: true, repair: true }),
    { shouldMutate: true },
  );
});

test("release policy rejects repair for a missing release", () => {
  assert.throws(
    () => releaseMutationPolicy({ exists: false, isDraft: false, repair: true }),
    /existing release/,
  );
});
