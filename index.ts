import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import registerPhoneExtension from "./src/extension/register-phone-extension";

export default function registerPiPhone(pi: ExtensionAPI) {
  registerPhoneExtension(pi);
}
