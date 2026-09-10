const assert = require("node:assert/strict");
const vscode = require("vscode");

async function run() {
  const extension = vscode.extensions.getExtension("markdown-weaver-local.markdown-weaver");
  assert.ok(extension, "Markdown Weaver extension is available in the development host");
  await extension.activate();

  const commands = await vscode.commands.getCommands(true);
  for (const command of [
    "markdownWeaver.openPreview",
    "markdownWeaver.openSource",
    "markdownWeaver.formatDocument",
  ]) {
    assert.ok(commands.includes(command), `registered command: ${command}`);
  }

  const document = await vscode.workspace.openTextDocument({
    language: "markdown",
    content: "# Extension smoke test\n",
  });
  assert.equal(document.languageId, "markdown");
}

module.exports = { run };
