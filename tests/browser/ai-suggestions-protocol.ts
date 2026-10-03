import { isHostMessage, parseWebviewMessage } from "../../src/shared/protocol";

Object.assign(window, {
  __markdownMintAiProtocol: { isHostMessage, parseWebviewMessage },
});
