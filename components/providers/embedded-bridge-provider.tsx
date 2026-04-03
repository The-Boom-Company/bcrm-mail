"use client";

import { useEffect, useRef } from "react";
import { isEmbedded, listenFromParent, notifyParent } from "@/lib/iframe-bridge";
import { getPathPrefix, getLocaleFromPath } from "@/lib/browser-navigation";
import { useAuthStore } from "@/stores/auth-store";
import { useConfig, fetchConfig } from "@/hooks/use-config";
import { debug } from "@/lib/debug";

/**
 * Decodes a Base64 Basic auth token into username and password.
 * Token format: base64("principalName:secret")
 */
function decodeBasicToken(token: string): { username: string; password: string } | null {
  try {
    const decoded = atob(token);
    const colonIdx = decoded.indexOf(":");
    if (colonIdx === -1) return null;
    return {
      username: decoded.substring(0, colonIdx),
      password: decoded.substring(colonIdx + 1),
    };
  } catch {
    return null;
  }
}

export function EmbeddedBridgeProvider({ children }: { children: React.ReactNode }) {
  const { parentOrigin, embeddedMode } = useConfig();
  const logout = useAuthStore((s) => s.logout);
  const login = useAuthStore((s) => s.login);
  const loginInFlight = useRef(false);

  useEffect(() => {
    if (!embeddedMode || !isEmbedded()) return;

    const unsubscribe = listenFromParent((msg) => {
      switch (msg.type) {
        case "portal:set-credentials": {
          const token = msg.token as string | undefined;
          if (!token || loginInFlight.current) break;

          const creds = decodeBasicToken(token);
          if (!creds) {
            debug.error("Invalid Basic auth token from portal");
            notifyParent("sso:auth-failure", { error: "invalid_token" });
            break;
          }

          loginInFlight.current = true;

          fetchConfig()
            .then((config) => {
              if (!config.jmapServerUrl) {
                throw new Error("JMAP server URL not configured");
              }
              return login(config.jmapServerUrl, creds.username, creds.password);
            })
            .then((success) => {
              if (success) {
                notifyParent("sso:auth-success", { username: creds.username });
              } else {
                notifyParent("sso:auth-failure", { error: "login_failed" });
              }
            })
            .catch((err) => {
              debug.error("Portal credential login failed:", err);
              notifyParent("sso:auth-failure", { error: "login_failed" });
            })
            .finally(() => {
              loginInFlight.current = false;
            });
          break;
        }

        case "sso:trigger-login": {
          const prefix = getPathPrefix();
          const locale = getLocaleFromPath();
          window.location.href = `${prefix}/${locale}/login`;
          break;
        }

        case "sso:trigger-logout":
          logout();
          break;
      }
    }, parentOrigin || undefined);

    return unsubscribe;
  }, [embeddedMode, parentOrigin, logout, login]);

  return <>{children}</>;
}
