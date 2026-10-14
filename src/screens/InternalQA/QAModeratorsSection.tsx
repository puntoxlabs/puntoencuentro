import React, { useState, useEffect, useCallback } from 'react';
import { useNavigate } from 'react-router-dom';
import {
  checkModerationAdmin,
  checkModerationAuthorization,
  getModeratorsList,
  addModeratorByEmail,
  updateModeratorRole,
  revokeModerator,
} from '../../services/moderationAdminService';
import type { ModeratorUser } from '../../types/trust';
import { Button } from '../../components/ui/Button';

export const QAModeratorsSection: React.FC = () => {
  const navigate = useNavigate();
  const [isAdmin, setIsAdmin] = useState<boolean | null>(null);
  const [isModerator, setIsModerator] = useState<boolean>(false);
  const [moderators, setModerators] = useState<ModeratorUser[]>([]);
  const [loading, setLoading] = useState<boolean>(false);
  const [actionLoading, setActionLoading] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [successMsg, setSuccessMsg] = useState<string | null>(null);

  // Formulario de alta
  const [newEmail, setNewEmail] = useState('');
  const [newRole, setNewRole] = useState<'moderator' | 'admin'>('moderator');

  const checkPrivilegesAndLoad = useCallback(async () => {
    try {
      const [adminPerm, modPerm] = await Promise.all([
        checkModerationAdmin(),
        checkModerationAuthorization().catch(() => false),
      ]);
      setIsAdmin(adminPerm);
      setIsModerator(modPerm);

      if (adminPerm) {
        setLoading(true);
        const res = await getModeratorsList();
        if (res.ok) {
          setModerators(res.moderators);
        } else {
          setError(res.error || 'Error al cargar moderadores');
        }
        setLoading(false);
      }
    } catch (err: any) {
      console.warn('[QAModeratorsSection] Error loading moderators:', err);
      setIsAdmin(false);
    }
  }, []);

  useEffect(() => {
    checkPrivilegesAndLoad();
  }, [checkPrivilegesAndLoad]);

  const handleAddModerator = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);
    setSuccessMsg(null);
    const clean = newEmail.trim();
    if (!clean) return;

    setActionLoading('add');
    try {
      const res = await addModeratorByEmail(clean, newRole);
      if (res.ok) {
        setSuccessMsg(`Usuario ${clean} configurado exitosamente como ${newRole === 'admin' ? 'Administrador' : 'Moderador'}.`);
        setNewEmail('');
        const listRes = await getModeratorsList();
        if (listRes.ok) setModerators(listRes.moderators);
      } else {
        setError(res.message || res.error || 'No se pudo agregar al moderador');
      }
    } catch (err: any) {
      setError(err?.message || 'Error inesperado al agregar moderador');
    } finally {
      setActionLoading(null);
    }
  };

  const handleRoleChange = async (userId: string, currentRole: 'admin' | 'moderator') => {
    setError(null);
    setSuccessMsg(null);
    const targetRole = currentRole === 'admin' ? 'moderator' : 'admin';
    const confirmText = targetRole === 'admin'
      ? '¿Promover a este moderador a Administrador?'
      : '¿Degradar a este Administrador a rol Moderador?';

    if (!window.confirm(confirmText)) return;

    setActionLoading(`role-${userId}`);
    try {
      const res = await updateModeratorRole(userId, targetRole);
      if (res.ok) {
        setSuccessMsg('Rol actualizado exitosamente.');
        const listRes = await getModeratorsList();
        if (listRes.ok) setModerators(listRes.moderators);
      } else {
        setError(res.message || res.error || 'No se pudo actualizar el rol');
      }
    } catch (err: any) {
      setError(err?.message || 'Error al cambiar rol');
    } finally {
      setActionLoading(null);
    }
  };

  const handleRevoke = async (userId: string, email: string) => {
    setError(null);
    setSuccessMsg(null);
    if (!window.confirm(`¿Confirmás revocar el acceso de moderación a ${email}?`)) {
      return;
    }

    setActionLoading(`revoke-${userId}`);
    try {
      const res = await revokeModerator(userId);
      if (res.ok) {
        setSuccessMsg(`Acceso de ${email} revocado exitosamente.`);
        const listRes = await getModeratorsList();
        if (listRes.ok) setModerators(listRes.moderators);
      } else {
        setError(res.message || res.error || 'No se pudo revocar el acceso');
      }
    } catch (err: any) {
      setError(err?.message || 'Error al revocar acceso');
    } finally {
      setActionLoading(null);
    }
  };

  if (isAdmin === null) {
    return null; // Aún evaluando permisos
  }

  return (
    <div className="qa-moderators-section" style={{ marginTop: '24px', background: 'var(--color-surface, #fff)', borderRadius: '12px', padding: '20px', border: '1px solid var(--color-outline-variant, #E1E3EA)' }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '16px', flexWrap: 'wrap', gap: '12px' }}>
        <div>
          <h2 style={{ fontSize: '18px', fontWeight: 700, margin: 0, color: 'var(--color-on-surface, #0F1322)' }}>
            Moderadores
          </h2>
          <p style={{ margin: '4px 0 0 0', fontSize: '13px', color: 'var(--color-on-surface-variant, #6B7280)' }}>
            Gestión de permisos de Trust & Safety y moderación de contenido público.
          </p>
        </div>

        {/* Botón Ir a moderación SOLO si el usuario pasa is_moderation_authorized() */}
        {isModerator && (
          <Button
            variant="outline"
            onClick={() => navigate('/internal/moderation')}
            style={{ fontSize: '13px', padding: '8px 14px' }}
          >
            🛡️ Ir a moderación
          </Button>
        )}
      </div>

      {!isAdmin ? (
        <div style={{ fontSize: '13px', color: 'var(--color-on-surface-variant, #6B7280)', background: 'rgba(0,0,0,0.02)', padding: '12px', borderRadius: '8px' }}>
          Solo usuarios con privilegio administrativo pueden gestionar el equipo de moderadores.
        </div>
      ) : (
        <>
          {error && (
            <div style={{ padding: '10px 14px', background: '#FEE2E2', color: '#991B1B', borderRadius: '8px', fontSize: '13px', marginBottom: '14px' }}>
              {error}
            </div>
          )}

          {successMsg && (
            <div style={{ padding: '10px 14px', background: '#DCFCE7', color: '#166534', borderRadius: '8px', fontSize: '13px', marginBottom: '14px' }}>
              {successMsg}
            </div>
          )}

          {/* Formulario de Alta */}
          <form onSubmit={handleAddModerator} style={{ display: 'flex', gap: '10px', marginBottom: '20px', flexWrap: 'wrap', alignItems: 'center' }}>
            <input
              type="email"
              placeholder="correo@ejemplo.com"
              value={newEmail}
              onChange={(e) => setNewEmail(e.target.value)}
              required
              style={{
                flex: '1 1 240px',
                padding: '9px 12px',
                borderRadius: '8px',
                border: '1px solid var(--color-outline-variant, #D1D5DB)',
                fontSize: '14px',
              }}
            />
            <select
              value={newRole}
              onChange={(e) => setNewRole(e.target.value as 'moderator' | 'admin')}
              style={{
                padding: '9px 12px',
                borderRadius: '8px',
                border: '1px solid var(--color-outline-variant, #D1D5DB)',
                fontSize: '14px',
                background: '#fff',
              }}
            >
              <option value="moderator">Moderador</option>
              <option value="admin">Administrador</option>
            </select>
            <Button
              type="submit"
              variant="primary"
              disabled={actionLoading === 'add' || !newEmail.trim()}
              style={{ padding: '9px 16px', fontSize: '13px' }}
            >
              {actionLoading === 'add' ? 'Agregando...' : '+ Agregar'}
            </Button>
          </form>

          {/* Listado de Moderadores */}
          {loading ? (
            <div style={{ fontSize: '13px', color: 'var(--color-outline, #8E95A7)', padding: '16px 0' }}>Cargando moderadores...</div>
          ) : moderators.length === 0 ? (
            <div style={{ fontSize: '13px', color: 'var(--color-on-surface-variant, #6B7280)', padding: '12px 0' }}>
              No hay moderadores registrados. Podés agregar el primero ingresando su correo arriba.
            </div>
          ) : (
            <div style={{ overflowX: 'auto' }}>
              <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: '13px' }}>
                <thead>
                  <tr style={{ borderBottom: '1px solid var(--color-outline-variant, #E1E3EA)', textAlign: 'left', color: 'var(--color-on-surface-variant, #6B7280)' }}>
                    <th style={{ padding: '8px 10px' }}>Email</th>
                    <th style={{ padding: '8px 10px' }}>Rol</th>
                    <th style={{ padding: '8px 10px' }}>Estado</th>
                    <th style={{ padding: '8px 10px', textAlign: 'right' }}>Acciones</th>
                  </tr>
                </thead>
                <tbody>
                  {moderators.map((m) => {
                    const isBusy = actionLoading === `role-${m.user_id}` || actionLoading === `revoke-${m.user_id}`;
                    return (
                      <tr key={m.user_id} style={{ borderBottom: '1px solid rgba(0,0,0,0.05)', opacity: m.active ? 1 : 0.6 }}>
                        <td style={{ padding: '10px 10px', fontWeight: 500, color: 'var(--color-on-surface, #0F1322)' }}>
                          {m.email}
                        </td>
                        <td style={{ padding: '10px 10px' }}>
                          <span style={{
                            padding: '3px 8px',
                            borderRadius: '12px',
                            fontSize: '11px',
                            fontWeight: 600,
                            background: m.role === 'admin' ? '#EEF2FF' : '#F3F4F6',
                            color: m.role === 'admin' ? '#4F46E5' : '#4B5563',
                          }}>
                            {m.role === 'admin' ? 'Administrador' : 'Moderador'}
                          </span>
                        </td>
                        <td style={{ padding: '10px 10px' }}>
                          <span style={{
                            padding: '3px 8px',
                            borderRadius: '12px',
                            fontSize: '11px',
                            fontWeight: 600,
                            background: m.active ? '#ECFDF5' : '#FEF2F2',
                            color: m.active ? '#059669' : '#DC2626',
                          }}>
                            {m.active ? 'Activo' : 'Inactivo'}
                          </span>
                        </td>
                        <td style={{ padding: '10px 10px', textAlign: 'right' }}>
                          <div style={{ display: 'inline-flex', gap: '8px' }}>
                            {m.active && (
                              <button
                                type="button"
                                disabled={isBusy}
                                onClick={() => handleRoleChange(m.user_id, m.role)}
                                style={{
                                  background: 'none',
                                  border: '1px solid var(--color-outline-variant, #D1D5DB)',
                                  borderRadius: '6px',
                                  padding: '4px 8px',
                                  fontSize: '12px',
                                  cursor: isBusy ? 'not-allowed' : 'pointer',
                                  color: 'var(--color-on-surface, #374151)',
                                }}
                              >
                                {m.role === 'admin' ? 'Cambiar a Moderador' : 'Hacer Admin'}
                              </button>
                            )}
                            {m.active ? (
                              <button
                                type="button"
                                disabled={isBusy}
                                onClick={() => handleRevoke(m.user_id, m.email)}
                                style={{
                                  background: 'none',
                                  border: '1px solid #FCA5A5',
                                  borderRadius: '6px',
                                  padding: '4px 8px',
                                  fontSize: '12px',
                                  cursor: isBusy ? 'not-allowed' : 'pointer',
                                  color: '#DC2626',
                                }}
                              >
                                Revocar
                              </button>
                            ) : (
                              <button
                                type="button"
                                disabled={isBusy}
                                onClick={() => {
                                  setNewEmail(m.email);
                                  setNewRole(m.role);
                                }}
                                style={{
                                  background: 'none',
                                  border: '1px solid #D1D5DB',
                                  borderRadius: '6px',
                                  padding: '4px 8px',
                                  fontSize: '12px',
                                  cursor: 'pointer',
                                  color: 'var(--color-primary, #3B82F6)',
                                }}
                              >
                                Reactivar
                              </button>
                            )}
                          </div>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}
        </>
      )}
    </div>
  );
};
