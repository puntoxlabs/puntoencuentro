import { useState, useEffect, useCallback, useRef } from 'react';
import { useAuth } from '../contexts/AuthContext';
import { checkQAAuthorization, QA_AUTH_TIMEOUT_MS } from '../services/qaAdminService';

export type QAAuthStatus = 'auth_loading' | 'checking' | 'authorized' | 'unauthorized' | 'error';

export interface UseQAAuthorizationResult {
  status: QAAuthStatus;
  retry: () => void;
  userId?: string | null;
  error?: string | null;
}

export const useQAAuthorization = (options?: { timeoutMs?: number }): UseQAAuthorizationResult => {
  const { user, isPermanentUser, isAnonymousUser, loading: authLoading } = useAuth();
  const [status, setStatus] = useState<QAAuthStatus>('auth_loading');
  const [errorMsg, setErrorMsg] = useState<string | null>(null);
  const checkCountRef = useRef(0);

  const verify = useCallback(async () => {
    // 1. Si la autenticación aún está resolviendo sesión inicial, esperar en auth_loading
    if (authLoading) {
      setStatus('auth_loading');
      return;
    }

    // 2. Si no hay usuario o es anónimo, denegar inmediatamente sin llamar a la RPC
    if (!user || isAnonymousUser || !isPermanentUser) {
      setStatus('unauthorized');
      return;
    }

    // 3. Usuario permanente autenticado: consultar RPC server-side con timeout defensivo
    const currentRun = ++checkCountRef.current;
    setStatus('checking');
    setErrorMsg(null);

    try {
      const isAuth = await checkQAAuthorization(options?.timeoutMs ?? QA_AUTH_TIMEOUT_MS);
      if (checkCountRef.current !== currentRun) return; // Stale check guard

      if (isAuth) {
        setStatus('authorized');
      } else {
        setStatus('unauthorized');
      }
    } catch (err: any) {
      if (checkCountRef.current !== currentRun) return;
      console.warn('[useQAAuthorization] Technical error verifying QA status:', err?.message || err);
      setErrorMsg(err?.message === 'qa_auth_timeout' ? 'timeout' : 'rpc_error');
      setStatus('error');
    }
  }, [authLoading, user, isPermanentUser, isAnonymousUser, options?.timeoutMs]);

  useEffect(() => {
    verify();
  }, [verify]);

  return {
    status,
    retry: verify,
    userId: user?.id ?? null,
    error: errorMsg,
  };
};
