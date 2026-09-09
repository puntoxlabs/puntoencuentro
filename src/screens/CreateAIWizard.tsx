import React, { useState, useEffect, useRef } from 'react';
import { useNavigate } from 'react-router-dom';
import { Send, RefreshCw, AlertCircle, ChevronDown, ChevronUp, Sparkles, CheckCircle2 } from 'lucide-react';
import { AppBar } from '@/components/ui/AppBar';
import { ScreenContainer } from '@/components/ui/ScreenContainer';
import { AIChatMessage } from '@/components/ai/AIChatMessage';
import { FieldQuestion } from '@/components/ai/FieldQuestion';
import { DraftSummary } from '@/components/ai/DraftSummary';
import { useAiWizardStore } from '@/store/aiWizardStore';
import { useWizardStore } from '@/store/wizardStore';
import { useCoordinationWizardStore } from '@/store/coordinationWizardStore';
import { translateToCreateEncuentroDTO, draftToWizardState, draftToCoordinationDraft } from '@/lib/encounterDraft';
import { getPostEventMinutes } from '@/lib/preferencesStorage';
import { rememberEncuentroHost } from '@/lib/meetHostsStorage';
import { encuentrosService } from '@/services/encuentrosService';
import { ensureHostSession } from '@/lib/ensureHostSession';
import { aiService } from '@/services/aiService';
import {
  INVITATION_THEMES,
  getTemplateOptionsForTheme,
  getDefaultInvitationTemplate,
} from '@/lib/invitationThemes';
import { formatFriendlyDate } from '@/lib/formatDate';
import './CreateWizard.css';

export interface CreateAIWizardProps {
  stateOverride?: Partial<ReturnType<typeof useAiWizardStore.getState>>;
}

export const CreateAIWizard: React.FC<CreateAIWizardProps> = ({ stateOverride }) => {
  const navigate = useNavigate();
  const [inputText, setInputText] = useState('');
  const [isCreating, setIsCreating] = useState(false);
  const [creationError, setCreationError] = useState<string | null>(null);
  const [isSummaryExpanded, setIsSummaryExpanded] = useState(false);

  const chatContainerRef = useRef<HTMLDivElement>(null);
  const latestAssistantMessageRef = useRef<HTMLDivElement>(null);
  const latestUserMessageRef = useRef<HTMLDivElement>(null);
  const activeQuestionRef = useRef<HTMLDivElement>(null);
  const completeSummaryRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);

  const hookState = useAiWizardStore();
  const store = typeof window === 'undefined' ? useAiWizardStore.getState() : hookState;
  const activeState = stateOverride ? { ...store, ...stateOverride } : store;

  const {
    sessionId,
    draft,
    config,
    messages,
    turns,
    totalInputTokens,
    totalOutputTokens,
    totalLatencyMs,
    primaryLatencyMs,
    fallbackLatencyMs,
    fallbackUsed,
    primaryProvider,
    fallbackProvider,
    providerUsed,
    modelUsed,
    primaryFailureType,
    fallbackFailureType,
    startedAt,
    isInterpreting,
    aiLocked,
    error: aiError,
    lastQuestion,
    isComplete,
    initSession,
    sendUserMessage,
    updateDraftField,
    applyQuickOption,
    updateConfigField,
    dismissCoordinationHandoff,
    markFallbackManual,
    reset,
  } = activeState;

  const hasDraftData = Boolean(
    draft.title ||
    draft.date ||
    draft.time ||
    draft.modality ||
    draft.locationText ||
    draft.virtualLink
  );

  const activeThemeConfig = INVITATION_THEMES.find((t) => t.id === config.invitationTheme);
  const themeTemplates = getTemplateOptionsForTheme(config.invitationTheme);
  const defaultTemplate = getDefaultInvitationTemplate(config.invitationTheme);
  const activeTemplate = themeTemplates.find(
    (t) => t.id === (config.invitationTemplate || defaultTemplate)
  );
  const themeLabel = activeThemeConfig?.label || 'Clásico';
  const variantLabel = activeTemplate ? ` (${activeTemplate.name})` : '';

  const dateText = draft.date
    ? `${formatFriendlyDate(draft.date, draft.time || '').split('•')[0]}${draft.time ? ` · ${draft.time} hs` : ''}`
    : draft.time
    ? `${draft.time} hs`
    : 'Cuándo a definir';

  const placeText = draft.locationText || (draft.modality === 'virtual' ? 'Virtual' : draft.modality === 'presencial' ? 'Presencial' : null);

  const lastAssistantIndex = messages.map((m) => m.role).lastIndexOf('assistant');
  const lastUserIndex = messages.map((m) => m.role).lastIndexOf('user');

  const prevMessagesCountRef = useRef(messages.length);
  const prevInterpretingRef = useRef(isInterpreting);

  useEffect(() => {
    initSession();
  }, [initSession]);

  useEffect(() => {
    const container = chatContainerRef.current;
    if (!container) return;

    const prevCount = prevMessagesCountRef.current;
    const currentCount = messages.length;

    prevMessagesCountRef.current = currentCount;
    prevInterpretingRef.current = isInterpreting;

    // 1. User just sent a message or interpreting is ongoing
    if (isInterpreting || (currentCount > prevCount && messages[currentCount - 1]?.role === 'user')) {
      if (latestUserMessageRef.current) {
        const containerRect = container.getBoundingClientRect();
        const userRect = latestUserMessageRef.current.getBoundingClientRect();
        const relativeTop = userRect.top - containerRect.top + container.scrollTop;
        container.scrollTo({
          top: Math.max(0, relativeTop - 16),
          behavior: 'smooth',
        });
      }
      return;
    }

    // 2. AI response arrived (interpreting ended and last message is assistant)
    if (!isInterpreting && currentCount > 0 && messages[currentCount - 1]?.role === 'assistant') {
      const target = latestAssistantMessageRef.current;
      if (target) {
        const containerRect = container.getBoundingClientRect();
        const targetRect = target.getBoundingClientRect();
        const relativeTop = targetRect.top - containerRect.top + container.scrollTop;
        container.scrollTo({
          top: Math.max(0, relativeTop - 12),
          behavior: 'smooth',
        });
      }
      return;
    }

    // 3. Question or completion appeared without a new message
    if (!isInterpreting && (lastQuestion || isComplete)) {
      const target = activeQuestionRef.current || completeSummaryRef.current;
      if (target) {
        const containerRect = container.getBoundingClientRect();
        const targetRect = target.getBoundingClientRect();
        if (targetRect.bottom > containerRect.bottom) {
          const relativeBottom = targetRect.bottom - containerRect.top + container.scrollTop;
          container.scrollTo({
            top: relativeBottom - containerRect.height + 24,
            behavior: 'smooth',
          });
        }
      }
    }
  }, [messages, isInterpreting, lastQuestion, isComplete]);

  const handleReset = () => {
    setIsSummaryExpanded(false);
    reset();
  };

  const handleSend = async () => {
    if (!inputText.trim() || isInterpreting || isCreating || aiLocked) return;
    const text = inputText;
    setInputText('');
    await sendUserMessage(text);
  };

  const handleKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      if (!aiLocked) {
        handleSend();
      }
    }
  };

  const handleQuickOptionSelect = async (value: string) => {
    if (value === 'keep_fixed') {
      dismissCoordinationHandoff();
      setTimeout(() => inputRef.current?.focus(), 100);
      return;
    }

    if (lastQuestion) {
      const option = lastQuestion.quickOptions?.find((opt) => opt.value === value);
      const rawLabel = option?.label || value;
      const displayLabel = rawLabel.replace(/^[^\p{L}\p{N}]+\s*/u, '').trim() || value;

      if (lastQuestion.field === 'modality') {
        applyQuickOption('modality', value as 'presencial' | 'virtual', displayLabel);
        setTimeout(() => inputRef.current?.focus(), 100);
        return;
      }

      if (lastQuestion.field === 'date' || lastQuestion.field === 'time') {
        applyQuickOption(lastQuestion.field, value, displayLabel);
        setTimeout(() => inputRef.current?.focus(), 100);
        return;
      }

      if (lastQuestion.field === 'template' || lastQuestion.field === 'theme') {
        applyQuickOption(lastQuestion.field, value, displayLabel);
        setTimeout(() => inputRef.current?.focus(), 100);
        return;
      }
    }

    // Otherwise submit as conversational response
    if (aiLocked) return;
    await sendUserMessage(value);
  };

  const handleHandoffCoordination = () => {
    const coordDraft = draftToCoordinationDraft(draft, config);
    useCoordinationWizardStore.getState().updateDraft(coordDraft);
    aiService.finishSession({
      sessionId,
      status: 'fallback_manual',
      turns,
      inputTokens: totalInputTokens,
      outputTokens: totalOutputTokens,
      latencyMs: totalLatencyMs,
      elapsedMs: Date.now() - startedAt,
      provider: providerUsed || primaryProvider,
      model: modelUsed || undefined,
      metadata: {
        fallbackUsed,
        primaryProvider,
        fallbackProvider: fallbackProvider || undefined,
        providerUsed: providerUsed || undefined,
        modelUsed: modelUsed || undefined,
        primaryLatencyMs,
        fallbackLatencyMs,
        totalLatencyMs,
        primaryFailureType: primaryFailureType || undefined,
        fallbackFailureType: fallbackFailureType || undefined,
      },
    });
    navigate('/create/coordination');
  };

  const handleFallbackManual = () => {
    const wizardPartial = draftToWizardState(draft, config);
    const wizardStore = useWizardStore.getState();

    // Copy all gathered fields into the manual wizard
    Object.entries(wizardPartial).forEach(([key, val]) => {
      wizardStore.setField(key, val);
    });

    markFallbackManual();
    navigate('/create');
  };

  const handleConfirmCreate = async () => {
    if (isCreating) return;
    setIsCreating(true);
    setCreationError(null);

    try {
      // 1. Ensure authenticated host session (anonymous or permanent)
      const hostSession = await ensureHostSession();
      const hostId = hostSession.user.id;

      // 2. Check for replacement reference in sessionStorage
      let replacesEncounterId: string | null = null;
      try {
        const cancelRef = sessionStorage.getItem('cancel_reference');
        if (cancelRef) {
          const parsed = JSON.parse(cancelRef);
          replacesEncounterId = parsed.fromId || parsed.oldId || null;
        }
      } catch (e) {
        console.warn('Error reading cancel_reference:', e);
      }

      // 3. Assemble DTO deterministically
      const creationMeta = {
        hostId,
        replacesEncounterId,
        postEventActiveMinutes: getPostEventMinutes(),
      };

      const dto = translateToCreateEncuentroDTO(draft, config, creationMeta);

      // 4. Create encounter via existing RPC mechanism
      const result = await encuentrosService.createEncuentro(dto);

      if (!result || !result.id) {
        throw new Error('No se recibió el identificador del encuentro creado');
      }

      const encounterId = result.id;

      // 5. Store encounter host association in local storage
      rememberEncuentroHost(encounterId, hostId);

      // 6. Record completion telemetry (Ajuste 1: minimum privilege RPC)
      aiService.finishSession({
        sessionId,
        status: 'completed',
        encounterId,
        turns,
        inputTokens: totalInputTokens,
        outputTokens: totalOutputTokens,
        latencyMs: totalLatencyMs,
        elapsedMs: Date.now() - startedAt,
        provider: providerUsed || primaryProvider,
        model: modelUsed || undefined,
        metadata: {
          fallbackUsed,
          primaryProvider,
          fallbackProvider: fallbackProvider || undefined,
          providerUsed: providerUsed || undefined,
          modelUsed: modelUsed || undefined,
          primaryLatencyMs,
          fallbackLatencyMs,
          totalLatencyMs,
          primaryFailureType: primaryFailureType || undefined,
          fallbackFailureType: fallbackFailureType || undefined,
        },
      });

      // Clear AI session upon success
      reset();

      // Clean up replacement reference if any
      sessionStorage.removeItem('cancel_reference');

      // 7. Redirect to guest/sharing screen based on invitation type (matching manual wizard)
      if (config.invitationType === 'individual') {
        navigate(`/add-guests/${encounterId}`, { replace: true });
      } else {
        navigate(`/share/${encounterId}`, { replace: true });
      }
    } catch (err: any) {
      console.error('[CreateAIWizard] Error creating encounter:', err);
      const errorMessage = err?.message || 'Error al guardar el encuentro. Podés continuar en el formulario manual.';
      setCreationError(errorMessage);

      aiService.finishSession({
        sessionId,
        status: 'error',
        turns,
        inputTokens: totalInputTokens,
        outputTokens: totalOutputTokens,
        latencyMs: totalLatencyMs,
        elapsedMs: Date.now() - startedAt,
        errorType: errorMessage,
        provider: providerUsed || primaryProvider,
        model: modelUsed || undefined,
        metadata: {
          fallbackUsed,
          primaryProvider,
          fallbackProvider: fallbackProvider || undefined,
          providerUsed: providerUsed || undefined,
          modelUsed: modelUsed || undefined,
          primaryLatencyMs,
          fallbackLatencyMs,
          totalLatencyMs,
          primaryFailureType: primaryFailureType || undefined,
          fallbackFailureType: fallbackFailureType || undefined,
        },
      });
    } finally {
      setIsCreating(false);
    }
  };

  return (
    <ScreenContainer style={{ display: 'flex', flexDirection: 'column', height: '100dvh', padding: 0 }}>
      {/* AppBar */}
      <AppBar
        title="Crear con IA"
        subtitle="Beta"
        showBack
        onBack={() => {
          if (messages.length > 0 && !isComplete) {
            if (window.confirm('¿Querés salir? Tu borrador se conservará mientras no cierres la pestaña.')) {
              navigate(-1);
            }
          } else {
            navigate(-1);
          }
        }}
        rightAction={
          <button
            onClick={handleReset}
            style={{
              background: 'none',
              border: 'none',
              color: 'var(--color-on-surface-variant, #64748b)',
              cursor: 'pointer',
              padding: '6px',
            }}
            title="Reiniciar conversación"
          >
            <RefreshCw size={18} />
          </button>
        }
      />

      {/* Resumen Compacto Pinned (debajo del AppBar, fuera del scroll conversacional) */}
      {hasDraftData && (
        <div
          data-testid="compact-draft-bar"
          style={{
            background: 'var(--color-surface, #ffffff)',
            borderBottom: '1px solid var(--color-outline-variant, #e2e8f0)',
            padding: '10px 16px',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'space-between',
            gap: '12px',
            flexShrink: 0,
            zIndex: 10,
            boxShadow: '0 1px 3px rgba(0,0,0,0.03)',
          }}
        >
          <div style={{ display: 'flex', alignItems: 'center', gap: '10px', minWidth: 0, flex: 1 }}>
            <div
              style={{
                width: '32px',
                height: '32px',
                borderRadius: '8px',
                background: isComplete ? '#dcfce7' : 'var(--color-primary-container, #e0e7ff)',
                color: isComplete ? '#15803d' : 'var(--color-primary, #4f46e5)',
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                flexShrink: 0,
              }}
            >
              {isComplete ? <CheckCircle2 size={18} /> : <Sparkles size={16} />}
            </div>
            <div style={{ minWidth: 0, flex: 1 }}>
              <div
                style={{
                  fontSize: '13px',
                  fontWeight: 700,
                  color: 'var(--color-on-surface, #0f172a)',
                  overflow: 'hidden',
                  textOverflow: 'ellipsis',
                  whiteSpace: 'nowrap',
                }}
              >
                {draft.title || 'Nuevo encuentro'}
              </div>
              <div
                style={{
                  fontSize: '11px',
                  color: 'var(--color-on-surface-variant, #64748b)',
                  overflow: 'hidden',
                  textOverflow: 'ellipsis',
                  whiteSpace: 'nowrap',
                }}
              >
                {dateText}
                {placeText ? ` · ${placeText}` : ''}
                {` · ${themeLabel}${variantLabel}`}
              </div>
            </div>
          </div>

          <button
            type="button"
            data-testid="toggle-draft-summary"
            aria-expanded={isSummaryExpanded}
            onClick={() => {
              if (isComplete) {
                completeSummaryRef.current?.scrollIntoView({ behavior: 'smooth' });
              } else {
                setIsSummaryExpanded((prev) => !prev);
              }
            }}
            style={{
              display: 'flex',
              alignItems: 'center',
              gap: '4px',
              padding: '6px 10px',
              borderRadius: '8px',
              border: '1px solid var(--color-outline, #cbd5e1)',
              background: isSummaryExpanded ? 'var(--color-primary-container, #e0e7ff)' : '#ffffff',
              color: isSummaryExpanded ? 'var(--color-primary, #4f46e5)' : 'var(--color-on-surface, #334155)',
              fontSize: '12px',
              fontWeight: 600,
              cursor: 'pointer',
              flexShrink: 0,
              whiteSpace: 'nowrap',
            }}
          >
            {isComplete ? (
              <>
                <span>Ver abajo</span>
                <ChevronDown size={14} />
              </>
            ) : isSummaryExpanded ? (
              <>
                <span>Ocultar</span>
                <ChevronUp size={14} />
              </>
            ) : (
              <>
                <span>Ver resumen</span>
                <ChevronDown size={14} />
              </>
            )}
          </button>
        </div>
      )}

      {/* Panel Expandido Colapsable (solo cuando !isComplete y el usuario lo abre) */}
      {hasDraftData && !isComplete && isSummaryExpanded && (
        <div
          data-testid="expanded-draft-summary"
          style={{
            background: 'var(--color-surface, #ffffff)',
            borderBottom: '2px solid var(--color-outline-variant, #cbd5e1)',
            padding: '12px 16px',
            maxHeight: '360px',
            overflowY: 'auto',
            flexShrink: 0,
            boxShadow: '0 4px 12px rgba(0,0,0,0.08)',
            zIndex: 9,
          }}
        >
          <DraftSummary
            draft={draft}
            config={config}
            isLoading={isCreating}
            onConfirmCreate={handleConfirmCreate}
            onModify={(field) => {
              const val = prompt(`Modificar ${field}:`, (draft as any)[field] || '');
              if (val !== null) {
                updateDraftField(field, val);
              }
            }}
            onFallbackManual={handleFallbackManual}
            onChangeConfig={updateConfigField}
          />
        </div>
      )}

      {/* Main Conversation Area (Scrollable Timeline) */}
      <div
        ref={chatContainerRef}
        style={{
          flex: 1,
          overflowY: 'auto',
          padding: '16px',
          display: 'flex',
          flexDirection: 'column',
        }}
      >
        {/* Welcome / Empty State */}
        {messages.length === 0 && !hasDraftData && (
          <div style={{ textAlign: 'center', margin: 'auto 0', padding: '24px 16px' }}>
            <div
              style={{
                width: '56px',
                height: '56px',
                borderRadius: '50%',
                background: 'var(--color-primary-container, #e0e7ff)',
                color: 'var(--color-primary, #4f46e5)',
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                margin: '0 auto 16px auto',
              }}
            >
              ✨
            </div>
            <h2 style={{ fontSize: '18px', fontWeight: 700, margin: '0 0 8px 0', color: 'var(--color-on-surface, #0f172a)' }}>
              Contame qué querés organizar
            </h2>
            <p style={{ fontSize: '14px', color: 'var(--color-on-surface-variant, #64748b)', margin: '0 0 24px 0', lineHeight: 1.5 }}>
              PuntoEncuentro se ocupa de preparar los detalles de tu juntada.
            </p>

            <div
              style={{
                background: 'var(--color-surface-variant, #f8fafc)',
                borderRadius: '12px',
                padding: '14px',
                textAlign: 'left',
                border: '1px dashed var(--color-outline, #cbd5e1)',
              }}
            >
              <span style={{ fontSize: '12px', fontWeight: 600, color: 'var(--color-primary, #4f46e5)', display: 'block', marginBottom: '6px' }}>
                💡 Ejemplos de lo que podés escribir:
              </span>
              <ul style={{ margin: 0, paddingLeft: '18px', fontSize: '13px', color: 'var(--color-on-surface, #334155)', lineHeight: 1.6 }}>
                <li>"Cena con amigos el viernes a las 21 en casa"</li>
                <li>"Reunión de equipo mañana a las 10 por Google Meet"</li>
                <li>"Cumpleaños de Sofi el sábado que viene a las 20"</li>
              </ul>
            </div>
          </div>
        )}

        {/* Chat Messages */}
        {messages.map((msg, index) => {
          const isLatestAssistant = msg.role === 'assistant' && index === lastAssistantIndex;
          const isLatestUser = msg.role === 'user' && index === lastUserIndex;

          return (
            <div
              key={msg.id}
              ref={
                isLatestAssistant
                  ? latestAssistantMessageRef
                  : isLatestUser
                  ? latestUserMessageRef
                  : undefined
              }
              data-testid={isLatestAssistant ? 'latest-assistant-message' : undefined}
            >
              <AIChatMessage message={msg} />
            </div>
          );
        })}

        {/* Loading Bubble */}
        {isInterpreting && (
          <div style={{ display: 'flex', alignItems: 'center', gap: '8px', color: '#64748b', fontSize: '13px', margin: '8px 0' }}>
            <span className="spinner" style={{ width: '16px', height: '16px', border: '2px solid #e2e8f0', borderTopColor: '#4f46e5', borderRadius: '50%', animation: 'spin 1s linear infinite' }} />
            <span>Interpretando...</span>
          </div>
        )}

        {/* Deterministic Question with Quick Option Chips */}
        {lastQuestion && (!isComplete || lastQuestion.field === 'template' || lastQuestion.field === 'theme') && (
          <div ref={activeQuestionRef} data-testid="active-field-question">
            <FieldQuestion
              question={lastQuestion}
              onSelectOption={handleQuickOptionSelect}
              onHandoffCoordination={handleHandoffCoordination}
            />
          </div>
        )}

        {/* Final Confirmation Summary Card */}
        {isComplete && (
          <div ref={completeSummaryRef} data-testid="complete-draft-summary" style={{ marginTop: '12px' }}>
            <DraftSummary
              draft={draft}
              config={config}
              isLoading={isCreating}
              onConfirmCreate={handleConfirmCreate}
              onModify={(field) => {
                const val = prompt(`Modificar ${field}:`, (draft as any)[field] || '');
                if (val !== null) {
                  updateDraftField(field, val);
                }
              }}
              onFallbackManual={handleFallbackManual}
              onChangeConfig={updateConfigField}
            />
          </div>
        )}

        {/* Error Alerts & Lock Notice */}
        {(aiError || creationError || aiLocked) && (
          <div
            data-testid="ai-status-banner"
            style={{
              display: 'flex',
              flexDirection: 'column',
              gap: '8px',
              padding: '12px',
              borderRadius: '8px',
              background: '#fef2f2',
              border: '1px solid #fecaca',
              color: '#991b1b',
              fontSize: '13px',
              margin: '8px 0',
            }}
          >
            <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
              <AlertCircle size={16} style={{ flexShrink: 0 }} />
              <div style={{ flex: 1 }}>
                {aiLocked
                  ? 'Crear con IA está disponible solo para organizar encuentros. Para este encuentro podés continuar editando los datos manualmente.'
                  : aiError || creationError}
              </div>
            </div>
            {(aiError || aiLocked) && (
              <button
                type="button"
                data-testid="continue-manually-button"
                onClick={handleFallbackManual}
                style={{
                  alignSelf: 'flex-start',
                  background: '#ffffff',
                  border: '1px solid #fca5a5',
                  borderRadius: '6px',
                  padding: '6px 12px',
                  fontSize: '12px',
                  fontWeight: 600,
                  color: '#991b1b',
                  cursor: 'pointer',
                  marginTop: '4px',
                }}
              >
                Continuar manualmente →
              </button>
            )}
          </div>
        )}
      </div>

      {/* Input Bar */}
      <div
        style={{
          borderTop: '1px solid var(--color-outline-variant, #e2e8f0)',
          background: 'var(--color-surface, #ffffff)',
          padding: '12px 16px',
        }}
      >
        <div style={{ display: 'flex', gap: '8px', alignItems: 'flex-end' }}>
          <textarea
            ref={inputRef}
            value={inputText}
            onChange={(e) => setInputText(e.target.value)}
            onKeyDown={handleKeyDown}
            placeholder={
              aiLocked
                ? 'Crear con IA no disponible para este borrador'
                : messages.length === 0
                ? 'Escribí qué querés organizar...'
                : 'Respondé acá o agregá detalles...'
            }
            rows={1}
            autoCapitalize="sentences"
            enterKeyHint="send"
            disabled={isInterpreting || isCreating || aiLocked}
            style={{
              flex: 1,
              minHeight: '40px',
              maxHeight: '120px',
              padding: '10px 14px',
              borderRadius: '20px',
              border: '1px solid var(--color-outline, #cbd5e1)',
              background: aiLocked ? '#f1f5f9' : 'var(--color-surface-variant, #f8fafc)',
              color: aiLocked ? '#94a3b8' : 'var(--color-on-surface, #0f172a)',
              fontSize: '14px',
              resize: 'none',
              fontFamily: 'inherit',
              outline: 'none',
              cursor: aiLocked ? 'not-allowed' : 'text',
            }}
          />

          <button
            onClick={handleSend}
            disabled={!inputText.trim() || isInterpreting || isCreating || aiLocked}
            style={{
              width: '40px',
              height: '40px',
              borderRadius: '50%',
              background:
                inputText.trim() && !isInterpreting && !aiLocked
                  ? 'var(--color-primary, #4f46e5)'
                  : '#e2e8f0',
              color:
                inputText.trim() && !isInterpreting && !aiLocked
                  ? '#ffffff'
                  : '#94a3b8',
              border: 'none',
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              cursor:
                inputText.trim() && !isInterpreting && !aiLocked
                  ? 'pointer'
                  : 'default',
              flexShrink: 0,
              transition: 'background 0.2s',
            }}
          >
            <Send size={18} />
          </button>
        </div>

        {/* Fallback to manual link */}
        <div style={{ textAlign: 'center', marginTop: '8px' }}>
          <button
            onClick={handleFallbackManual}
            style={{
              background: 'none',
              border: 'none',
              fontSize: '12px',
              color: 'var(--color-on-surface-variant, #64748b)',
              cursor: 'pointer',
              textDecoration: 'underline',
            }}
          >
            Prefiero usar el formulario manual
          </button>
        </div>
      </div>
    </ScreenContainer>
  );
};

export default CreateAIWizard;
