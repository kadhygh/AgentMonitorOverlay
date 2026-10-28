// @amo-studio/account: the team login and the shared files under %APPDATA%\AMO, for every AMO tool.
//   Read only (any tool):  readAccountInfo() (sync, no key), readAccount() (with the key), amoHome(), programsFile() …
//   Write (the platform):  login(), register() (+ serverInfo()), logout(), saveAccount(), clearAccount(), rememberServer()
export * from "./paths.js";
export * from "./json.js";
export * from "./dpapi.js";
export * from "./account.js";
