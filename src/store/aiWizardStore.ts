import { create } from 'zustand';
import { persist, createJSONStorage } from 'zustand/middleware';
import type { EncounterDraft, InvitationConfig } from '@/lib/encounterDraft';
import { createEmptyEncounterDraft, createDefaultInvitationConfig } from '@/lib/encounterDraft';
import { mergeDraftPatch } from '@/lib/draftMerger';
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
  updateConfigField: <K extends keyof InvitationConfig>(field: K, value: InvitationConfig[K]) => void;
  dismissCoordinationHandoff: () => void;
  markFallbackManual: () => void;
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
      startedAt: Date.now(),
      isInterpreting: false,
      error: null,
      lastQuestion: null,
      coordinationDetected: false,
      isComplete: false,

      initSession: () => {
        const currentSession = get().sessionId;
        if (!currentSession) {
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
          });
          aiService.startSession(newSession);
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
          });
          return;
        }

        // Accumulate tokens & latency
        const totalIn = state.totalInputTokens + (response.usage?.inputTokens || 0);
        const totalOut = state.totalOutputTokens + (response.usage?.outputTokens || 0);
        const totalLat = state.totalLatencyMs + (response.usage?.latencyMs || 0);

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
          lastQuestion: evaluation.nextQuestion,
          coordinationDetected: mergeResult.coordinationDetected,
          isComplete: evaluation.isComplete,
          error: evaluation.validationError,
        });
      },

      updateDraftField: (field, value) => {
        const newDraft = { ...get().draft, [field]: value };
        const evaluation = evaluateDraft(newDraft, get().coordinationDetected);
        set({
          draft: newDraft,
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
        const newDraft = { ...get().draft, dateMode: 'fixed' as const };
        const evaluation = evaluateDraft(newDraft, false);
        set({
          draft: newDraft,
          coordinationDetected: false,
          lastQuestion: evaluation.nextQuestion,
          isComplete: evaluation.isComplete,
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
        });
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
      storage: createJSONStorage(() => sessionStorage),
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
