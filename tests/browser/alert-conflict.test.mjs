import assert from "node:assert/strict";
import { resolve } from "node:path";

const initial = "Before\n\n> [!NOTE]\n> body\n\nAfter";
const bodySelector = ".mm-rich-panel .mm-alert-body-editor";

async function loadWithHeldEdits(page) {
  const base = `http://127.0.0.1:${process.env.MM_BLOCK_BROWSER_TEST_PORT ?? "4175"}`;
  await page.goto(base, { waitUntil: "domcontentloaded" });
  await page.waitForFunction(() => window.markdownMint?.view);
  await page.evaluate((source) => {
    window.__markdownMintHarness.deliverExternal(source, "github");
    const api = window.markdownMint.vscode;
    const post = api.postMessage.bind(api);
    window.__alertConflictReview = { held: [] };
    api.postMessage = (message) => {
      if (message.type === "edit")
        window.__alertConflictReview.held.push(message);
      else post(message);
    };
  }, initial);
  const body = page.locator(bodySelector);
  await body.click();
  await page.keyboard.press("End");
  return body;
}

async function rejectPendingEdit(page) {
  await page.evaluate(() => {
    const edit = window.__alertConflictReview.held[0];
    const host = window.__markdownMintHarness.document;
    window.dispatchEvent(
      new MessageEvent("message", {
        data: {
          protocolVersion: 1,
          type: "edit-rejected",
          operationId: edit.operationId,
          reason: "stale",
          message: "A newer host document rejected this edit.",
          currentMarkdown: "Authoritative external replacement",
          currentVersion: host.version + 1,
          draftMarkdown: edit.markdown,
        },
      }),
    );
  });
}

async function snapshot(page) {
  return page.evaluate((selector) => {
    const body = document.querySelector(selector);
    return {
      body: body.value,
      readOnly: body.readOnly,
      disabled: body.disabled,
      focused: document.activeElement === body,
      source: window.markdownMint.sourceEl.value,
      recovery: window.__markdownMintHarness.state.recoveryDraft,
      sent: window.__alertConflictReview.held.length,
    };
  }, bodySelector);
}

/** Uses real key input plus Chromium's composition protocol; not an OS IME. */
export async function testAlertConflict(page) {
  await loadWithHeldEdits(page);
  await page.keyboard.type(" accepted before rejection");
  const before = await snapshot(page);
  assert.ok(before.body.endsWith(" accepted before rejection"));
  assert.equal(before.sent, 1, "the remaining input should still be queued");
  await rejectPendingEdit(page);
  const rejected = await snapshot(page);
  assert.equal(
    rejected.readOnly,
    true,
    "rejection did not lock native Alert input",
  );
  assert.equal(
    rejected.disabled,
    false,
    "locking should retain the copyable focused input",
  );
  assert.equal(rejected.focused, true);
  assert.equal(
    rejected.recovery,
    before.source,
    "rejection restored an older in-flight draft",
  );
  // No refocus or synthetic input: continue pressing real keys exactly where
  // the user was typing when the asynchronous rejection arrived.
  await page.keyboard.type(" UNSAVED-TEXT-MUST-NOT-APPEAR");
  const after = await snapshot(page);
  assert.deepEqual(
    after,
    rejected,
    "readonly Alert accepted unrecoverable input",
  );
  await page.screenshot({
    path: resolve(
      "output/playwright/block-editing/alert-conflict-readonly.png",
    ),
  });

  await loadWithHeldEdits(page);
  await page.keyboard.type(" pending ");
  const cdp = await page.context().newCDPSession(page);
  try {
    await cdp.send("Input.imeSetComposition", {
      text: "変換中",
      selectionStart: 3,
      selectionEnd: 3,
    });
    const composing = await snapshot(page);
    assert.ok(
      composing.body.includes("変換中"),
      "Chromium did not start native composition",
    );
    await rejectPendingEdit(page);
    const locked = await snapshot(page);
    assert.equal(locked.readOnly, true);
    assert.equal(locked.recovery, locked.source);
    assert.ok(locked.recovery.includes("変換中"));
    // Depending on Chromium, making an active composition readonly can finish
    // it immediately or leave a final IME delivery. Either accepted result must
    // be mirrored in the local document and recovery, with no further host edit.
    await cdp.send("Input.insertText", { text: "確定" });
    const finished = await snapshot(page);
    const expected = initial.replace("> body", `> ${finished.body}`);
    assert.equal(finished.source, expected);
    assert.equal(finished.recovery, expected);
    assert.equal(finished.sent, composing.sent);
    await page.keyboard.type(" BLOCKED");
    assert.deepEqual(await snapshot(page), finished);
    await page.screenshot({
      path: resolve(
        "output/playwright/block-editing/alert-conflict-composition.png",
      ),
    });
  } finally {
    await cdp.detach();
  }
}
