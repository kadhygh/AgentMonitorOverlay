function chatGptWorkspaceUri(workspacePath) {
  return `codex://threads/new?path=${encodeURIComponent(workspacePath)}`;
}

function prepareChatGptWorkspaceLaunch(workspacePath) {
  const uri = chatGptWorkspaceUri(workspacePath);
  return {
    pid: null,
    command: "open_uri",
    args: [uri],
    uri,
  };
}

module.exports = {
  chatGptWorkspaceUri,
  prepareChatGptWorkspaceLaunch,
};
