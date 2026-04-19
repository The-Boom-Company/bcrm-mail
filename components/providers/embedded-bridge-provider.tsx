"use client";

import { useEffect, useRef } from "react";
import { generateAccountId } from "@/lib/account-utils";
import { isEmbedded, listenFromParent, notifyParent } from "@/lib/iframe-bridge";
import { getPathPrefix, getLocaleFromPath } from "@/lib/browser-navigation";
import { useAccountStore } from "@/stores/account-store";
import { useAuthStore } from "@/stores/auth-store";
import { useIdentityStore } from "@/stores/identity-store";
import { useSignatureStore } from "@/stores/signature-store";
import { useThemeStore } from "@/stores/theme-store";
import { injectThemeCSS, removeThemeCSS } from "@/lib/theme-loader";
import { useConfig, fetchConfig } from "@/hooks/use-config";
import { debug } from "@/lib/debug";

// Synchronous cleanup: runs at module load time (before any React render).
// Clears stale persisted auth/account data that would cause checkAuth()
// to attempt doomed session restores from a previous standalone-mode visit.
if (typeof window !== 'undefined' && (() => { try { return window.self !== window.top; } catch { return true; } })()) {
  for (const key of ['auth-storage', 'account-registry']) {
    try { localStorage.removeItem(key); } catch { /* noop */ }
  }
}

type SignaturePair = {
  html: string;
  text: string;
};

type PortalAccount = {
  email: string;
  token: string;
  displayName: string;
  isDefault: boolean;
  signatures?: {
    newEmail: SignaturePair | null;
    reply: SignaturePair | null;
  };
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

        const existingAccounts = useAccountStore.getState().accounts;

        // Purge stale account entries left over from a previous JMAP URL
        // (e.g. mail.bcrm.one → bcrm.app). Without this, the same mailbox
        // gets two entries with different IDs and switchAccount fails
        // because the stale entry has no live client.
        for (const account of defaultFirst) {
          const creds = decodeBasicToken(account.token);
          if (!creds) continue;
          const correctId = generateAccountId(creds.username, config.jmapServerUrl);
          const staleEntries = existingAccounts.filter(
            (a) => (a.email === account.email || a.username === creds.username) && a.id !== correctId,
          );
          for (const stale of staleEntries) {
            debug.log("Removing stale account entry:", stale.id, "→ replaced by", correctId);
            useAccountStore.getState().removeAccount(stale.id);
          }
        }

        for (const account of defaultFirst) {
          const creds = decodeBasicToken(account.token);
          if (!creds) {
            debug.error("Invalid token for", account.email);
            continue;
          }

          const accountId = generateAccountId(creds.username, config.jmapServerUrl);
          const alreadyRegistered = existingAccounts.some(
            (a) => a.id === accountId || a.email === account.email,
          );

          // An account entry may exist in the persisted store from a previous
          // page load, but without a live JMAP client it's useless.  Only skip
          // login() when the auth store already has a connected client.
          const hasLiveClient =
            alreadyRegistered &&
            useAuthStore.getState().isAuthenticated &&
            !!useAuthStore.getState().client;

          if (hasLiveClient) {
            if (!firstSuccess) firstSuccess = true;
            useAccountStore.getState().updateAccount(accountId, {
              email: account.email,
              displayName: account.displayName || account.email,
              label: account.displayName || account.email,
            });
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
            if (success) {
              if (!firstSuccess) firstSuccess = true;

              useAccountStore.getState().updateAccount(accountId, {
                email: account.email,
                displayName: account.displayName || account.email,
                label: account.displayName || account.email,
              });

              const identities = useIdentityStore.getState().identities;
              if (identities.length > 0) {
                const patched = identities.map((id) => {
                  if (!id.email || id.email === creds.username) {
                    return { ...id, email: account.email };
                  }
                  return id;
                });
                useIdentityStore.getState().setIdentities(patched);
              }
            }
          } catch (err) {
            debug.error("Failed to setup account:", account.email, err);
          }
        }

        for (const account of defaultFirst) {
          if (account.signatures) {
            useSignatureStore.getState().setSignatures(account.email, account.signatures);
          }
        }

        if (firstSuccess) {
          // Sequential logins leave the last account active. Directly
          // activate the default account's client without going through
          // the full switchAccount machinery (which can race with user clicks).
          const defaultEntry = defaultFirst[0];
          if (defaultEntry && defaultFirst.length > 1) {
            const defaultCreds = decodeBasicToken(defaultEntry.token);
            if (defaultCreds) {
              const defaultId = generateAccountId(defaultCreds.username, config.jmapServerUrl!);
              const currentActive = useAuthStore.getState().activeAccountId;
              if (currentActive !== defaultId) {
                const defaultClient = useAuthStore.getState().getClientForAccount(defaultId);
                if (defaultClient) {
                  const defaultAcct = useAccountStore.getState().getAccountById(defaultId);
                  useAccountStore.getState().setActiveAccount(defaultId);
                  useAuthStore.setState({
                    activeAccountId: defaultId,
                    client: defaultClient,
                    serverUrl: defaultAcct?.serverUrl ?? config.jmapServerUrl!,
                    username: defaultAcct?.username ?? defaultCreds.username,
                    isAuthenticated: true,
                    isLoading: false,
                  });
                }
              }
            }
          }

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

        case "portal:switch-account": {
          const email = msg.email as string | undefined;
          if (email) {
            const accounts = useAccountStore.getState().accounts;
            const match = accounts.find(
              (a) => a.email === email || a.username === email,
            );
            if (match) {
              useAuthStore.getState().switchAccount(match.id);
            }
          }
          break;
        }

        case "sso:trigger-login": {
          const prefix = getPathPrefix();
          const locale = getLocaleFromPath();
          window.location.href = `${prefix}/${locale}/login`;
          break;
        }

        case "portal:logout":
        case "sso:trigger-logout":
          logout();
          break;

        case "bcrm:set-palette": {
          const paletteId = msg.paletteId as string | null | undefined;
          const css = msg.css as string | null | undefined;
          if (css) {
            injectThemeCSS(css);
            // Mark portal as the theme authority so initializeTheme() and
            // async IndexedDB loads don't overwrite the portal CSS.
            useThemeStore.setState({ activeThemeId: null, portalThemeActive: true });
          } else if (paletteId) {
            const themeId = `bcrm-${paletteId}`;
            useThemeStore.getState().activateTheme(themeId);
          } else {
            removeThemeCSS();
            useThemeStore.getState().activateTheme(null);
          }
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
