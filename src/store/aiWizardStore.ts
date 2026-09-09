import { create } from 'zustand';
import { persist, createJSONStorage } from 'zustand/middleware';
import type { EncounterDraft, InvitationConfig } from '@/lib/encounterDraft';
import { createEmptyEncounterDraft, createDefaultInvitationConfig } from '@/lib/encounterDraft';
import { mergeDraftPatch } from '@/lib/draftMerger';
import { addDaysToIsoDate } from '@/lib/dateResolver';
import { evaluateDraft, type FieldQuestion } from '@/lib/draftFieldEngine';
import { aiService } from '@/services/aiService';

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

  // Actions
  initSession: () => void;
  sendUserMessage: (text: string) => Promise<void>;
  updateDraftField: <K extends keyof EncounterDraft>(field: K, value: EncounterDraft[K]) => void;
  applyQuickOption: <K extends keyof EncounterDraft>(field: K, value: EncounterDraft[K], displayLabel?: string) => void;
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

export const useAiWizardStore = create<AiWizardState>()(
  persist(
    (set, get) => ({
      sessionId: generateUuid(),
      draft: createEmptyEncounterDraft(),
      config: createDefaultInvitationConfig(),
      messages: [],
      turns: 0,
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
            startedAt: Date.now(),
            error: null,
            lastQuestion: null,
            coordinationDetected: false,
            isComplete: false,
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
            error: evaluation.validationError,
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

        const newTurns = state.turns + 1;
        set({
          messages: [...state.messages, userMsg],
          isInterpreting: true,
          error: null,
          turns: newTurns,
        });

        // First message of the session: register start telemetry
        if (newTurns === 1) {
          aiService.startSession(state.sessionId);
        }

        const response = await aiService.interpretMessage(trimmed, state.draft);

        if (!response.ok || !response.patch) {
          set({
            isInterpreting: false,
            error: response.details || 'No pudimos interpretar el mensaje. Intentá de nuevo o completá manualmente.',
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

        // Merge patch deterministically
        const mergeResult = mergeDraftPatch(state.draft, state.config, response.patch);

        // Evaluate draft completeness and select next question
        const evaluation = evaluateDraft(
          mergeResult.draft,
          mergeResult.coordinationDetected,
          mergeResult.ambiguities[0]
        );

        let assistantReply = '';
        if (evaluation.nextQuestion) {
          assistantReply = evaluation.nextQuestion.question;
        } else if (evaluation.isComplete) {
          assistantReply = '¡Listo! Preparé el resumen con los datos de tu encuentro. Revisalo antes de crear.';
        }

        const assistantMsg: ChatMessage | null = assistantReply
          ? {
              id: generateUuid(),
              role: 'assistant',
              text: assistantReply,
              timestamp: Date.now(),
            }
          : null;

        set({
          draft: mergeResult.draft,
          config: mergeResult.config,
          messages: assistantMsg ? [...get().messages, assistantMsg] : get().messages,
          isInterpreting: false,
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
      },

      updateDraftField: (field, value) => {
        const state = get();
        let resolvedValue = value;
        let pendingRollover = state.draft.pendingDayRollover;

        if (field === 'date' && pendingRollover && typeof value === 'string' && value) {
          resolvedValue = addDaysToIsoDate(value, 1) as any;
          pendingRollover = false;
        } else if (field === 'time') {
          pendingRollover = false;
        }

        const newDraft = { ...state.draft, [field]: resolvedValue, pendingDayRollover: pendingRollover };
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

        let resolvedValue = value;
        let pendingRollover = state.draft.pendingDayRollover;

        if (field === 'date' && pendingRollover && typeof value === 'string' && value) {
          resolvedValue = addDaysToIsoDate(value, 1) as any;
          pendingRollover = false;
        } else if (field === 'time') {
          pendingRollover = false;
        }

        const newDraft = { ...state.draft, [field]: resolvedValue, pendingDayRollover: pendingRollover };
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
      // Preserve only structured draft & config; do not persist full textual conversation across browser sessions
      partialize: (state) => ({
        sessionId: state.sessionId,
        draft: state.draft,
        config: state.config,
        turns: state.turns,
        startedAt: state.startedAt,
        isComplete: state.isComplete,
      }),
    }
  )
);

