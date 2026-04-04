"use client";

import { useEffect, useRef } from "react";
import { isEmbedded, listenFromParent, notifyParent } from "@/lib/iframe-bridge";
import { getPathPrefix, getLocaleFromPath } from "@/lib/browser-navigation";
import { useAuthStore } from "@/stores/auth-store";
import { useThemeStore } from "@/stores/theme-store";
import { useConfig, fetchConfig } from "@/hooks/use-config";
import { debug } from "@/lib/debug";

type PortalAccount = {
  email: string;
  token: string;
  displayName: string;
  isDefault: boolean;
};

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

    const handleSingleCredential = (token: string) => {
      if (loginInFlight.current) return;

      const creds = decodeBasicToken(token);
      if (!creds) {
        debug.error("Invalid Basic auth token from portal");
        notifyParent("sso:auth-failure", { error: "invalid_token" });
        return;
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
    };

    /**
     * Bulk account setup: logs into each account sequentially so
     * Bulwark's native multi-account switcher has all accounts
     * registered. The default (or first) account becomes active.
     */
    const handleSetupAccounts = async (accounts: PortalAccount[]) => {
      if (loginInFlight.current || !accounts?.length) return;
      loginInFlight.current = true;

      try {
        const config = await fetchConfig();
        if (!config.jmapServerUrl) {
          throw new Error("JMAP server URL not configured");
        }

        const defaultFirst = [...accounts].sort((a, b) => {
          if (a.isDefault && !b.isDefault) return -1;
          if (!a.isDefault && b.isDefault) return 1;
          return 0;
        });

        let firstSuccess = false;

        for (const account of defaultFirst) {
          const creds = decodeBasicToken(account.token);
          if (!creds) {
            debug.error("Invalid token for", account.email);
            continue;
          }

          try {
            const success = await login(
              config.jmapServerUrl,
              creds.username,
              creds.password,
              undefined,
              false,
            );
            if (success && !firstSuccess) {
              firstSuccess = true;
            }
          } catch (err) {
            debug.error("Failed to setup account:", account.email, err);
          }
        }

        if (firstSuccess) {
          notifyParent("sso:auth-success", { accounts: defaultFirst.length });
        } else {
          notifyParent("sso:auth-failure", { error: "all_accounts_failed" });
        }
      } catch (err) {
        debug.error("Bulk account setup failed:", err);
        notifyParent("sso:auth-failure", { error: "setup_failed" });
      } finally {
        loginInFlight.current = false;
      }
    };

    const unsubscribe = listenFromParent((msg) => {
      switch (msg.type) {
        case "portal:setup-accounts": {
          const accounts = msg.accounts as PortalAccount[] | undefined;
          if (accounts) handleSetupAccounts(accounts);
          break;
        }

        case "portal:set-credentials": {
          const token = msg.token as string | undefined;
          if (token) handleSingleCredential(token);
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

        case "bcrm:set-palette": {
          const paletteId = msg.paletteId as string | null | undefined;
          const themeId = paletteId ? `bcrm-${paletteId}` : null;
          useThemeStore.getState().activateTheme(themeId);
          break;
        }

        case "bcrm:set-appearance": {
          const mode = msg.mode as "light" | "dark" | undefined;
          if (mode) useThemeStore.getState().setTheme(mode);
          break;
        }
      }
    }, parentOrigin || undefined);

    notifyParent("bcrm-mail:ready");

    return unsubscribe;
  }, [embeddedMode, parentOrigin, logout, login]);

  return <>{children}</>;
}
