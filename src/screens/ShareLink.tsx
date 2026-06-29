import React, { useEffect } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import { ScreenContainer } from '@/components/ui/ScreenContainer';
import { useAuth } from '@/contexts/AuthContext';
import { getHostId } from '@/lib/auth';

/**
 * ShareLink — thin redirect hacia /meet/:id?share=1
 *
 * Responsabilidades:
 *  1. Esperar a que auth resuelva (no navegar con estado indeterminado).
 *  2. Preservar el contexto de hostId que DetailHost necesita.
 *  3. Redirigir de forma idempotente (replace:true) sin cargas innecesarias.
 *
 * Nota: La logica de compartir, OrganizerMessageSheet y el bloque de invitacion
 * estan integrados directamente en DetailHost.tsx, que ahora detecta ?share=1.
 */
const ShareLink: React.FC = () => {
  const { id } = useParams();
  const navigate = useNavigate();
  const { user, loading: authLoading } = useAuth();

  useEffect(() => {
    // Esperar que auth resuelva antes de navegar para no perder el hostId
    if (authLoading || !id) return;

    // El mapeo hostId (encuentroId → hostId) lo gestionará DetailHost
    // cuando cargue los datos reales del servidor (enc.host_id).
    // Aquí solo aseguramos que getHostId() haya inicializado el UUID anónimo.
    getHostId();

    navigate(`/meet/${id}?share=1`, { replace: true });
  }, [id, authLoading, user?.id]);

  // Pantalla minima mientras auth resuelve (evita flash)
  return (
    <ScreenContainer>
      <div className="pe-centered-loader">
        <p>Cargando…</p>
      </div>
    </ScreenContainer>
  );
};

export default ShareLink;
