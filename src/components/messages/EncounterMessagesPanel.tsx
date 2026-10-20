import React, { useState, useEffect, useCallback, useRef } from 'react';
import { useTranslation } from 'react-i18next';
import {
  MessageSquare,
  Send,
  Pin,
  PinOff,
  Pencil,
  Trash2,
  CornerDownRight,
  X,
  AlertCircle,
  Clock,
} from 'lucide-react';
import { mensajesService } from '@/services/mensajesService';
import type { MensajeEncuentro } from '@/types/mensajes';
import './EncounterMessagesPanel.css';

export interface EncounterMessagesPanelProps {
  encuentroId: string;
  tokenInvitacion?: string;
  isHost?: boolean;
  isConfirmed?: boolean;
}

export const EncounterMessagesPanel: React.FC<EncounterMessagesPanelProps> = ({
  encuentroId,
  tokenInvitacion,
  isHost = false,
  isConfirmed = true,
}) => {
  const { t } = useTranslation();

  const [mensajes, setMensajes] = useState<MensajeEncuentro[]>([]);
  const [destacados, setDestacados] = useState<MensajeEncuentro[]>([]);
  const [canWrite, setCanWrite] = useState(true);
  const [writingWindowClosed, setWritingWindowClosed] = useState(false);
  const [loading, setLoading] = useState(true);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);
  const [specialState, setSpecialState] = useState<"retention_expired" | "purged" | "cancelled" | "unauthorized" | null>(null);

  // Formulario de envío
  const [nuevoMensaje, setNuevoMensaje] = useState('');
  const [enviando, setEnviando] = useState(false);
  const [replyingTo, setReplyingTo] = useState<MensajeEncuentro | null>(null);

  // Edición inline
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editingContent, setEditingContent] = useState('');
  const [savingEdit, setSavingEdit] = useState(false);

  // Referencias para evitar duplicados en polling
  const pollTimerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const isFetchingRef = useRef(false);
  const lastActivityRef = useRef(Date.now());
  const isIdleRef = useRef(false);

  const fetchMensajes = useCallback(async (showLoadingSpinner = false) => {
    if (!encuentroId || isFetchingRef.current) return;
    if (document.visibilityState !== 'visible') return;
    const targetEncuentroId = encuentroId;
    const targetToken = tokenInvitacion;

    try {
      isFetchingRef.current = true;
      if (showLoadingSpinner) setLoading(true);

      const res = await mensajesService.getMensajes(encuentroId, tokenInvitacion);

      // Guard against stale response if encounterId or token changed
      if (encuentroId !== targetEncuentroId || tokenInvitacion !== targetToken) return;

      if (res.ok) {
        setMensajes(res.mensajes || []);
        setDestacados(res.destacados || []);
        setCanWrite(res.can_write);
        setWritingWindowClosed(res.writing_window_closed);
        setSpecialState(null);
        setErrorMsg(null);
      } else {
        if (res.error === 'history_retention_expired') {
          setSpecialState('retention_expired');
          setCanWrite(false);
          setErrorMsg(null);
        } else if (res.error === 'history_purged') {
          setSpecialState('purged');
          setCanWrite(false);
          setErrorMsg(null);
        } else if (res.error === 'meeting_cancelled') {
          setSpecialState('cancelled');
          setCanWrite(false);
          setErrorMsg(null);
        } else if (
          res.error === 'participant_not_confirmed' ||
          res.error === 'blocked_user' ||
          res.error === 'unauthorized'
        ) {
          setSpecialState('unauthorized');
          setCanWrite(false);
          setErrorMsg(null);
        } else {
          setErrorMsg(res.error || 'Error cargando mensajes');
        }
      }
    } catch (err: any) {
      if (import.meta.env.DEV) console.error('[EncounterMessagesPanel] fetch error:', err);
    } finally {
      isFetchingRef.current = false;
      if (showLoadingSpinner) setLoading(false);
    }
  }, [encuentroId, tokenInvitacion]);

  // Carga inicial y configuración de Smart Polling: 20s (activo) y máx 45s (inactivo visible)
  useEffect(() => {
    if (!isConfirmed) {
      setLoading(false);
      return;
    }

    lastActivityRef.current = Date.now();
    isIdleRef.current = false;

    fetchMensajes(true);

    const startPolling = (cadence = 20000) => {
      if (pollTimerRef.current) clearInterval(pollTimerRef.current);
      if (document.visibilityState !== 'visible') return;

      pollTimerRef.current = setInterval(() => {
        if (document.visibilityState !== 'visible') {
          if (pollTimerRef.current) clearInterval(pollTimerRef.current);
          return;
        }

        const timeSinceActivity = Date.now() - lastActivityRef.current;
        const isIdleNow = timeSinceActivity > 180000;

        // Si cambió el estado de actividad, alternar entre 20s (activo) y 45s (inactivo)
        if (isIdleNow !== isIdleRef.current) {
          isIdleRef.current = isIdleNow;
          startPolling(isIdleNow ? 45000 : 20000);
        }

        fetchMensajes(false);
      }, cadence);
    };

    if (document.visibilityState === 'visible') {
      startPolling(20000);
    }

    const handleVisibilityChange = () => {
      if (document.visibilityState === 'visible') {
        isIdleRef.current = false;
        lastActivityRef.current = Date.now();
        fetchMensajes(false);
        startPolling(20000);
      } else {
        if (pollTimerRef.current) clearInterval(pollTimerRef.current);
      }
    };

    const handleFocus = () => {
      if (document.visibilityState === 'visible') {
        isIdleRef.current = false;
        lastActivityRef.current = Date.now();
        fetchMensajes(false);
        startPolling(20000);
      }
    };

    let lastInteraction = 0;
    const handleInteraction = () => {
      const now = Date.now();
      if (now - lastInteraction < 2000) return;
      lastInteraction = now;
      lastActivityRef.current = now;

      if (isIdleRef.current) {
        isIdleRef.current = false;
        if (document.visibilityState === 'visible') {
          fetchMensajes(false);
          startPolling(20000);
        }
      }
    };

    document.addEventListener('visibilitychange', handleVisibilityChange);
    window.addEventListener('focus', handleFocus);
    const interactionEvents = ['pointerdown', 'keydown', 'touchstart', 'scroll'] as const;
    interactionEvents.forEach((evt) => {
      window.addEventListener(evt, handleInteraction, { passive: true });
    });

    return () => {
      if (pollTimerRef.current) clearInterval(pollTimerRef.current);
      document.removeEventListener('visibilitychange', handleVisibilityChange);
      window.removeEventListener('focus', handleFocus);
      interactionEvents.forEach((evt) => {
        window.removeEventListener(evt, handleInteraction);
      });
    };
  }, [fetchMensajes, isConfirmed]);

  // Manejo de envío de nuevo mensaje
  const handlePublicar = async (e: React.FormEvent) => {
    e.preventDefault();
    const clean = nuevoMensaje.trim();
    if (!clean || clean.length > 500 || enviando || !canWrite) return;

    try {
      setEnviando(true);
      setErrorMsg(null);

      const res = await mensajesService.publicarMensaje(
        encuentroId,
        clean,
        replyingTo ? replyingTo.id : undefined,
        tokenInvitacion
      );

      if (res.ok) {
        setNuevoMensaje('');
        setReplyingTo(null);
        await fetchMensajes(false);
      } else {
        if (res.error === 'rate_limited') {
          setErrorMsg(t('encounter_messages.rate_limit_error', 'Alcanzaste el límite de 10 mensajes cada 5 minutos. Aguardá unos instantes.'));
        } else if (res.error === 'writing_window_closed') {
          setCanWrite(false);
          setWritingWindowClosed(true);
        } else {
          setErrorMsg(res.error || 'Error al publicar el mensaje');
        }
      }
    } catch (err: any) {
      setErrorMsg(err?.message || 'Error inesperado');
    } finally {
      setEnviando(false);
    }
  };

  // Manejo de edición
  const handleStartEdit = (msg: MensajeEncuentro) => {
    setEditingId(msg.id);
    setEditingContent(msg.contenido);
  };

  const handleSaveEdit = async (msgId: string) => {
    const clean = editingContent.trim();
    if (!clean || clean.length > 500 || savingEdit) return;

    try {
      setSavingEdit(true);
      setErrorMsg(null);

      const res = await mensajesService.editarMensaje(msgId, clean, tokenInvitacion);

      if (res.ok) {
        setEditingId(null);
        setEditingContent('');
        await fetchMensajes(false);
      } else {
        if (res.error === 'edit_window_expired') {
          setErrorMsg(t('encounter_messages.edit_expired_error', 'Solo podés editar mensajes durante los primeros 15 minutos.'));
        } else if (res.error === 'cannot_edit_highlighted_message') {
          setErrorMsg(t('encounter_messages.cannot_edit_highlighted', 'Este mensaje fue destacado por el organizador y no puede ser modificado.'));
        } else {
          setErrorMsg(res.error || 'Error al editar mensaje');
        }
      }
    } catch (err: any) {
      setErrorMsg(err?.message || 'Error inesperado al guardar');
    } finally {
      setSavingEdit(false);
    }
  };

  // Manejo de eliminación
  const handleDelete = async (msgId: string) => {
    const confirmDelete = window.confirm(
      t('encounter_messages.delete_confirm', '¿Seguro que querés eliminar este mensaje?')
    );
    if (!confirmDelete) return;

    try {
      const res = await mensajesService.eliminarMensaje(msgId, tokenInvitacion);
      if (res.ok) {
        await fetchMensajes(false);
      } else {
        alert(res.error || 'No se pudo eliminar el mensaje');
      }
    } catch (err: any) {
      alert(err?.message || 'Error al eliminar');
    }
  };

  // Manejo de destacado (Host)
  const handleToggleDestacado = async (msgId: string, currentDestacado: boolean) => {
    try {
      setErrorMsg(null);
      const res = await mensajesService.destacarMensaje(msgId, !currentDestacado);

      if (res.ok) {
        await fetchMensajes(false);
      } else {
        if (res.error === 'max_highlights_reached') {
          setErrorMsg(
            t('encounter_messages.max_highlights_error', 'Ya hay 3 mensajes destacados. Desmarcá uno antes de destacar otro.')
          );
        } else {
          setErrorMsg(res.error || 'Error al modificar destacado');
        }
      }
    } catch (err: any) {
      setErrorMsg(err?.message || 'Error al destacar');
    }
  };

  const formatTimestamp = (isoString: string): string => {
    try {
      const d = new Date(isoString);
      if (isNaN(d.getTime())) return '';
      return d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', hour12: false });
    } catch {
      return '';
    }
  };

  // Si el participante está pendiente
  if (!isConfirmed) {
    return (
      <section className="pe-msg-panel dh-fade-in" aria-label={t('encounter_messages.title', 'Información y mensajes')}>
        <header className="pe-msg-header">
          <div className="pe-msg-title-wrap">
            <div className="pe-msg-icon-badge">
              <MessageSquare size={18} />
            </div>
            <h2 className="pe-msg-title">{t('encounter_messages.title', 'Información y mensajes')}</h2>
          </div>
        </header>
        <div className="pe-msg-banner pe-msg-banner--info" role="status">
          <Clock size={18} />
          <span>{t('encounter_messages.guest_pending_prompt', 'Confirmá tu asistencia para participar en los mensajes de la organización.')}</span>
        </div>
      </section>
    );
  }


  if (specialState === 'retention_expired' || specialState === 'purged') {
    return (
      <section className="pe-msg-panel dh-fade-in" aria-label={t('encounter_messages.title', 'Información y mensajes')}>
        <header className="pe-msg-header">
          <div className="pe-msg-title-wrap">
            <div className="pe-msg-icon-badge">
              <MessageSquare size={18} />
            </div>
            <h2 className="pe-msg-title">{t('encounter_messages.title', 'Información y mensajes')}</h2>
          </div>
        </header>
        <div className="pe-msg-banner pe-msg-banner--info" role="status">
          <Clock size={18} />
          <span>
            {specialState === 'purged'
              ? t('encounter_messages.history_purged', 'El historial de mensajes de este encuentro ha sido purgado definitivamente.')
              : t('encounter_messages.history_retention_expired', 'El historial de mensajes ya no está disponible por haber alcanzado el límite de retención y privacidad.')}
          </span>
        </div>
      </section>
    );
  }

  if (specialState === 'cancelled') {
    return (
      <section className="pe-msg-panel dh-fade-in" aria-label={t('encounter_messages.title', 'Información y mensajes')}>
        <header className="pe-msg-header">
          <div className="pe-msg-title-wrap">
            <div className="pe-msg-icon-badge">
              <MessageSquare size={18} />
            </div>
            <h2 className="pe-msg-title">{t('encounter_messages.title', 'Información y mensajes')}</h2>
          </div>
        </header>
        <div className="pe-msg-banner pe-msg-banner--warning" role="status">
          <AlertCircle size={18} />
          <span>{t('encounter_messages.meeting_cancelled', 'El encuentro fue cancelado. Los mensajes y la logística ya no están disponibles.')}</span>
        </div>
      </section>
    );
  }

  if (specialState === 'unauthorized') {
    return (
      <section className="pe-msg-panel dh-fade-in" aria-label={t('encounter_messages.title', 'Información y mensajes')}>
        <header className="pe-msg-header">
          <div className="pe-msg-title-wrap">
            <div className="pe-msg-icon-badge">
              <MessageSquare size={18} />
            </div>
            <h2 className="pe-msg-title">{t('encounter_messages.title', 'Información y mensajes')}</h2>
          </div>
        </header>
        <div className="pe-msg-banner pe-msg-banner--warning" role="status">
          <AlertCircle size={18} />
          <span>{t('encounter_messages.unauthorized_access', 'No tenés acceso a los mensajes de este encuentro.')}</span>
        </div>
      </section>
    );
  }

  // Estructura de árbol de respuestas (1 nivel de profundidad)
  const rootMessages = mensajes.filter((m) => !m.parent_id);
  const replyMap: Record<string, MensajeEncuentro[]> = {};
  mensajes.forEach((m) => {
    if (m.parent_id) {
      if (!replyMap[m.parent_id]) replyMap[m.parent_id] = [];
      replyMap[m.parent_id].push(m);
    }
  });

  return (
    <section className="pe-msg-panel dh-fade-in" aria-label={t('encounter_messages.title', 'Información y mensajes')}>
      {/* Encabezado */}
      <header className="pe-msg-header">
        <div className="pe-msg-title-wrap">
          <div className="pe-msg-icon-badge">
            <MessageSquare size={18} />
          </div>
          <h2 className="pe-msg-title">{t('encounter_messages.title', 'Información y mensajes')}</h2>
        </div>
        <span className="pe-msg-count-pill">
          {mensajes.length} {mensajes.length === 1 ? 'mensaje' : 'mensajes'}
        </span>
      </header>

      {/* Banners de feedback / error */}
      {errorMsg && (
        <div className="pe-msg-banner pe-msg-banner--error" role="alert">
          <AlertCircle size={18} />
          <span>{errorMsg}</span>
        </div>
      )}

      {/* Banner de ventana de escritura cerrada */}
      {writingWindowClosed && (
        <div className="pe-msg-banner pe-msg-banner--warning" role="status">
          <Clock size={18} />
          <span>{t('encounter_messages.writing_window_closed', 'El período para enviar mensajes ha finalizado. El historial permanece en modo lectura.')}</span>
        </div>
      )}

      {/* SECCIÓN 1: Mensajes destacados */}
      {destacados.length > 0 && (
        <div className="pe-msg-destacados">
          <div className="pe-msg-destacados-header">
            <Pin size={14} />
            <span>{t('encounter_messages.highlighted_title', 'Mensajes destacados')} ({destacados.length}/3)</span>
          </div>
          {destacados.map((d) => (
            <article key={d.id} className="pe-msg-destacado-card">
              <div className="pe-msg-item-top">
                <div className="pe-msg-author-info">
                  <span className="pe-msg-author-name">{d.autor_nombre}</span>
                  {d.es_organizador && (
                    <span className="pe-msg-badge-host">{t('encounter_messages.host_badge', 'Organizador')}</span>
                  )}
                </div>
                {isHost && (
                  <button
                    type="button"
                    className="pe-msg-btn-action pe-msg-btn-action--pin"
                    onClick={() => handleToggleDestacado(d.id, true)}
                    title={t('encounter_messages.unpin_btn', 'Desmarcar')}
                  >
                    <PinOff size={13} />
                    <span>{t('encounter_messages.unpin_btn', 'Desmarcar')}</span>
                  </button>
                )}
              </div>
              <p className="pe-msg-content">{d.contenido}</p>
            </article>
          ))}
        </div>
      )}

      {/* SECCIÓN 2: Conversación del encuentro */}
      <div className="pe-msg-list">
        {loading ? (
          <div className="pe-msg-empty">
            <div className="pe-msg-spinner" style={{ borderColor: '#cbd5e1', borderTopColor: '#16a34a', width: 24, height: 24 }} />
            <p style={{ marginTop: 8 }}>Cargando conversación…</p>
          </div>
        ) : rootMessages.length === 0 ? (
          <div className="pe-msg-empty">
            <p>{t('encounter_messages.empty_state', 'No hay mensajes en este encuentro aún. Podés compartir información práctica o consultas para los participantes.')}</p>
          </div>
        ) : (
          rootMessages.map((msg) => {
            const replies = replyMap[msg.id] || [];

            return (
              <React.Fragment key={msg.id}>
                {/* Mensaje Padre (Nivel 0) */}
                <article className={`pe-msg-item ${msg.es_propio ? 'pe-msg-item--own' : ''}`}>
                  <div className="pe-msg-item-top">
                    <div className="pe-msg-author-info">
                      <span className="pe-msg-author-name">{msg.autor_nombre}</span>
                      {msg.es_organizador && (
                        <span className="pe-msg-badge-host">{t('encounter_messages.host_badge', 'Organizador')}</span>
                      )}
                      {msg.destacado && (
                        <span className="pe-msg-badge-destacado">
                          <Pin size={11} /> {t('encounter_messages.highlighted_badge', 'Destacado')}
                        </span>
                      )}
                    </div>
                    <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                      {msg.editado_en && <span className="pe-msg-edited">{t('encounter_messages.edited_indicator', '(editado)')}</span>}
                      <time className="pe-msg-time">{formatTimestamp(msg.creado_en)}</time>
                    </div>
                  </div>

                  {editingId === msg.id ? (
                    <div className="pe-msg-edit-box">
                      <textarea
                        className="pe-msg-edit-textarea"
                        value={editingContent}
                        maxLength={500}
                        onChange={(e) => setEditingContent(e.target.value)}
                        disabled={savingEdit}
                      />
                      <div className="pe-msg-edit-buttons">
                        <button
                          type="button"
                          className="pe-msg-btn-action"
                          onClick={() => setEditingId(null)}
                          disabled={savingEdit}
                        >
                          {t('encounter_messages.cancel_btn', 'Cancelar')}
                        </button>
                        <button
                          type="button"
                          className="pe-msg-btn-action"
                          style={{ color: '#16a34a', fontWeight: 700 }}
                          onClick={() => handleSaveEdit(msg.id)}
                          disabled={savingEdit || !editingContent.trim()}
                        >
                          {savingEdit ? 'Guardando…' : t('encounter_messages.save_btn', 'Guardar')}
                        </button>
                      </div>
                    </div>
                  ) : (
                    <p className={`pe-msg-content ${msg.eliminado ? 'pe-msg-content--deleted' : ''}`}>
                      {msg.eliminado
                        ? `[${t('encounter_messages.deleted_message', 'Este mensaje fue eliminado')}]`
                        : msg.contenido}
                    </p>
                  )}

                  {/* Acciones contextuales */}
                  {!msg.eliminado && editingId !== msg.id && (
                    <footer className="pe-msg-actions">
                      {canWrite && (
                        <button
                          type="button"
                          className="pe-msg-btn-action"
                          onClick={() => setReplyingTo(msg)}
                        >
                          <CornerDownRight size={13} />
                          <span>{t('encounter_messages.reply_btn', 'Responder')}</span>
                        </button>
                      )}

                      {msg.puede_editar && (
                        <button
                          type="button"
                          className="pe-msg-btn-action"
                          onClick={() => handleStartEdit(msg)}
                        >
                          <Pencil size={13} />
                          <span>{t('encounter_messages.edit_btn', 'Editar')}</span>
                        </button>
                      )}

                      {msg.puede_eliminar && (
                        <button
                          type="button"
                          className="pe-msg-btn-action pe-msg-btn-action--delete"
                          onClick={() => handleDelete(msg.id)}
                        >
                          <Trash2 size={13} />
                          <span>{t('encounter_messages.delete_btn', 'Eliminar')}</span>
                        </button>
                      )}

                      {isHost && (
                        <button
                          type="button"
                          className="pe-msg-btn-action pe-msg-btn-action--pin"
                          onClick={() => handleToggleDestacado(msg.id, msg.destacado)}
                        >
                          {msg.destacado ? <PinOff size={13} /> : <Pin size={13} />}
                          <span>{msg.destacado ? t('encounter_messages.unpin_btn', 'Desmarcar') : t('encounter_messages.pin_btn', 'Destacar')}</span>
                        </button>
                      )}
                    </footer>
                  )}
                </article>

                {/* Respuestas anidadas (Nivel 1) */}
                {replies.map((reply) => (
                  <article
                    key={reply.id}
                    className={`pe-msg-item pe-msg-item--reply ${reply.es_propio ? 'pe-msg-item--own' : ''}`}
                  >
                    <div className="pe-msg-item-top">
                      <div className="pe-msg-author-info">
                        <span className="pe-msg-author-name">{reply.autor_nombre}</span>
                        {reply.es_organizador && (
                          <span className="pe-msg-badge-host">{t('encounter_messages.host_badge', 'Organizador')}</span>
                        )}
                        {reply.destacado && (
                          <span className="pe-msg-badge-destacado">
                            <Pin size={11} /> {t('encounter_messages.highlighted_badge', 'Destacado')}
                          </span>
                        )}
                      </div>
                      <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                        {reply.editado_en && <span className="pe-msg-edited">{t('encounter_messages.edited_indicator', '(editado)')}</span>}
                        <time className="pe-msg-time">{formatTimestamp(reply.creado_en)}</time>
                      </div>
                    </div>

                    {editingId === reply.id ? (
                      <div className="pe-msg-edit-box">
                        <textarea
                          className="pe-msg-edit-textarea"
                          value={editingContent}
                          maxLength={500}
                          onChange={(e) => setEditingContent(e.target.value)}
                          disabled={savingEdit}
                        />
                        <div className="pe-msg-edit-buttons">
                          <button
                            type="button"
                            className="pe-msg-btn-action"
                            onClick={() => setEditingId(null)}
                            disabled={savingEdit}
                          >
                            {t('encounter_messages.cancel_btn', 'Cancelar')}
                          </button>
                          <button
                            type="button"
                            className="pe-msg-btn-action"
                            style={{ color: '#16a34a', fontWeight: 700 }}
                            onClick={() => handleSaveEdit(reply.id)}
                            disabled={savingEdit || !editingContent.trim()}
                          >
                            {savingEdit ? 'Guardando…' : t('encounter_messages.save_btn', 'Guardar')}
                          </button>
                        </div>
                      </div>
                    ) : (
                      <p className={`pe-msg-content ${reply.eliminado ? 'pe-msg-content--deleted' : ''}`}>
                        {reply.eliminado
                          ? `[${t('encounter_messages.deleted_message', 'Este mensaje fue eliminado')}]`
                          : reply.contenido}
                      </p>
                    )}

                    {!reply.eliminado && editingId !== reply.id && (
                      <footer className="pe-msg-actions">
                        {reply.puede_editar && (
                          <button
                            type="button"
                            className="pe-msg-btn-action"
                            onClick={() => handleStartEdit(reply)}
                          >
                            <Pencil size={13} />
                            <span>{t('encounter_messages.edit_btn', 'Editar')}</span>
                          </button>
                        )}

                        {reply.puede_eliminar && (
                          <button
                            type="button"
                            className="pe-msg-btn-action pe-msg-btn-action--delete"
                            onClick={() => handleDelete(reply.id)}
                          >
                            <Trash2 size={13} />
                            <span>{t('encounter_messages.delete_btn', 'Eliminar')}</span>
                          </button>
                        )}

                        {isHost && (
                          <button
                            type="button"
                            className="pe-msg-btn-action pe-msg-btn-action--pin"
                            onClick={() => handleToggleDestacado(reply.id, reply.destacado)}
                          >
                            {reply.destacado ? <PinOff size={13} /> : <Pin size={13} />}
                            <span>{reply.destacado ? t('encounter_messages.unpin_btn', 'Desmarcar') : t('encounter_messages.pin_btn', 'Destacar')}</span>
                          </button>
                        )}
                      </footer>
                    )}
                  </article>
                ))}
              </React.Fragment>
            );
          })
        )}
      </div>

      {/* SECCIÓN 3: Campo para escribir */}
      {canWrite && !writingWindowClosed && (
        <form className="pe-msg-composer" onSubmit={handlePublicar}>
          {replyingTo && (
            <div className="pe-msg-replying-pill">
              <span className="pe-msg-replying-text">
                <CornerDownRight size={14} style={{ display: 'inline', marginRight: 4, verticalAlign: -2 }} />
                <strong>{t('encounter_messages.replying_to', { name: replyingTo.autor_nombre })}:</strong> &ldquo;{replyingTo.contenido.slice(0, 35)}{replyingTo.contenido.length > 35 ? '…' : ''}&rdquo;
              </span>
              <button
                type="button"
                className="pe-msg-replying-cancel"
                onClick={() => setReplyingTo(null)}
                aria-label={t('encounter_messages.cancel_btn', 'Cancelar')}
              >
                <X size={14} />
              </button>
            </div>
          )}

          <div className="pe-msg-input-wrap">
            <textarea
              className="pe-msg-textarea"
              placeholder={t('encounter_messages.placeholder', 'Escribí una aclaración o consulta (máx. 500 caracteres)...')}
              value={nuevoMensaje}
              maxLength={500}
              onChange={(e) => setNuevoMensaje(e.target.value)}
              disabled={enviando}
              rows={3}
            />
          </div>

          <div className="pe-msg-composer-bottom">
            <span
              className={`pe-msg-char-counter ${
                nuevoMensaje.length >= 480 ? 'pe-msg-char-counter--limit' : ''
              }`}
            >
              {nuevoMensaje.length}/500
            </span>

            <button
              type="submit"
              className="pe-msg-send-btn"
              disabled={enviando || !nuevoMensaje.trim()}
            >
              {enviando ? (
                <>
                  <span className="pe-msg-spinner" />
                  <span>Publicando…</span>
                </>
              ) : (
                <>
                  <Send size={15} />
                  <span>{t('encounter_messages.send_btn', 'Publicar')}</span>
                </>
              )}
            </button>
          </div>
        </form>
      )}
    </section>
  );
};
