const { text } = require("./common");
const frameworks = [require("./codex"), require("./claude"), require("./grok")];
const aliases = new Map(frameworks.flatMap((framework) => framework.aliases.map((alias) => [alias, framework.frameworkId])));
const canonicalFrameworkId = (tool) => aliases.get(text(tool).trim().toLowerCase()) || "unknown";

// Runtime identity normalization only. Card IDs and components belong to CardStore.
module.exports = { canonicalFrameworkId };
