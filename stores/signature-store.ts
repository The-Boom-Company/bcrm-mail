import { create } from 'zustand';

type SignaturePair = {
  html: string;
  text: string;
};

type AccountSignatures = {
  newEmail: SignaturePair | null;
  reply: SignaturePair | null;
};

interface SignatureState {
  /** Signatures keyed by account email address. */
  signatures: Map<string, AccountSignatures>;

  setSignatures: (email: string, sigs: AccountSignatures) => void;
  getSignatures: (email: string) => AccountSignatures | null;
  clearAll: () => void;
}

/**
 * Ephemeral (non-persisted) store for email signatures received
 * from the Pulse portal via postMessage during account setup.
 */
export const useSignatureStore = create<SignatureState>()((set, get) => ({
  signatures: new Map(),

  setSignatures: (email, sigs) => {
    set((state) => {
      const next = new Map(state.signatures);
      next.set(email, sigs);
      return { signatures: next };
    });
  },

  getSignatures: (email) => {
    return get().signatures.get(email) ?? null;
  },

  clearAll: () => {
    set({ signatures: new Map() });
  },
}));
