/**
 * Sends uncaught JS errors and unhandled promise rejections to the admin error log.
 */

import { Platform } from "react-native";
import { reportClientError } from "./api";

let installed = false;

export function installErrorReporting(): void {
  if (installed) return;
  installed = true;

  if (Platform.OS === "web") {
    if (typeof window === "undefined") return;
    window.addEventListener("error", (event) => {
      reportClientError({
        kind: "crash",
        message: event.message || String(event.error),
        stack: event.error?.stack,
        screen: window.location?.pathname,
      });
    });
    window.addEventListener("unhandledrejection", (event) => {
      const reason: any = event.reason;
      reportClientError({
        kind: "error",
        message: `Unhandled promise rejection: ${reason?.message || String(reason)}`,
        stack: reason?.stack,
        screen: window.location?.pathname,
      });
    });
    return;
  }

  const errorUtils = (globalThis as any).ErrorUtils;
  if (!errorUtils?.getGlobalHandler) return;
  const previous = errorUtils.getGlobalHandler();
  errorUtils.setGlobalHandler((error: any, isFatal?: boolean) => {
    reportClientError({
      kind: isFatal ? "crash" : "error",
      message: error?.message || String(error),
      stack: error?.stack,
    });
    previous?.(error, isFatal);
  });
}
