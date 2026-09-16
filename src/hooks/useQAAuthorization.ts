import { useState, useEffect } from 'react';
import { checkQAAuthorization } from '../services/qaAdminService';

export type QAAuthStatus = 'checking' | 'authorized' | 'unauthorized' | 'error';

export const useQAAuthorization = () => {
  const [status, setStatus] = useState<QAAuthStatus>('checking');

  useEffect(() => {
    let mounted = true;
    
    const verify = async () => {
      try {
        const isAuth = await checkQAAuthorization();
        if (!mounted) return;
        setStatus(isAuth ? 'authorized' : 'unauthorized');
      } catch (err) {
        if (!mounted) return;
        setStatus('error');
      }
    };

    verify();

    return () => {
      mounted = false;
    };
  }, []);

  return { status };
};
