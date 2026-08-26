const path = require("path");
const { findWindowsExecutable } = require("./cli-environments");

function grokExecutableCandidates(environment = process.env) {
  const userProfile = environment.USERPROFILE || environment.HOME;
  return userProfile ? [path.join(userProfile, ".grok", "bin", "grok.exe")] : [];
}

function resolveGrokExecutable(options = {}) {
  if ((options.platform || process.platform) !== "win32") return "grok";
  const findExecutable = options.findExecutable || findWindowsExecutable;
  const environment = options.environment || process.env;
  return findExecutable("grok.exe", grokExecutableCandidates(environment)) || "grok";
}

module.exports = {
  grokExecutableCandidates,
  resolveGrokExecutable,
};
