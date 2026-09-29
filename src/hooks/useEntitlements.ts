import { useState, useEffect, useCallback } from 'react';
import { supabase } from '@/lib/supabase';
import { useAuth } from '@/contexts/AuthContext';

export interface EntitlementsData {
  plan: string;
  authenticated: boolean;
  is_anonymous: boolean;
  capabilities: {
    ai_creation: boolean;
    recurring: boolean;
    habitual_groups: boolean;
    advanced_discovery: boolean;
  };
  limits: {
    ai_monthly_sessions: number | null;
    enforcement_enabled: boolean;
  };
  usage: {
    consumed: number;
    active_reserved: number;
    remaining_effective: number | null;
  };
  error?: string;
}

export function useEntitlements() {
  const { user, loading: authLoading } = useAuth();
  const [data, setData] = useState<EntitlementsData | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<Error | null>(null);

  const fetchEntitlements = useCallback(async () => {
    if (authLoading) return;
    setLoading(true);
    setError(null);
    try {
      const { data: result, error: rpcError } = await supabase.rpc('get_my_entitlements');
      if (rpcError) {
        throw rpcError;
      }
      setData(result as EntitlementsData);
    } catch (err: any) {
      console.error('[useEntitlements] Error fetching entitlements:', err);
      setError(err);
    } finally {
      setLoading(false);
    }
  }, [authLoading]);

  useEffect(() => {
    fetchEntitlements();
  }, [fetchEntitlements, user?.id, user?.is_anonymous]);

  return {
    data,
    loading,
    error,
    refresh: fetchEntitlements,
  };
}
