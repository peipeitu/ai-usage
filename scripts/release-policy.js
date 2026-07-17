function argValue(name, fallback = "") {
  const prefix = `${name}=`;
  const inline = process.argv.find((arg) => arg.startsWith(prefix));
  if (inline) return inline.slice(prefix.length);
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] || fallback : fallback;
}

function parseBoolean(value, label) {
  if (value === "true") return true;
  if (value === "false") return false;
  throw new Error(`${label} must be true or false.`);
}

function releaseMutationPolicy({ exists, isDraft, repair }) {
  if (!exists && isDraft) {
    throw new Error("A non-existent release cannot be a draft.");
  }
  if (repair && !exists) {
    throw new Error("Release repair requires an existing release.");
  }
  return {
    shouldMutate: !exists || isDraft || repair,
  };
}

function main() {
  const policy = releaseMutationPolicy({
    exists: parseBoolean(argValue("--exists"), "--exists"),
    isDraft: parseBoolean(argValue("--draft"), "--draft"),
    repair: parseBoolean(argValue("--repair"), "--repair"),
  });
  console.log(`should_mutate=${policy.shouldMutate}`);
}

if (require.main === module) {
  try {
    main();
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}

module.exports = { releaseMutationPolicy };
