const assert = require("node:assert/strict");
const vscode = require("vscode");

async function run() {
  const extension = vscode.extensions.getExtension("markdown-mint-local.markdown-mint");
  assert.ok(extension, "Markdown Mint extension is available in the development host");
  await extension.activate();

  const commands = await vscode.commands.getCommands(true);
  for (const command of [
    "markdownMint.openPreview",
    "markdownMint.openSource",
    "markdownMint.formatDocument",
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
