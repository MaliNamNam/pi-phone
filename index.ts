import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import registerPhoneChildExtension from "./src/extension/register-phone-child-extension";
import registerPhoneExtension from "./src/extension/register-phone-extension";

export default function registerPiPhone(pi: ExtensionAPI) {
  if (process.env.PI_PHONE_CHILD === "1") {
    registerPhoneChildExtension(pi);
    return;
  }

  registerPhoneExtension(pi);
}
