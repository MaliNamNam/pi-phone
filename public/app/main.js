import { initializeBindings } from "./bindings.js";
import { handleAuthFailure, handleEnvelope } from "./handlers.js";
import { boot } from "./transport.js";

initializeBindings({ handleEnvelope, handleAuthFailure });
boot({ handleEnvelope, handleAuthFailure });
