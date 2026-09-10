import { create } from 'zustand';
import { persist, createJSONStorage } from 'zustand/middleware';
import type { EncounterDraft, InvitationConfig } from '@/lib/encounterDraft';
import { createEmptyEncounterDraft, createDefaultInvitationConfig } from '@/lib/encounterDraft';
import { mergeDraftPatch, isValidVirtualLink, normalizeVirtualLink, isRecognizedVirtualPlatform } from '@/lib/draftMerger';
import { addDaysToIsoDate } from '@/lib/dateResolver';
import { evaluateDraft, type FieldQuestion } from '@/lib/draftFieldEngine';
import {
  INVITATION_THEMES,
  getTemplateOptionsForTheme,
  getDefaultInvitationTemplate,
  type InvitationTheme,
} from '@/lib/invitationThemes';
import { formatFriendlyDate } from '@/lib/formatDate';
import { aiService, type AiInterpretationResponse } from '@/services/aiService';

export interface ChatMessage {
  id: string;
  role: 'user' | 'assistant';
  text: string;
  timestamp: number;
}

interface AiWizardState {
  sessionId: string;
  draft: EncounterDraft;
  config: InvitationConfig;
  messages: ChatMessage[];
  turns: number;
  consecutiveOffTopicCount: number;
  aiLocked: boolean;
  totalInputTokens: number;
  totalOutputTokens: number;
  totalLatencyMs: number;
  primaryLatencyMs: number;
  fallbackLatencyMs: number;
  fallbackUsed: boolean;
  primaryProvider: string;
  fallbackProvider: string | null;
  providerUsed: string | null;
  modelUsed: string | null;
  primaryFailureType: string | null;
  fallbackFailureType: string | null;
  startedAt: number;
  isInterpreting: boolean;
  error: string | null;
  lastQuestion: FieldQuestion | null;
  coordinationDetected: boolean;
  isComplete: boolean;
  lastUserPrompt: string | null;

  // Actions
  initSession: () => void;
  sendUserMessage: (text: string) => Promise<void>;
  retryLastMessage: () => Promise<void>;
  updateDraftField: <K extends keyof EncounterDraft>(field: K, value: EncounterDraft[K]) => void;
  applyQuickOption: (field: string, value: any, displayLabel?: string) => void;
  updateConfigField: <K extends keyof InvitationConfig>(field: K, value: InvitationConfig[K]) => void;
  dismissCoordinationHandoff: () => void;
  markFallbackManual: () => void;
  startNewAiCreation: () => void;
  reset: () => void;
}

function generateUuid(): string {
  if (typeof crypto !== 'undefined' && crypto.randomUUID) {
    return crypto.randomUUID();
  }
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (c) => {
    const r = (Math.random() * 16) | 0;
    const v = c === 'x' ? r : (r & 0x3) | 0x8;
    return v.toString(16);
  });
}

function applyInterpretationResponse(
  response: AiInterpretationResponse,
  state: AiWizardState,
  set: (partial: Partial<AiWizardState> | ((state: AiWizardState) => Partial<AiWizardState>)) => void,
  get: () => AiWizardState
): void {
  if (!response.ok || !response.patch) {
    const isAbuseOrLimit =
      response.error === 'session_limit_reached' ||
      response.error === 'rate_limit_exceeded' ||
      response.error === 'session_locked_off_topic' ||
      response.error === 'input_too_long';

    const isTimeout = response.error === 'timeout_client';
    const isNetwork = response.error === 'network_error';

    let errorReply = response.details || 'No pudimos interpretar el mensaje. Intentá de nuevo o completá manualmente.';
    if (isTimeout) {
      errorReply = 'No pude procesar el mensaje a tiempo. Podés intentar nuevamente o continuar manualmente.';
    } else if (isNetwork) {
      errorReply = 'No pudimos conectarnos con Crear con IA. Revisá tu conexión e intentá nuevamente.';
    }

    const newMessages = isAbuseOrLimit
      ? [
          ...get().messages,
          {
            id: generateUuid(),
            role: 'assistant' as const,
            text: errorReply,
            timestamp: Date.now() + 1,
          },
        ]
      : get().messages;

    set({
      messages: newMessages,
      aiLocked: isAbuseOrLimit || state.aiLocked,
      error: errorReply,
      fallbackUsed: state.fallbackUsed || (response.fallbackUsed ?? false),
      primaryProvider: response.primaryProvider || state.primaryProvider,
      fallbackProvider: response.fallbackProvider ?? state.fallbackProvider,
      primaryLatencyMs: state.primaryLatencyMs + (response.primaryLatencyMs || 0),
      fallbackLatencyMs: state.fallbackLatencyMs + (response.fallbackLatencyMs || 0),
      totalLatencyMs: state.totalLatencyMs + (response.totalLatencyMs || 0),
      primaryFailureType: response.primaryFailureType ?? state.primaryFailureType,
      fallbackFailureType: response.fallbackFailureType ?? state.fallbackFailureType,
    });
    return;
  }

  // Accumulate tokens & latency
  const totalIn = state.totalInputTokens + (response.usage?.inputTokens || 0);
  const totalOut = state.totalOutputTokens + (response.usage?.outputTokens || 0);
  const totalLat = state.totalLatencyMs + (response.totalLatencyMs || response.usage?.latencyMs || 0);
  const primLat = state.primaryLatencyMs + (response.primaryLatencyMs || response.usage?.primaryLatencyMs || 0);
  const fallLat = state.fallbackLatencyMs + (response.fallbackLatencyMs || response.usage?.fallbackLatencyMs || 0);

  // 4. Handle OFF-TOPIC scope
  if (response.scope === 'off_topic') {
    const nextOffTopicCount = state.consecutiveOffTopicCount + 1;
    const isPermanentlyLocked = nextOffTopicCount >= 2;
    const replyText = isPermanentlyLocked
      ? 'Crear con IA está disponible solo para organizar encuentros. Para este encuentro podés continuar editando los datos manualmente.'
      : 'Este asistente solo puede ayudarte a crear o modificar un encuentro. Podés indicarme fecha, hora, lugar, modalidad, tema o cualquier cambio del encuentro.';

    set({
      messages: [
        ...get().messages,
        {
          id: generateUuid(),
          role: 'assistant',
          text: replyText,
          timestamp: Date.now() + 1,
        },
      ],
      consecutiveOffTopicCount: nextOffTopicCount,
      aiLocked: isPermanentlyLocked,
      error: isPermanentlyLocked ? replyText : null,
      totalInputTokens: totalIn,
      totalOutputTokens: totalOut,
      totalLatencyMs: totalLat,
      primaryLatencyMs: primLat,
      fallbackLatencyMs: fallLat,
    });
    return;
  }

  // 5. Handle UNCLEAR scope
  if (response.scope === 'unclear') {
    let unclearReply =
      'No llegué a entender qué querés cambiar del encuentro. Podés indicarme, por ejemplo, fecha, hora, lugar, modalidad o diseño.';

    if (state.lastQuestion?.question) {
      unclearReply = `No llegué a entender esa indicación. ${state.lastQuestion.question}`;
    }

    set({
      messages: [
        ...get().messages,
        {
          id: generateUuid(),
          role: 'assistant',
          text: unclearReply,
          timestamp: Date.now() + 1,
        },
      ],
      totalInputTokens: totalIn,
      totalOutputTokens: totalOut,
      totalLatencyMs: totalLat,
      primaryLatencyMs: primLat,
      fallbackLatencyMs: fallLat,
    });
    return;
  }

  // Reset consecutive off-topic counter since input is in-domain
  const consecutiveOffTopicCount = 0;

  // Snapshot previous state before applying patch
  const wasAlreadyComplete = state.isComplete;
  const prevDraft = { ...state.draft };
  const prevConfig = { ...state.config };

  // Merge patch deterministically
  const mergeResult = mergeDraftPatch(state.draft, state.config, response.patch);

  // Detect concrete modifications
  const themeChanged = prevConfig.invitationTheme !== mergeResult.config.invitationTheme;
  const templateChanged = prevConfig.invitationTemplate !== mergeResult.config.invitationTemplate;
  const timeChanged = prevDraft.time !== mergeResult.draft.time;
  const dateChanged = prevDraft.date !== mergeResult.draft.date;
  const modalityChanged = prevDraft.modality !== mergeResult.draft.modality;
  const locationChanged = prevDraft.locationText !== mergeResult.draft.locationText;
  const virtualLinkChanged = prevDraft.virtualLink !== mergeResult.draft.virtualLink;
  const titleChanged = prevDraft.title !== mergeResult.draft.title;
  const hasAnyChange =
    themeChanged ||
    templateChanged ||
    timeChanged ||
    dateChanged ||
    modalityChanged ||
    locationChanged ||
    virtualLinkChanged ||
    titleChanged;

  // Evaluate draft completeness and select next question
  const evaluation = evaluateDraft(
    mergeResult.draft,
    mergeResult.coordinationDetected,
    mergeResult.ambiguities[0]
  );

  // Defensive guard: if modality is virtual, next question must never revert to modality
  if (mergeResult.draft.modality === 'virtual' && evaluation.nextQuestion?.field === 'modality') {
    console.warn('[aiWizardStore] Defensive guard: modality was virtual but evaluateDraft requested modality again.');
    evaluation.missingFields = evaluation.missingFields.filter((f) => f !== 'modality');
    if (!evaluation.missingFields.includes('virtualLink')) {
      evaluation.missingFields.push('virtualLink');
    }
    evaluation.nextQuestion = {
      field: 'virtualLink',
      question: '¿Cuál es el enlace de la videollamada?',
      helperText: 'Pegá el link de Google Meet, Zoom, Teams, etc.',
      type: 'text',
    };
  }

  let assistantReply = '';
  if (!hasAnyChange) {
    if (
      response.patch?.themeHint?.value &&
      response.patch.themeHint.value === mergeResult.config.invitationTheme
    ) {
      const themeLabel =
        INVITATION_THEMES.find((t) => t.id === mergeResult.config.invitationTheme)?.label ||
        mergeResult.config.invitationTheme;
      assistantReply = `Ya está seleccionado el tema ${themeLabel}.`;
    } else if (
      response.patch?.modality?.value &&
      response.patch.modality.value === mergeResult.draft.modality
    ) {
      assistantReply = `Ya está configurado como encuentro ${mergeResult.draft.modality}.`;
    } else if (wasAlreadyComplete) {
      assistantReply =
        'No encontré un cambio nuevo para aplicar en el encuentro. Podés indicarme fecha, hora, lugar, modalidad o tema.';
    } else if (evaluation.nextQuestion) {
      assistantReply = evaluation.nextQuestion.question;
    }
  } else if (wasAlreadyComplete && evaluation.isComplete) {
    if (themeChanged) {
      const themeLabel =
        INVITATION_THEMES.find((t) => t.id === mergeResult.config.invitationTheme)?.label ||
        mergeResult.config.invitationTheme;
      assistantReply = `Listo, cambié el tema a ${themeLabel}.`;

      // Offer variants of the newly selected theme
      const templateOptions = getTemplateOptionsForTheme(mergeResult.config.invitationTheme);
      if (templateOptions.length > 1) {
        evaluation.nextQuestion = {
          field: 'template',
          question: `Elegí una variante para ${themeLabel} (o dejá la opción por defecto):`,
          quickOptions: templateOptions.map((opt) => ({
            label: opt.id === mergeResult.config.invitationTemplate ? `${opt.name} (por defecto)` : opt.name,
            value: opt.id,
          })),
          type: 'choice',
        };
      }
    } else if (templateChanged) {
      const templateName =
        getTemplateOptionsForTheme(mergeResult.config.invitationTheme).find(
          (t) => t.id === mergeResult.config.invitationTemplate
        )?.name || 'elegido';
      assistantReply = `Listo, cambié el diseño a ${templateName}.`;
    } else if (timeChanged) {
      assistantReply = `Listo, lo pasé a las ${mergeResult.draft.time} hs.`;
    } else if (dateChanged) {
      const dateStr = formatFriendlyDate(mergeResult.draft.date || '', '').split('•')[0].trim();
      assistantReply = `Listo, cambié la fecha al ${dateStr}.`;
    } else if (modalityChanged) {
      assistantReply = `Listo, quedó como encuentro ${
        mergeResult.draft.modality === 'virtual' ? 'virtual' : 'presencial'
      }.`;
    } else if (locationChanged) {
      assistantReply = `Perfecto, ahora es en ${mergeResult.draft.locationText}.`;
    } else if (virtualLinkChanged) {
      assistantReply = `Listo, actualicé el enlace a ${mergeResult.draft.virtualLink}.`;
    } else if (titleChanged) {
      assistantReply = `Listo, cambié el título a ${mergeResult.draft.title}.`;
    } else {
      assistantReply = 'Listo, apliqué los cambios al encuentro.';
    }
  } else if (!wasAlreadyComplete && evaluation.isComplete) {
    assistantReply = '¡Listo! Preparé el resumen con los datos de tu encuentro. Revisalo antes de crear.';
  } else if (evaluation.nextQuestion) {
    assistantReply = evaluation.nextQuestion.question;
  }

  const assistantMsg: ChatMessage | null = assistantReply
    ? {
        id: generateUuid(),
        role: 'assistant',
        text: assistantReply,
        timestamp: Date.now() + 1,
      }
    : null;

  set({
    draft: mergeResult.draft,
    config: mergeResult.config,
    messages: assistantMsg ? [...get().messages, assistantMsg] : get().messages,
    consecutiveOffTopicCount,
    totalInputTokens: totalIn,
    totalOutputTokens: totalOut,
    totalLatencyMs: totalLat,
    primaryLatencyMs: primLat,
    fallbackLatencyMs: fallLat,
    fallbackUsed: state.fallbackUsed || (response.fallbackUsed ?? false),
    primaryProvider: response.primaryProvider || state.primaryProvider,
    fallbackProvider: response.fallbackProvider ?? state.fallbackProvider,
    providerUsed: response.provider || state.providerUsed,
    modelUsed: response.model || state.modelUsed,
    primaryFailureType: response.primaryFailureType ?? state.primaryFailureType,
    fallbackFailureType: response.fallbackFailureType ?? state.fallbackFailureType,
    lastQuestion: evaluation.nextQuestion,
    coordinationDetected: mergeResult.coordinationDetected,
    isComplete: evaluation.isComplete,
    error: evaluation.validationError,
  });
}

export const useAiWizardStore = create<AiWizardState>()(
  persist(
    (set, get) => ({
      sessionId: generateUuid(),
      draft: createEmptyEncounterDraft(),
      config: createDefaultInvitationConfig(),
      messages: [],
      turns: 0,
      consecutiveOffTopicCount: 0,
      aiLocked: false,
      totalInputTokens: 0,
      totalOutputTokens: 0,
      totalLatencyMs: 0,
      primaryLatencyMs: 0,
      fallbackLatencyMs: 0,
      fallbackUsed: false,
      primaryProvider: 'openai',
      fallbackProvider: null,
      providerUsed: null,
      modelUsed: null,
      primaryFailureType: null,
      fallbackFailureType: null,
      startedAt: Date.now(),
      isInterpreting: false,
      error: null,
      lastQuestion: null,
      coordinationDetected: false,
      isComplete: false,
      lastUserPrompt: null,

      initSession: () => {
        const state = get();
        if (!state.sessionId) {
          const newSession = generateUuid();
          set({
            sessionId: newSession,
            draft: createEmptyEncounterDraft(),
            config: createDefaultInvitationConfig(),
            messages: [],
            turns: 0,
            consecutiveOffTopicCount: 0,
            aiLocked: false,
            startedAt: Date.now(),
            error: null,
            lastQuestion: null,
            coordinationDetected: false,
            isComplete: false,
            lastUserPrompt: null,
            totalLatencyMs: 0,
            primaryLatencyMs: 0,
            fallbackLatencyMs: 0,
            fallbackUsed: false,
            primaryProvider: 'openai',
            fallbackProvider: null,
            providerUsed: null,
            modelUsed: null,
            primaryFailureType: null,
            fallbackFailureType: null,
          });
          aiService.startSession(newSession);
          return;
        }

        // Re-entry / F5 scenario:
        // If draft has data and lastQuestion is missing (e.g. after page refresh),
        // reconstruct evaluation, nextQuestion, and isComplete so the user can continue seamlessly.
        const hasDraftData = Boolean(
          state.draft.title ||
          state.draft.date ||
          state.draft.time ||
          state.draft.modality ||
          state.draft.locationText ||
          state.draft.virtualLink
        );

        if (hasDraftData && !state.lastQuestion && !state.isComplete) {
          const evaluation = evaluateDraft(state.draft, state.coordinationDetected);
          set({
            lastQuestion: evaluation.nextQuestion,
            isComplete: evaluation.isComplete,
            error: state.aiLocked
              ? 'Crear con IA está disponible solo para organizar encuentros. Para este encuentro podés continuar editando los datos manualmente.'
              : evaluation.validationError,
          });
        } else if (state.aiLocked && !state.error) {
          set({
            error: 'Crear con IA está disponible solo para organizar encuentros. Para este encuentro podés continuar editando los datos manualmente.',
          });
        }

        if (state.aiLocked && state.messages.length === 0) {
          set({
            messages: [
              {
                id: generateUuid(),
                role: 'assistant',
                text: 'Crear con IA está disponible solo para organizar encuentros. Para este encuentro podés continuar editando los datos manualmente.',
                timestamp: Date.now(),
              },
            ],
          });
        }
      },

      sendUserMessage: async (text: string) => {
        const trimmed = text.trim();
        if (!trimmed) return;

        const state = get();
        const userMsg: ChatMessage = {
          id: generateUuid(),
          role: 'user',
          text: trimmed,
          timestamp: Date.now(),
        };

        // 1. Session locked due to repeated abuse/off-topic
        if (state.aiLocked) {
          set({
            messages: [
              ...state.messages,
              userMsg,
              {
                id: generateUuid(),
                role: 'assistant',
                text: 'Crear con IA está disponible solo para organizar encuentros. Para este encuentro podés continuar editando los datos manualmente.',
                timestamp: Date.now() + 1,
              },
            ],
            error: 'Crear con IA está disponible solo para organizar encuentros. Para este encuentro podés continuar editando los datos manualmente.',
          });
          return;
        }

        // 2. Session max turns limit (15-20 turns)
        if (state.turns >= 20) {
          set({
            messages: [
              ...state.messages,
              userMsg,
              {
                id: generateUuid(),
                role: 'assistant',
                text: 'No pudimos seguir procesando cambios con IA en esta sesión. Podés continuar con el formulario manual.',
                timestamp: Date.now() + 1,
              },
            ],
            error: 'No pudimos seguir procesando cambios con IA en esta sesión. Podés continuar con el formulario manual.',
          });
          return;
        }

        // 3. User explicitly asking to see designs/variants (Token Optimization)
        const isAskingVariants = /mostrame.*(diseño|variante|opci[oó]n|tema)|qu[eé]\s+(diseños|opciones|variantes)|quiero\s+elegir\s+(el\s+)?(diseño|variante)/i.test(trimmed);
        if (isAskingVariants) {
          const themeLabel = INVITATION_THEMES.find((t) => t.id === state.config.invitationTheme)?.label || 'este tema';
          const templateOptions = getTemplateOptionsForTheme(state.config.invitationTheme);
          if (templateOptions.length > 0) {
            const questionText = `Estos son los diseños disponibles para ${themeLabel}:`;
            const assistantMsg: ChatMessage = {
              id: generateUuid(),
              role: 'assistant',
              text: questionText,
              timestamp: Date.now() + 1,
            };
            set({
              messages: [...state.messages, userMsg, assistantMsg],
              isInterpreting: false,
              lastQuestion: {
                field: 'template',
                question: questionText,
                quickOptions: templateOptions.map((opt) => ({
                  label: opt.id === state.config.invitationTemplate ? `${opt.name} ✓` : opt.name,
                  value: opt.id,
                })),
                type: 'choice',
              },
            });
            return;
          }
        }

        // 4. Deterministic response when active question is modality
        if (state.lastQuestion?.field === 'modality') {
          if (/^(virtual|💻\s*virtual|online|videollamada)$/i.test(trimmed)) {
            const newDraft: EncounterDraft = {
              ...state.draft,
              modality: 'virtual',
              virtualLink: null,
              locationText: null,
            };
            const evaluation = evaluateDraft(newDraft, state.coordinationDetected);
            const assistantMsg: ChatMessage = {
              id: generateUuid(),
              role: 'assistant',
              text: evaluation.nextQuestion?.question || 'Listo, quedó como encuentro virtual.',
              timestamp: Date.now() + 1,
            };
            set({
              draft: newDraft,
              messages: [...state.messages, userMsg, assistantMsg],
              lastQuestion: evaluation.nextQuestion,
              isComplete: evaluation.isComplete,
              error: evaluation.validationError,
            });
            return;
          }

          if (/^(presencial|🏠\s*presencial|en\s+persona)$/i.test(trimmed)) {
            const newDraft: EncounterDraft = {
              ...state.draft,
              modality: 'presencial',
              virtualLink: null,
            };
            const evaluation = evaluateDraft(newDraft, state.coordinationDetected);
            const assistantMsg: ChatMessage = {
              id: generateUuid(),
              role: 'assistant',
              text: evaluation.nextQuestion?.question || 'Listo, quedó como encuentro presencial.',
              timestamp: Date.now() + 1,
            };
            set({
              draft: newDraft,
              messages: [...state.messages, userMsg, assistantMsg],
              lastQuestion: evaluation.nextQuestion,
              isComplete: evaluation.isComplete,
              error: evaluation.validationError,
            });
            return;
          }
        }

        // 5. Deterministic response when active question is virtualLink (Bypass Determinístico)
        if (state.lastQuestion?.field === 'virtualLink') {
          // A. User explicitly asks to change modality to presencial
          const isSwitchToPresencial =
            /\b(presencial|en\s+persona)\b/i.test(trimmed) &&
            !/\b(no\s+presencial|virtual)\b/i.test(trimmed);

          if (isSwitchToPresencial) {
            const newDraft: EncounterDraft = {
              ...state.draft,
              modality: 'presencial',
              virtualLink: null,
            };
            const evaluation = evaluateDraft(newDraft, state.coordinationDetected);
            const reply = evaluation.nextQuestion?.question || 'Listo, lo cambié a presencial.';
            const assistantMsg: ChatMessage = {
              id: generateUuid(),
              role: 'assistant',
              text: reply,
              timestamp: Date.now() + 1,
            };
            set({
              draft: newDraft,
              messages: [...state.messages, userMsg, assistantMsg],
              lastQuestion: evaluation.nextQuestion,
              isComplete: evaluation.isComplete,
              error: evaluation.validationError,
            });
            return;
          }

          // B. Input is a valid URL
          if (isValidVirtualLink(trimmed)) {
            const cleanUrl = normalizeVirtualLink(trimmed);
            const newDraft: EncounterDraft = {
              ...state.draft,
              modality: 'virtual',
              virtualLink: cleanUrl,
            };
            const evaluation = evaluateDraft(newDraft, state.coordinationDetected);
            let reply = '';
            if (evaluation.isComplete) {
              reply = '¡Listo! Preparé el resumen con los datos de tu encuentro. Revisalo antes de crear.';
            } else if (evaluation.nextQuestion) {
              reply = evaluation.nextQuestion.question;
            }
            const assistantMsg: ChatMessage = {
              id: generateUuid(),
              role: 'assistant',
              text: reply,
              timestamp: Date.now() + 1,
            };
            set({
              draft: newDraft,
              messages: [...state.messages, userMsg, assistantMsg],
              lastQuestion: evaluation.nextQuestion,
              isComplete: evaluation.isComplete,
              error: evaluation.validationError,
            });
            return;
          }

          // C. User inputs a platform keyword like "Zoom", "Google Meet", "Teams"
          // Maintains modality='virtual', virtualLink remains null, re-asks for link
          if (isRecognizedVirtualPlatform(trimmed)) {
            const questionText = '¿Cuál es el enlace de la videollamada?';
            const assistantMsg: ChatMessage = {
              id: generateUuid(),
              role: 'assistant',
              text: questionText,
              timestamp: Date.now() + 1,
            };
            set({
              draft: {
                ...state.draft,
                modality: 'virtual',
                virtualLink: null,
              },
              messages: [...state.messages, userMsg, assistantMsg],
              lastQuestion: {
                field: 'virtualLink',
                question: questionText,
                helperText: 'Pegá el link de Google Meet, Zoom, Teams, etc.',
                type: 'text',
              },
              isInterpreting: false,
              error: null,
            });
            return;
          }

          // D. If not a valid URL, not a platform keyword, and not an explicit edit of another field (date/time/title/theme),
          // treat as invalid virtual link response without calling LLM and without off-topic penalty
          const isEditOtherField =
            /^(cambi[aá]|pas[aá]|pon[eé]|modific[aá]|a las \d|el (lunes|martes|mi[eé]rcoles|jueves|viernes|s[aá]bado|domingo)|mañana|hoy)\b/i.test(trimmed);

          if (!isEditOtherField) {
            const errorMsg = 'El enlace no parece válido. Pegá el enlace completo de la videollamada.';
            const assistantMsg: ChatMessage = {
              id: generateUuid(),
              role: 'assistant',
              text: errorMsg,
              timestamp: Date.now() + 1,
            };
            set({
              messages: [...state.messages, userMsg, assistantMsg],
              isInterpreting: false,
              error: errorMsg,
            });
            return;
          }
        }

        // 6. User switches from presencial to virtual
        if (state.draft.modality === 'presencial') {
          const isSwitchToVirtual =
            /\b(virtual|online|videollamada)\b/i.test(trimmed) &&
            !/\b(no\s+virtual|presencial)\b/i.test(trimmed);

          if (isSwitchToVirtual) {
            const newDraft: EncounterDraft = {
              ...state.draft,
              modality: 'virtual',
              locationText: null,
              virtualLink: null,
            };
            const evaluation = evaluateDraft(newDraft, state.coordinationDetected);
            const reply = evaluation.nextQuestion?.question || 'Listo, quedó como encuentro virtual. ¿Cuál es el enlace de la videollamada?';
            const assistantMsg: ChatMessage = {
              id: generateUuid(),
              role: 'assistant',
              text: reply,
              timestamp: Date.now() + 1,
            };
            set({
              draft: newDraft,
              messages: [...state.messages, userMsg, assistantMsg],
              lastQuestion: evaluation.nextQuestion,
              isComplete: evaluation.isComplete,
              error: evaluation.validationError,
            });
            return;
          }
        }

        const newTurns = state.turns + 1;
        set({
          messages: [...state.messages, userMsg],
          isInterpreting: true,
          error: null,
          turns: newTurns,
          lastUserPrompt: trimmed,
        });

        // First message of the session: register start telemetry
        if (newTurns === 1) {
          aiService.startSession(state.sessionId);
        }

        try {
          const response = await aiService.interpretMessage(trimmed, state.draft, state.sessionId);
          applyInterpretationResponse(response, get(), set, get);
        } catch (err: any) {
          console.error('[aiWizardStore] Unhandled exception in sendUserMessage:', err);
          set({
            error: 'Ocurrió un error inesperado al procesar el mensaje. Podés intentar nuevamente o continuar manualmente.',
          });
        } finally {
          set({ isInterpreting: false });
        }
      },

      retryLastMessage: async () => {
        const state = get();
        if (!state.lastUserPrompt || state.isInterpreting || state.aiLocked) return;
        const promptToRetry = state.lastUserPrompt;

        set({
          isInterpreting: true,
          error: null,
        });

        try {
          const response = await aiService.interpretMessage(promptToRetry, state.draft, state.sessionId);
          applyInterpretationResponse(response, get(), set, get);
        } catch (err: any) {
          console.error('[aiWizardStore] Unhandled exception in retryLastMessage:', err);
          set({
            error: 'Ocurrió un error inesperado al reintentar. Podés intentar nuevamente o continuar manualmente.',
          });
        } finally {
          set({ isInterpreting: false });
        }
      },

      updateDraftField: (field, value) => {
        const state = get();
        let resolvedValue = value;
        let pendingRollover = state.draft.pendingDayRollover;
        let appliedRollover = state.draft.appliedDayRollover;
        let baseDate = state.draft.baseDate;
        let finalDate = state.draft.date;

        if (field === 'date' && typeof value === 'string' && value) {
          baseDate = value;
          if (pendingRollover || appliedRollover) {
            resolvedValue = addDaysToIsoDate(value, 1) as any;
            finalDate = resolvedValue as any;
            appliedRollover = true;
            pendingRollover = false;
          } else {
            finalDate = value;
            appliedRollover = false;
          }
        } else if (field === 'time') {
          if (baseDate && appliedRollover) {
            finalDate = baseDate;
            appliedRollover = false;
          }
          pendingRollover = false;
        }

        const newDraft: EncounterDraft = {
          ...state.draft,
          [field]: resolvedValue,
          date: finalDate,
          baseDate,
          appliedDayRollover: appliedRollover,
          pendingDayRollover: pendingRollover,
        };

        if (field === 'modality') {
          if (value === 'presencial') {
            newDraft.virtualLink = null;
          } else if (value === 'virtual') {
            newDraft.locationText = null;
          }
        }
        const evaluation = evaluateDraft(newDraft, state.coordinationDetected);

        // If this update resolved the currently active question, advance the conversation
        const wasAnsweringActiveQuestion = state.lastQuestion?.field === field;
        let newMessages = state.messages;

        if (wasAnsweringActiveQuestion) {
          let nextReply = '';
          if (evaluation.nextQuestion) {
            nextReply = evaluation.nextQuestion.question;
          } else if (evaluation.isComplete) {
            nextReply = '¡Listo! Preparé el resumen con los datos de tu encuentro. Revisalo antes de crear.';
          }

          if (nextReply) {
            const lastMsg = state.messages[state.messages.length - 1];
            if (lastMsg?.text !== nextReply) {
              newMessages = [
                ...state.messages,
                {
                  id: generateUuid(),
                  role: 'assistant',
                  text: nextReply,
                  timestamp: Date.now(),
                },
              ];
            }
          }
        }

        set({
          draft: newDraft,
          messages: newMessages,
          lastQuestion: evaluation.nextQuestion,
          isComplete: evaluation.isComplete,
          error: evaluation.validationError,
        });
      },

      applyQuickOption: (field, value, displayLabel) => {
        const state = get();
        const userText = displayLabel || (typeof value === 'string' ? value : String(value));

        const userMsg: ChatMessage = {
          id: generateUuid(),
          role: 'user',
          text: userText,
          timestamp: Date.now(),
        };

        // Deterministic template variant selection
        if (field === 'template') {
          const templateName =
            displayLabel?.replace(/\s*\(por defecto\)/i, '').replace(/\s*✓/i, '').trim() || String(value);
          const newConfig = { ...state.config, invitationTemplate: String(value) };
          const replyText = `Listo, cambié el diseño a ${templateName}.`;
          set({
            config: newConfig,
            messages: [
              ...state.messages,
              userMsg,
              {
                id: generateUuid(),
                role: 'assistant',
                text: replyText,
                timestamp: Date.now() + 1,
              },
            ],
            lastQuestion: null,
          });
          return;
        }

        // Deterministic theme selection
        if (field === 'theme') {
          const newTheme = value as InvitationTheme;
          const defaultTemplate = getDefaultInvitationTemplate(newTheme);
          const newConfig = {
            ...state.config,
            invitationTheme: newTheme,
            invitationTemplate: defaultTemplate,
          };
          const themeLabel = INVITATION_THEMES.find((t) => t.id === newTheme)?.label || newTheme;
          const replyText = `Listo, cambié el tema a ${themeLabel}.`;
          const templateOptions = getTemplateOptionsForTheme(newTheme);
          const nextQ: FieldQuestion | null =
            templateOptions.length > 1
              ? {
                  field: 'template',
                  question: `Elegí una variante para ${themeLabel} (o dejá la opción por defecto):`,
                  quickOptions: templateOptions.map((opt) => ({
                    label: opt.id === defaultTemplate ? `${opt.name} (por defecto)` : opt.name,
                    value: opt.id,
                  })),
                  type: 'choice',
                }
              : null;
          set({
            config: newConfig,
            messages: [
              ...state.messages,
              userMsg,
              {
                id: generateUuid(),
                role: 'assistant',
                text: replyText,
                timestamp: Date.now() + 1,
              },
            ],
            lastQuestion: nextQ,
          });
          return;
        }

        let resolvedValue = value;
        let pendingRollover = state.draft.pendingDayRollover;
        let appliedRollover = state.draft.appliedDayRollover;
        let baseDate = state.draft.baseDate;
        let finalDate = state.draft.date;

        if (field === 'date' && typeof value === 'string' && value) {
          baseDate = value;
          if (pendingRollover || appliedRollover) {
            resolvedValue = addDaysToIsoDate(value, 1) as any;
            finalDate = resolvedValue as any;
            appliedRollover = true;
            pendingRollover = false;
          } else {
            finalDate = value;
            appliedRollover = false;
          }
        } else if (field === 'time') {
          if (baseDate && appliedRollover) {
            finalDate = baseDate;
            appliedRollover = false;
          }
          pendingRollover = false;
        }

        const newDraft: EncounterDraft = {
          ...state.draft,
          [field]: resolvedValue,
          date: finalDate,
          baseDate,
          appliedDayRollover: appliedRollover,
          pendingDayRollover: pendingRollover,
        };

        if (field === 'modality') {
          if (value === 'presencial') {
            newDraft.virtualLink = null;
          } else if (value === 'virtual') {
            newDraft.locationText = null;
          }
        }
        const evaluation = evaluateDraft(newDraft, state.coordinationDetected);

        let assistantReply = '';
        if (evaluation.nextQuestion) {
          assistantReply = evaluation.nextQuestion.question;
        } else if (evaluation.isComplete) {
          assistantReply = '¡Listo! Preparé el resumen con los datos de tu encuentro. Revisalo antes de crear.';
        }

        const newMessages = [...state.messages, userMsg];

        if (assistantReply) {
          const lastMsg = state.messages[state.messages.length - 1];
          if (lastMsg?.text !== assistantReply) {
            newMessages.push({
              id: generateUuid(),
              role: 'assistant',
              text: assistantReply,
              timestamp: Date.now() + 1,
            });
          }
        }

        set({
          draft: newDraft,
          messages: newMessages,
          lastQuestion: evaluation.nextQuestion,
          isComplete: evaluation.isComplete,
          error: evaluation.validationError,
        });
      },

      updateConfigField: (field, value) => {
        set({
          config: { ...get().config, [field]: value },
        });
      },

      dismissCoordinationHandoff: () => {
        const state = get();
        const newDraft = { ...state.draft, dateMode: 'fixed' as const };
        const evaluation = evaluateDraft(newDraft, false);

        const userMsg: ChatMessage = {
          id: generateUuid(),
          role: 'user',
          text: 'Elegir una fecha fija acá',
          timestamp: Date.now(),
        };

        const newMessages = [...state.messages, userMsg];

        let nextReply = '';
        if (evaluation.nextQuestion) {
          nextReply = evaluation.nextQuestion.question;
        } else if (evaluation.isComplete) {
          nextReply = '¡Listo! Preparé el resumen con los datos de tu encuentro. Revisalo antes de crear.';
        }

        if (nextReply) {
          newMessages.push({
            id: generateUuid(),
            role: 'assistant',
            text: nextReply,
            timestamp: Date.now() + 1,
          });
        }

        set({
          draft: newDraft,
          coordinationDetected: false,
          messages: newMessages,
          lastQuestion: evaluation.nextQuestion,
          isComplete: evaluation.isComplete,
          error: evaluation.validationError,
        });
      },

      markFallbackManual: () => {
        const state = get();
        aiService.finishSession({
          sessionId: state.sessionId,
          status: 'fallback_manual',
          turns: state.turns,
          inputTokens: state.totalInputTokens,
          outputTokens: state.totalOutputTokens,
          latencyMs: state.totalLatencyMs,
          elapsedMs: Date.now() - state.startedAt,
          provider: state.providerUsed || state.primaryProvider,
          model: state.modelUsed || undefined,
          metadata: {
            fallbackUsed: state.fallbackUsed,
            primaryProvider: state.primaryProvider,
            fallbackProvider: state.fallbackProvider || undefined,
            providerUsed: state.providerUsed || undefined,
            modelUsed: state.modelUsed || undefined,
            primaryLatencyMs: state.primaryLatencyMs,
            fallbackLatencyMs: state.fallbackLatencyMs,
            totalLatencyMs: state.totalLatencyMs,
            primaryFailureType: state.primaryFailureType || undefined,
            fallbackFailureType: state.fallbackFailureType || undefined,
          },
        });
      },

      startNewAiCreation: () => {
        get().reset();
      },

      reset: () => {
        const newSessionId = generateUuid();
        set({
          sessionId: newSessionId,
          draft: createEmptyEncounterDraft(),
          config: createDefaultInvitationConfig(),
          messages: [],
          turns: 0,
          consecutiveOffTopicCount: 0,
          aiLocked: false,
          totalInputTokens: 0,
          totalOutputTokens: 0,
          totalLatencyMs: 0,
          primaryLatencyMs: 0,
          fallbackLatencyMs: 0,
          fallbackUsed: false,
          primaryProvider: 'openai',
          fallbackProvider: null,
          providerUsed: null,
          modelUsed: null,
          primaryFailureType: null,
          fallbackFailureType: null,
          startedAt: Date.now(),
          isInterpreting: false,
          error: null,
          lastQuestion: null,
          coordinationDetected: false,
          isComplete: false,
          lastUserPrompt: null,
        });
      },
    }),
    {
      name: 'pe-ai-wizard-session',
      storage: createJSONStorage(() =>
        typeof window !== 'undefined' && typeof sessionStorage !== 'undefined'
          ? sessionStorage
          : ({ getItem: () => null, setItem: () => {}, removeItem: () => {} } as any)
      ),
      // Preserve only structured draft, config and session anti-abuse flags; do not persist full textual conversation across browser sessions
      partialize: (state) => ({
        sessionId: state.sessionId,
        draft: state.draft,
        config: state.config,
        turns: state.turns,
        consecutiveOffTopicCount: state.consecutiveOffTopicCount,
        aiLocked: state.aiLocked,
        startedAt: state.startedAt,
        isComplete: state.isComplete,
      }),
    }
  )
);

