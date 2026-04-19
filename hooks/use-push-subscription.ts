"use client";

import { useState, useEffect } from 'react';
import type { IJMAPClient } from '@/lib/jmap/client-interface';
import { useEmailStore } from '@/stores/email-store';
import { debug } from '@/lib/debug';

/**
 * Manages the JMAP push subscription lifecycle independently of data loading.
 *
 * Subscribes when authenticated with a live client; tears down only on
 * client change (account switch) or component unmount — never in response
 * to data-state changes like mailbox list population.
 */
export function usePushSubscription(
  client: IJMAPClient | null,
  isAuthenticated: boolean,
): boolean {
  const [connected, setConnected] = useState(false);
  const handleStateChange = useEmailStore((s) => s.handleStateChange);

  useEffect(() => {
    if (!isAuthenticated || !client) {
      setConnected(false);
      return;
    }

    client.onStateChange((change) => handleStateChange(change, client));
    const enabled = client.setupPushNotifications();
    setConnected(enabled);

    if (enabled) {
      debug.log('[Push] Subscription active');
    }

    return () => {
      client.closePushNotifications();
      setConnected(false);
    };
  }, [isAuthenticated, client, handleStateChange]);

  return connected;
}
