import React, { useState, useEffect, useRef } from 'react';
import { useNavigate } from 'react-router-dom';
import { Send, RefreshCw, AlertCircle } from 'lucide-react';
import { AppBar } from '@/components/ui/AppBar';
import { ScreenContainer } from '@/components/ui/ScreenContainer';
import { AIChatMessage } from '@/components/ai/AIChatMessage';
import { DraftPreview } from '@/components/ai/DraftPreview';
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
import './CreateWizard.css';

export const CreateAIWizard: React.FC = () => {
  const navigate = useNavigate();
  const [inputText, setInputText] = useState('');
  const [isCreating, setIsCreating] = useState(false);
  const [creationError, setCreationError] = useState<string | null>(null);
  const messagesEndRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);

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
  } = useAiWizardStore();

  const hasDraftData = Boolean(
    draft.title ||
    draft.date ||
    draft.time ||
    draft.modality ||
    draft.locationText ||
    draft.virtualLink
  );

  useEffect(() => {
    initSession();
  }, [initSession]);

  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages, isInterpreting, lastQuestion]);

  const handleSend = async () => {
    if (!inputText.trim() || isInterpreting || isCreating) return;
    const text = inputText;
    setInputText('');
    await sendUserMessage(text);
  };

  const handleKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      handleSend();
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
            onClick={reset}
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

      {/* Main Conversation & Review Area */}
      <div
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
        {messages.map((msg) => (
          <AIChatMessage key={msg.id} message={msg} />
        ))}

        {/* Live Detected Fields Card */}
        <DraftPreview
          draft={draft}
          onUpdateField={updateDraftField}
        />

        {/* Deterministic Question with Quick Option Chips */}
        {lastQuestion && (!isComplete || lastQuestion.field === 'template' || lastQuestion.field === 'theme') && (
          <FieldQuestion
            question={lastQuestion}
            onSelectOption={handleQuickOptionSelect}
            onHandoffCoordination={handleHandoffCoordination}
          />
        )}

        {/* Final Confirmation Summary Card */}
        {isComplete && (
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
        )}

        {/* Error Alerts */}
        {(aiError || creationError) && (
          <div
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
              <div style={{ flex: 1 }}>{aiError || creationError}</div>
            </div>
            {aiError && (
              <button
                type="button"
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
                Continuar manualmente con este borrador →
              </button>
            )}
          </div>
        )}

        {/* Loading Bubble */}
        {isInterpreting && (
          <div style={{ display: 'flex', alignItems: 'center', gap: '8px', color: '#64748b', fontSize: '13px', margin: '8px 0' }}>
            <span className="spinner" style={{ width: '16px', height: '16px', border: '2px solid #e2e8f0', borderTopColor: '#4f46e5', borderRadius: '50%', animation: 'spin 1s linear infinite' }} />
            <span>Interpretando...</span>
          </div>
        )}

        <div ref={messagesEndRef} />
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
              messages.length === 0
                ? 'Escribí qué querés organizar...'
                : 'Respondé acá o agregá detalles...'
            }
            rows={1}
            autoCapitalize="sentences"
            enterKeyHint="send"
            disabled={isInterpreting || isCreating}
            style={{
              flex: 1,
              minHeight: '40px',
              maxHeight: '120px',
              padding: '10px 14px',
              borderRadius: '20px',
              border: '1px solid var(--color-outline, #cbd5e1)',
              background: 'var(--color-surface-variant, #f8fafc)',
              color: 'var(--color-on-surface, #0f172a)',
              fontSize: '14px',
              resize: 'none',
              fontFamily: 'inherit',
              outline: 'none',
            }}
          />

          <button
            onClick={handleSend}
            disabled={!inputText.trim() || isInterpreting || isCreating}
            style={{
              width: '40px',
              height: '40px',
              borderRadius: '50%',
              background: inputText.trim() && !isInterpreting ? 'var(--color-primary, #4f46e5)' : '#e2e8f0',
              color: inputText.trim() && !isInterpreting ? '#ffffff' : '#94a3b8',
              border: 'none',
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              cursor: inputText.trim() && !isInterpreting ? 'pointer' : 'default',
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
