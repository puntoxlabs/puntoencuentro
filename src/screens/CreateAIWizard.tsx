import React, { useState, useEffect, useRef } from 'react';
import { useNavigate } from 'react-router-dom';
import { Send, RefreshCw, AlertCircle, ChevronDown, ChevronUp, Sparkles, CheckCircle2, Mic, Square } from 'lucide-react';
import { AppBar } from '@/components/ui/AppBar';
import { ScreenContainer } from '@/components/ui/ScreenContainer';
import { AIChatMessage } from '@/components/ai/AIChatMessage';
import { FieldQuestion } from '@/components/ai/FieldQuestion';
import { DraftSummary } from '@/components/ai/DraftSummary';
import { FieldEditSheet } from '@/components/ai/FieldEditSheet';
import { useAiWizardStore, isInternalWizardAction } from '@/store/aiWizardStore';
import { type WizardAction, type EditableField, type DateOptionValue } from '@/lib/wizardActions';
import type { InvitationTheme } from '@/lib/invitationThemes';
import { useWizardStore } from '@/store/wizardStore';
import { useCoordinationWizardStore } from '@/store/coordinationWizardStore';
import {
  translateToCreateEncuentroDTO,
  translateToCoordinationPayload,
  draftToWizardState,
  draftToCoordinationDraft,
  hasMeaningfulDraftData,
} from '@/lib/encounterDraft';
import { getPostEventMinutes } from '@/lib/preferencesStorage';
import { rememberEncuentroHost } from '@/lib/meetHostsStorage';
import { encuentrosService } from '@/services/encuentrosService';
import { ensureHostSession } from '@/lib/ensureHostSession';
import { aiService } from '@/services/aiService';
import { supabase } from '@/lib/supabase';
import {
  INVITATION_THEMES,
  getTemplateOptionsForTheme,
  getDefaultInvitationTemplate,
} from '@/lib/invitationThemes';
import { useTranslation } from 'react-i18next';
import { formatHumanSchedule } from '@/lib/formatDate';
import { useSpeechDictation, isTouchDevice, getSpeechRecognitionLocale } from '@/hooks/useSpeechDictation';
import { useAuth } from '@/contexts/AuthContext';
import { getFriendlyAuthError } from '@/hooks/useStartCoordinationEncounter';
import './CreateWizard.css';

export interface CreateAIWizardProps {
  stateOverride?: Partial<ReturnType<typeof useAiWizardStore.getState>>;
  showExitConfirmOverride?: boolean;
  onExitConfirmChange?: (showing: boolean) => void;
  isTouchOverride?: boolean;
  showKeyboardVoiceHintOverride?: boolean;
  speechLangOverride?: string;
}

export const CreateAIWizard: React.FC<CreateAIWizardProps> = ({
  stateOverride,
  showExitConfirmOverride,
  onExitConfirmChange,
  isTouchOverride,
  showKeyboardVoiceHintOverride,
  speechLangOverride,
}) => {
  const navigate = useNavigate();
  const { signInWithGoogleForCoordination } = useAuth();
  const [inputText, setInputText] = useState('');
  const [isCreating, setIsCreating] = useState(false);
  const [creationError, setCreationError] = useState<string | null>(null);
  const [isSummaryExpanded, setIsSummaryExpanded] = useState(false);
  const [showExitConfirm, setShowExitConfirm] = useState(showExitConfirmOverride ?? false);
  const [activeEditField, setActiveEditField] = useState<EditableField | null>(null);
  const activeEditFieldRef = useRef<EditableField | null>(null);
  activeEditFieldRef.current = activeEditField;
  
  const [sheetDiscardRequested, setSheetDiscardRequested] = useState(false);
  const [needsCoordinationAuth, setNeedsCoordinationAuth] = useState(false);
  const [googleLoading, setGoogleLoading] = useState(false);
  const [authError, setAuthError] = useState<string | null>(null);

  const isNavigatingToManualRef = useRef(false);
  const isCreatedRef = useRef(false);
  const hasHistoryGuardRef = useRef(false);
  const isDiscardingRef = useRef(false);
  const coordinationAuthCardRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (showExitConfirmOverride !== undefined) {
      setShowExitConfirm(showExitConfirmOverride);
    }
  }, [showExitConfirmOverride]);

  const updateShowExitConfirm = (val: boolean) => {
    setShowExitConfirm(val);
    onExitConfirmChange?.(val);
  };

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
    lastUserPrompt,
    initSession,
    sendUserMessage,
    retryLastMessage,
    updateDraftField,
    applyQuickOption,
    updateConfigField,
    dismissCoordinationHandoff,
    confirmCoordination,
    switchToFixed,
    markFallbackManual,
    applyDraftOperation,
    reset,
  } = activeState;

  const [isTouch, setIsTouch] = useState<boolean>(() => {
    if (isTouchOverride !== undefined) return isTouchOverride;
    return typeof window !== 'undefined' ? isTouchDevice() : false;
  });

  useEffect(() => {
    if (isTouchOverride !== undefined) {
      setIsTouch(isTouchOverride);
    } else {
      setIsTouch(isTouchDevice());
    }
  }, [isTouchOverride]);

  const [showKeyboardVoiceHint, setShowKeyboardVoiceHint] = useState<boolean>(() => {
    if (showKeyboardVoiceHintOverride !== undefined) return showKeyboardVoiceHintOverride;
    if (typeof window === 'undefined') return false;
    try {
      return localStorage.getItem('pe_voice_keyboard_hint_seen') !== 'true';
    } catch {
      return false;
    }
  });

  useEffect(() => {
    if (showKeyboardVoiceHintOverride !== undefined) {
      setShowKeyboardVoiceHint(showKeyboardVoiceHintOverride);
    }
  }, [showKeyboardVoiceHintOverride]);

  const dismissKeyboardVoiceHint = () => {
    setShowKeyboardVoiceHint(false);
    try {
      localStorage.setItem('pe_voice_keyboard_hint_seen', 'true');
    } catch {}
  };

  const { i18n } = useTranslation();
  const appLanguage = i18n?.language || 'es';

  const effectiveSpeechLocale =
    speechLangOverride || getSpeechRecognitionLocale(appLanguage);

  const {
    isListening,
    isSupported: isSpeechSupported,
    error: dictationError,
    startListening: startDictation,
    stopListening: stopDictation,
    clearError: clearDictationError,
  } = useSpeechDictation({
    lang: effectiveSpeechLocale,
    onTranscriptChange: (newText) => {
      setInputText(newText);
    },
  });

  // Stop recognition if AI starts interpreting or session locks
  useEffect(() => {
    if ((isInterpreting || aiLocked) && isListening) {
      stopDictation();
    }
  }, [isInterpreting, aiLocked, isListening, stopDictation]);

  const hasMeaningfulDraft = hasMeaningfulDraftData(draft, config);

  const hasDraftData = Boolean(
    draft.title ||
    draft.date ||
    draft.time ||
    draft.modality ||
    draft.locationText ||
    draft.virtualLink
  );

  useEffect(() => {
    if (typeof window === 'undefined') return;

    if (
      hasMeaningfulDraft &&
      !hasHistoryGuardRef.current &&
      !isCreatedRef.current &&
      !isNavigatingToManualRef.current &&
      !isDiscardingRef.current
    ) {
      window.history.pushState({ ...window.history.state, aiWizardGuard: true }, '', window.location.href);
      hasHistoryGuardRef.current = true;
    }

    const handlePopState = () => {
      if (isNavigatingToManualRef.current || isCreatedRef.current || isDiscardingRef.current) {
        return;
      }
      if (activeEditFieldRef.current) {
        window.history.pushState({ ...window.history.state, aiWizardGuard: true }, '', window.location.href);
        setSheetDiscardRequested(true);
        return;
      }
      const currentDraft = useAiWizardStore.getState().draft;
      const currentConfig = useAiWizardStore.getState().config;
      if (hasMeaningfulDraftData(currentDraft, currentConfig)) {
        window.history.pushState({ ...window.history.state, aiWizardGuard: true }, '', window.location.href);
        hasHistoryGuardRef.current = true;
        updateShowExitConfirm(true);
      } else {
        hasHistoryGuardRef.current = false;
      }
    };

    window.addEventListener('popstate', handlePopState);
    return () => {
      window.removeEventListener('popstate', handlePopState);
    };
  }, [hasMeaningfulDraft]);

  const handleKeepEditing = () => {
    updateShowExitConfirm(false);
  };

  const handleDiscardAndExit = () => {
    if (isListening) {
      stopDictation();
    }
    isDiscardingRef.current = true;
    hasHistoryGuardRef.current = false;
    updateShowExitConfirm(false);
    reset();
    try {
      sessionStorage.removeItem('cancel_reference');
    } catch (e) {}
    navigate('/', { replace: true });
  };

  const handleBack = () => {
    if (isListening) {
      stopDictation();
    }
    if (hasMeaningfulDraft && !isCreatedRef.current) {
      updateShowExitConfirm(true);
    } else {
      navigate('/');
    }
  };

  const activeThemeConfig = INVITATION_THEMES.find((t) => t.id === config.invitationTheme);
  const themeTemplates = getTemplateOptionsForTheme(config.invitationTheme);
  const defaultTemplate = getDefaultInvitationTemplate(config.invitationTheme);
  const activeTemplate = themeTemplates.find(
    (t) => t.id === (config.invitationTemplate || defaultTemplate)
  );
  const themeLabel = activeThemeConfig?.label || 'Clásico';
  const variantLabel = activeTemplate ? ` (${activeTemplate.name})` : '';

  let scheduleText = formatHumanSchedule(draft.date, draft.time, { locale: appLanguage });
  if (draft.dateMode === 'coordination' && draft.dateOptions && draft.dateOptions.length > 0) {
    scheduleText = `${draft.dateOptions.length} opciones`;
  } else if (draft.pendingTemporalAlternatives && draft.pendingTemporalAlternatives.length > 0) {
    scheduleText = `${draft.pendingTemporalAlternatives.length} opciones`;
  } else if (draft.pendingTimeOptions && draft.pendingTimeOptions.length > 0 && !draft.dateOptions) {
    scheduleText = `${draft.pendingTimeOptions.length} horarios`;
  }
  const placeText = draft.locationText || (draft.modality === 'virtual' ? 'Virtual' : draft.modality === 'presencial' ? 'Presencial' : null);
  const themeText = themeLabel ? `${themeLabel}${variantLabel}` : null;
  const metadataText = [scheduleText, placeText, themeText].filter(Boolean).join(' · ');

  const lastAssistantIndex = messages.map((m) => m.role).lastIndexOf('assistant');
  const lastUserIndex = messages.map((m) => m.role).lastIndexOf('user');

  const prevMessagesCountRef = useRef(messages.length);
  const prevInterpretingRef = useRef(isInterpreting);

  useEffect(() => {
    initSession();
  }, [initSession]);

  const [isSlowResponse, setIsSlowResponse] = useState(false);

  useEffect(() => {
    let timer: any = null;
    if (isInterpreting) {
      setIsSlowResponse(false);
      timer = setTimeout(() => {
        setIsSlowResponse(true);
      }, 10000);
    } else {
      setIsSlowResponse(false);
    }
    return () => {
      if (timer) clearTimeout(timer);
    };
  }, [isInterpreting]);

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
    if (hasMeaningfulDraft) {
      if (typeof window !== 'undefined' && typeof window.confirm === 'function' && !window.confirm('¿Reiniciar la conversación? Se perderán los datos del borrador actual.')) {
        return;
      }
    }
    setIsSummaryExpanded(false);
    reset();
  };

  const handleSend = async () => {
    if (isListening) {
      stopDictation();
    }
    if (!inputText.trim() || isInterpreting || isCreating || aiLocked) return;
    const text = inputText;
    setInputText('');
    dismissKeyboardVoiceHint();
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
    if (
      value === 'confirm_coordination' ||
      (lastQuestion?.field === 'coordination_confirm' && value === 'confirm_coordination')
    ) {
      confirmCoordination();
      return;
    }

    if (value === 'keep_fixed') {
      if (
        lastQuestion?.field === 'coordination_confirm' ||
        lastQuestion?.type === 'coordination_card' ||
        (draft.dateOptions && draft.dateOptions.length > 0)
      ) {
        applyQuickOption('coordination_confirm', 'keep_fixed');
      } else {
        dismissCoordinationHandoff();
      }
      setTimeout(() => inputRef.current?.focus(), 100);
      return;
    }

    if (typeof value === 'string' && value.startsWith('fixed_opt_')) {
      applyQuickOption('date', value);
      setTimeout(() => inputRef.current?.focus(), 100);
      return;
    }

    if (isInternalWizardAction(value)) {
      return;
    }

    if (lastQuestion) {
      const option = lastQuestion.quickOptions?.find((opt) => opt.value === value);
      const rawLabel = option?.label || value;
      const displayLabel = rawLabel.replace(/^[^\p{L}\p{N}]+\s*/u, '').trim() || value;

      if (lastQuestion.field === 'coordination_confirm') {
        if (value === 'confirm_coordination') {
          confirmCoordination();
          return;
        }
        if (value === 'keep_fixed') {
          applyQuickOption('coordination_confirm', 'keep_fixed');
          return;
        }
      }

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
    navigate('/create/coordination', { state: { seeded: true } });
  };

  const handleFallbackManual = () => {
    if (isListening) {
      stopDictation();
    }
    isNavigatingToManualRef.current = true;
    const wizardPartial = draftToWizardState(draft, config);
    const wizardStore = useWizardStore.getState();

    // Copy all gathered fields into the manual wizard
    Object.entries(wizardPartial).forEach(([key, val]) => {
      wizardStore.setField(key, val);
    });

    markFallbackManual();
    navigate('/create');
  };

  const dispatchWizardAction = (action: WizardAction) => {
    switch (action.type) {
      case 'edit_field':
        setActiveEditField(action.field);
        break;
      case 'confirm_coordination':
        confirmCoordination();
        break;
      case 'keep_fixed':
        applyQuickOption('coordination_confirm', 'keep_fixed');
        break;
      case 'choose_fixed_option':
        if (applyDraftOperation) {
          applyDraftOperation({
            type: 'convert_to_fixed',
            option: { date: action.date, time: action.time },
          });
        } else {
          switchToFixed({ date: action.date, time: action.time });
        }
        break;
      case 'open_manual_form':
        handleFallbackManual();
        break;
      case 'reset':
        reset();
        break;
    }
  };

  const handleSaveDateOptions = (options: DateOptionValue[]) => {
    if (applyDraftOperation) {
      applyDraftOperation({ type: 'set_date_options', options });
    } else {
      updateDraftField('dateOptions', options);
      updateDraftField('dateMode', 'coordination');
    }
  };

  const handleConvertToFixedFromOption = (option: DateOptionValue) => {
    if (applyDraftOperation) {
      applyDraftOperation({ type: 'convert_to_fixed', option });
    } else {
      switchToFixed(option);
    }
  };

  const handleSaveFixedDateTime = (date: string, time: string) => {
    if (applyDraftOperation) {
      applyDraftOperation({ type: 'set_fixed_datetime', date, time });
    } else {
      updateDraftField('date', date);
      updateDraftField('time', time);
      updateDraftField('dateMode', 'fixed');
      updateDraftField('dateOptions', null);
    }
  };

  const handleSaveTitle = (title: string) => {
    if (applyDraftOperation) {
      applyDraftOperation({ type: 'set_title', title });
    } else {
      updateDraftField('title', title);
    }
  };

  const handleSaveLocation = (modality: 'presencial' | 'virtual', value: string) => {
    if (applyDraftOperation) {
      applyDraftOperation({ type: 'set_location', modality, value });
    } else {
      updateDraftField('modality', modality);
      if (modality === 'virtual') {
        updateDraftField('virtualLink', value);
      } else {
        updateDraftField('locationText', value);
      }
    }
  };

  const handleSaveTheme = (theme: InvitationTheme, templateId?: string) => {
    if (applyDraftOperation) {
      applyDraftOperation({ type: 'set_theme', theme, templateId });
    } else {
      updateConfigField('invitationTheme', theme);
      if (templateId) {
        updateConfigField('invitationTemplate', templateId);
      }
    }
  };

  const handleGoogleSignIn = async () => {
    if (googleLoading) return;
    setGoogleLoading(true);
    setAuthError(null);

    try {
      sessionStorage.setItem('post_auth_redirect', '/create/ai');
      const result = await signInWithGoogleForCoordination();

      if (result && result.ok === false) {
        sessionStorage.removeItem('post_auth_redirect');
        setAuthError(getFriendlyAuthError(result.error));
      }
    } catch (error) {
      sessionStorage.removeItem('post_auth_redirect');
      console.error('[CreateAI] Google sign-in failed', error);
      setAuthError(getFriendlyAuthError());
    } finally {
      setGoogleLoading(false);
    }
  };

  const handleConfirmCreate = async () => {
    if (isCreating) return;
    setIsCreating(true);
    setCreationError(null);
    setNeedsCoordinationAuth(false);

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

      // 3. Assemble metadata
      const creationMeta = {
        hostId,
        replacesEncounterId,
        postEventActiveMinutes: getPostEventMinutes(),
      };

      // 4. Branch by dateMode: coordination vs fixed
      if (draft.dateMode === 'coordination') {
        const { data: authData } = await supabase.auth.getUser();
        const isPermanent = authData?.user && !authData.user.is_anonymous;
        if (!isPermanent) {
          setNeedsCoordinationAuth(true);
          setIsCreating(false);
          setTimeout(() => {
            coordinationAuthCardRef.current?.scrollIntoView({ behavior: 'smooth', block: 'center' });
          }, 50);
          return;
        }

        const { payload, opciones } = translateToCoordinationPayload(draft, config, creationMeta);
        const result = await encuentrosService.crearEncuentroConOpciones(payload, opciones);

        if (!result.ok) {
          throw new Error(result.error || 'Error al guardar el encuentro coordinado');
        }

        const encounterId = result.encuentro.id;
        rememberEncuentroHost(encounterId, hostId);

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

        isCreatedRef.current = true;
        reset();
        sessionStorage.removeItem('cancel_reference');

        navigate(`/coordination/${encounterId}`, { replace: true });
        return;
      }

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
      isCreatedRef.current = true;
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
        title={
          <span style={{ display: 'inline-flex', alignItems: 'center', gap: '8px' }}>
            <span>Crear con IA</span>
            <span
              data-testid="beta-badge"
              style={{
                fontSize: '11px',
                fontWeight: 600,
                padding: '2px 7px',
                borderRadius: '9999px',
                background: 'var(--color-surface-variant, #f1f5f9)',
                color: 'var(--color-on-surface-variant, #64748b)',
                border: '1px solid var(--color-outline-variant, #e2e8f0)',
                lineHeight: 1.2,
                letterSpacing: '0.02em',
              }}
            >
              Beta
            </span>
          </span>
        }
        showBack
        onBack={handleBack}
        rightAction={
          <button
            type="button"
            data-testid="ai-wizard-reset-button"
            onClick={handleReset}
            aria-label="Reiniciar conversación"
            title="Reiniciar conversación"
            style={{
              background: 'none',
              border: 'none',
              color: 'var(--color-on-surface-variant, #64748b)',
              cursor: 'pointer',
              padding: '8px',
              borderRadius: '50%',
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              transition: 'background-color 0.15s ease',
            }}
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
            boxShadow: '0 1px 3px rgba(0,0,0,0.02)',
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
                  display: 'flex',
                  alignItems: 'center',
                  gap: '8px',
                }}
              >
                <span
                  style={{
                    fontSize: '15px',
                    fontWeight: 700,
                    color: 'var(--color-on-surface, #0f172a)',
                    overflow: 'hidden',
                    textOverflow: 'ellipsis',
                    whiteSpace: 'nowrap',
                  }}
                >
                  {draft.title || 'Nuevo encuentro'}
                </span>
                {isComplete && (
                  <span
                    data-testid="draft-ready-badge"
                    style={{
                      fontSize: '11px',
                      fontWeight: 600,
                      padding: '1px 6px',
                      borderRadius: '6px',
                      background: '#dcfce7',
                      color: '#15803d',
                      whiteSpace: 'nowrap',
                      flexShrink: 0,
                    }}
                  >
                    Listo para crear
                  </span>
                )}
              </div>
              {metadataText && (
                <div
                  style={{
                    fontSize: '13px',
                    color: 'var(--color-on-surface-variant, #64748b)',
                    overflow: 'hidden',
                    textOverflow: 'ellipsis',
                    whiteSpace: 'nowrap',
                    marginTop: '1px',
                  }}
                >
                  {metadataText}
                </div>
              )}
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
              display: 'inline-flex',
              alignItems: 'center',
              gap: '4px',
              padding: '6px 10px',
              borderRadius: '8px',
              border: '1px solid var(--color-outline-variant, #e2e8f0)',
              background: isSummaryExpanded ? 'var(--color-surface-variant, #f1f5f9)' : 'transparent',
              color: 'var(--color-primary, #4f46e5)',
              fontSize: '13px',
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
                <span>Resumen</span>
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
            onAction={dispatchWizardAction}
            onModify={(field) => {
              if (field === 'coordination_options' || field === 'date_options') {
                dispatchWizardAction({ type: 'edit_field', field: 'date_options' });
              } else if (field === 'date' || field === 'fixed_datetime') {
                dispatchWizardAction({ type: 'edit_field', field: 'fixed_datetime' });
              } else if (field === 'title') {
                dispatchWizardAction({ type: 'edit_field', field: 'title' });
              } else if (field === 'locationText' || field === 'virtualLink' || field === 'location') {
                dispatchWizardAction({ type: 'edit_field', field: 'location' });
              } else if (field === 'theme') {
                dispatchWizardAction({ type: 'edit_field', field: 'theme' });
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
          <div
            data-testid="ai-welcome-state"
            style={{
              textAlign: 'center',
              margin: 'auto 0',
              padding: '24px 16px',
              maxWidth: '420px',
              alignSelf: 'center',
              width: '100%',
            }}
          >
            <h2
              style={{
                fontSize: '18px',
                fontWeight: 700,
                margin: '0 0 6px 0',
                color: 'var(--color-on-surface, #0f172a)',
                letterSpacing: '-0.2px',
              }}
            >
              Contame qué querés organizar
            </h2>
            <p
              style={{
                fontSize: '14px',
                color: 'var(--color-on-surface-variant, #64748b)',
                margin: '0 0 20px 0',
                lineHeight: 1.5,
              }}
            >
              Podés decirlo como te salga.
            </p>

            <div
              style={{
                display: 'flex',
                flexDirection: 'column',
                gap: '8px',
                alignItems: 'center',
              }}
            >
              {[
                'Cena mañana a las 21',
                'Cena viernes o sábado a las 21',
                'Cumpleaños familiar',
              ].map((example, idx) => (
                <button
                  key={example}
                  type="button"
                  data-testid={`example-prompt-${idx}`}
                  onClick={() => {
                    setInputText(example);
                    inputRef.current?.focus();
                  }}
                  style={{
                    background: 'var(--color-surface, #ffffff)',
                    border: '1px solid var(--color-outline-variant, #e2e8f0)',
                    borderRadius: '20px',
                    padding: '8px 16px',
                    fontSize: '13px',
                    color: 'var(--color-on-surface, #334155)',
                    cursor: 'pointer',
                    boxShadow: '0 1px 2px rgba(0,0,0,0.03)',
                    transition: 'all 0.15s ease',
                    textAlign: 'center',
                  }}
                >
                  "{example}"
                </button>
              ))}
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
          <div
            data-testid="interpreting-indicator"
            style={{ display: 'flex', alignItems: 'center', gap: '8px', color: '#64748b', fontSize: '13px', margin: '8px 0' }}
          >
            <span className="spinner" style={{ width: '16px', height: '16px', border: '2px solid #e2e8f0', borderTopColor: '#4f46e5', borderRadius: '50%', animation: 'spin 1s linear infinite' }} />
            <span>{isSlowResponse ? 'Está tardando un poco más de lo habitual...' : 'Interpretando...'}</span>
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
              onAction={dispatchWizardAction}
              onModify={(field) => {
                if (field === 'coordination_options' || field === 'date_options') {
                  dispatchWizardAction({ type: 'edit_field', field: 'date_options' });
                } else if (field === 'date' || field === 'fixed_datetime') {
                  dispatchWizardAction({ type: 'edit_field', field: 'fixed_datetime' });
                } else if (field === 'title') {
                  dispatchWizardAction({ type: 'edit_field', field: 'title' });
                } else if (field === 'locationText' || field === 'virtualLink' || field === 'location') {
                  dispatchWizardAction({ type: 'edit_field', field: 'location' });
                } else if (field === 'theme') {
                  dispatchWizardAction({ type: 'edit_field', field: 'theme' });
                }
              }}
              onFallbackManual={handleFallbackManual}
              onChangeConfig={updateConfigField}
            />
          </div>
        )}

        {/* Coordination Auth Required Card */}
        {needsCoordinationAuth && (
          <div
            ref={coordinationAuthCardRef}
            data-testid="coordination-auth-card"
            style={{
              display: 'flex',
              flexDirection: 'column',
              gap: '12px',
              padding: '16px',
              borderRadius: '16px',
              background: 'var(--color-surface, #ffffff)',
              border: '1px solid var(--color-outline-variant, #e2e8f0)',
              boxShadow: '0 4px 12px rgba(0,0,0,0.05)',
              margin: '12px 0',
              textAlign: 'center',
              alignItems: 'center',
            }}
          >
            <div style={{ display: 'flex', flexDirection: 'column', gap: '4px' }}>
              <span style={{ fontSize: '15px', fontWeight: 600, color: 'var(--color-on-surface, #0f172a)' }}>
                Para crear una coordinación necesitás iniciar sesión
              </span>
              <span style={{ fontSize: '13px', color: 'var(--color-on-surface-variant, #64748b)' }}>
                Guardamos las respuestas de tus invitados vinculadas a tu cuenta.
              </span>
            </div>

            {authError && (
              <div style={{ backgroundColor: '#fef2f2', border: '1px solid #fecaca', padding: '8px 12px', borderRadius: '8px', width: '100%' }}>
                <p style={{ color: '#dc2626', margin: 0, fontSize: '13px' }}>{authError}</p>
              </div>
            )}

            <button
              type="button"
              data-testid="google-signin-coordination-button"
              disabled={googleLoading}
              onClick={handleGoogleSignIn}
              style={{
                display: 'inline-flex',
                alignItems: 'center',
                justifyContent: 'center',
                gap: '10px',
                width: '100%',
                maxWidth: '280px',
                padding: '12px 20px',
                borderRadius: '12px',
                background: '#ffffff',
                border: '1px solid #cbd5e1',
                color: '#1e293b',
                fontSize: '14px',
                fontWeight: 600,
                cursor: googleLoading ? 'wait' : 'pointer',
                boxShadow: '0 1px 2px rgba(0,0,0,0.05)',
                transition: 'background-color 0.15s ease',
              }}
            >
              {googleLoading ? (
                'Conectando...'
              ) : (
                <>
                  <svg width="18" height="18" viewBox="0 0 48 48" aria-hidden="true">
                    <path fill="#EA4335" d="M24 9.5c3.54 0 6.71 1.22 9.21 3.6l6.85-6.85C35.9 2.38 30.47 0 24 0 14.62 0 6.51 5.38 2.56 13.22l7.98 6.19C12.43 13.72 17.74 9.5 24 9.5z"/>
                    <path fill="#4285F4" d="M46.98 24.55c0-1.57-.15-3.09-.38-4.55H24v9.02h12.94c-.58 2.96-2.26 5.48-4.78 7.18l7.73 6c4.51-4.18 7.09-10.36 7.09-17.65z"/>
                    <path fill="#FBBC05" d="M10.53 28.59c-.48-1.45-.76-2.99-.76-4.59s.27-3.14.76-4.59l-7.98-6.19C.92 16.46 0 20.12 0 24c0 3.88.92 7.54 2.56 10.78l7.97-6.19z"/>
                    <path fill="#34A853" d="M24 48c6.48 0 11.93-2.13 15.89-5.81l-7.73-6c-2.15 1.45-4.92 2.3-8.16 2.3-6.26 0-11.57-4.22-13.47-9.91l-7.98 6.19C6.51 42.62 14.62 48 24 48z"/>
                  </svg>
                  <span>Iniciar sesión con Google</span>
                </>
              )}
            </button>
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
            <div style={{ display: 'flex', gap: '8px', flexWrap: 'wrap', marginTop: '4px' }}>
              {!aiLocked && lastUserPrompt && !isInterpreting && (
                <button
                  type="button"
                  data-testid="retry-ai-button"
                  onClick={() => retryLastMessage()}
                  style={{
                    background: 'var(--color-primary, #4f46e5)',
                    border: 'none',
                    borderRadius: '6px',
                    padding: '6px 12px',
                    fontSize: '12px',
                    fontWeight: 600,
                    color: '#ffffff',
                    cursor: 'pointer',
                    display: 'flex',
                    alignItems: 'center',
                    gap: '4px',
                  }}
                >
                  <RefreshCw size={12} />
                  Reintentar
                </button>
              )}
              {(aiError || aiLocked) && (
                <button
                  type="button"
                  data-testid="continue-manually-button"
                  onClick={handleFallbackManual}
                  style={{
                    background: '#ffffff',
                    border: '1px solid #fca5a5',
                    borderRadius: '6px',
                    padding: '6px 12px',
                    fontSize: '12px',
                    fontWeight: 600,
                    color: '#991b1b',
                    cursor: 'pointer',
                  }}
                >
                  Continuar manualmente →
                </button>
              )}
            </div>
          </div>
        )}
      </div>

      {/* Input Bar */}
      <div
        style={{
          borderTop: '1px solid var(--color-outline-variant, #e2e8f0)',
          background: 'var(--color-surface, #ffffff)',
          padding: '12px 16px calc(12px + env(safe-area-inset-bottom, 0px)) 16px',
          position: 'sticky',
          bottom: 0,
          zIndex: 10,
        }}
      >
        <div style={{ display: 'flex', gap: '8px', alignItems: 'center' }}>
          <textarea
            ref={inputRef}
            value={inputText}
            onChange={(e) => setInputText(e.target.value)}
            onKeyDown={handleKeyDown}
            placeholder={
              aiLocked
                ? 'Crear con IA no disponible para este borrador'
                : lastQuestion
                ? 'Respondé acá...'
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
              minHeight: '46px',
              maxHeight: '120px',
              padding: '11px 16px',
              borderRadius: '22px',
              border: '1px solid var(--color-outline, #cbd5e1)',
              background: aiLocked ? '#f1f5f9' : 'var(--color-surface-variant, #f8fafc)',
              color: aiLocked ? '#94a3b8' : 'var(--color-on-surface, #0f172a)',
              fontSize: '16px',
              lineHeight: 1.45,
              resize: 'none',
              fontFamily: 'inherit',
              outline: 'none',
              cursor: aiLocked ? 'not-allowed' : 'text',
              boxSizing: 'border-box',
            }}
          />

          {/* Desktop Voice Dictation Button (visible on non-touch/desktop devices when Web Speech is supported).
              Privacidad: PuntoEncuentro no graba, almacena ni envía audio a sus propios servidores
              ni a OpenAI/Mistral. El reconocimiento de voz es gestionado por el navegador o sistema operativo
              según sus propias políticas. */}
          {!isTouch && isSpeechSupported && (
            <button
              type="button"
              data-testid="speech-dictation-button"
              onClick={() => {
                if (isListening) {
                  stopDictation();
                } else {
                  startDictation(inputText);
                }
              }}
              disabled={isInterpreting || isCreating || aiLocked}
              title={isListening ? 'Detener dictado por voz' : 'Iniciar dictado por voz'}
              aria-label={isListening ? 'Detener dictado por voz' : 'Iniciar dictado por voz'}
              style={{
                width: '44px',
                height: '44px',
                borderRadius: '50%',
                background: isListening
                  ? '#fee2e2'
                  : 'var(--color-surface-variant, #f1f5f9)',
                color: isListening
                  ? '#ef4444'
                  : 'var(--color-on-surface-variant, #64748b)',
                border: isListening
                  ? '1px solid #fca5a5'
                  : '1px solid var(--color-outline-variant, #e2e8f0)',
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                cursor: isInterpreting || isCreating || aiLocked ? 'not-allowed' : 'pointer',
                flexShrink: 0,
                transition: 'all 0.2s',
              }}
            >
              {isListening ? <Square size={16} fill="currentColor" /> : <Mic size={18} />}
            </button>
          )}

          <button
            type="button"
            onClick={handleSend}
            disabled={!inputText.trim() || isInterpreting || isCreating || aiLocked || isListening}
            title="Enviar mensaje"
            aria-label="Enviar mensaje"
            style={{
              width: '44px',
              height: '44px',
              borderRadius: '50%',
              background:
                inputText.trim() && !isInterpreting && !aiLocked && !isListening
                  ? 'var(--color-primary, #4f46e5)'
                  : '#f1f5f9',
              color:
                inputText.trim() && !isInterpreting && !aiLocked && !isListening
                  ? '#ffffff'
                  : '#94a3b8',
              border:
                inputText.trim() && !isInterpreting && !aiLocked && !isListening
                  ? 'none'
                  : '1px solid var(--color-outline-variant, #e2e8f0)',
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              cursor:
                inputText.trim() && !isInterpreting && !aiLocked && !isListening
                  ? 'pointer'
                  : 'default',
              flexShrink: 0,
              transition: 'background 0.15s ease',
            }}
          >
            <Send size={18} />
          </button>
        </div>

        {/* Listening indicator */}
        {isListening && (
          <div
            data-testid="speech-listening-indicator"
            style={{
              display: 'flex',
              alignItems: 'center',
              gap: '6px',
              marginTop: '6px',
              fontSize: '12px',
              color: '#dc2626',
              fontWeight: 500,
            }}
          >
            <span
              style={{
                width: '8px',
                height: '8px',
                borderRadius: '50%',
                background: '#dc2626',
                display: 'inline-block',
              }}
            />
            <span>Escuchando... Hablá para dictar tu encuentro</span>
          </div>
        )}

        {/* Dictation error notice */}
        {dictationError && (
          <div
            data-testid="speech-dictation-error"
            style={{
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'space-between',
              gap: '8px',
              marginTop: '6px',
              padding: '4px 10px',
              borderRadius: '6px',
              background: '#fef2f2',
              border: '1px solid #fee2e2',
              fontSize: '12px',
              color: '#991b1b',
            }}
          >
            <span>{dictationError.message}</span>
            <button
              type="button"
              onClick={clearDictationError}
              aria-label="Cerrar aviso"
              style={{
                background: 'none',
                border: 'none',
                color: '#991b1b',
                cursor: 'pointer',
                padding: '0 4px',
                fontSize: '14px',
                lineHeight: 1,
              }}
            >
              ✕
            </button>
          </div>
        )}

        {/* Mobile keyboard voice hint */}
        {isTouch && showKeyboardVoiceHint && (
          <div
            data-testid="keyboard-voice-hint"
            style={{
              fontSize: '12px',
              color: 'var(--color-on-surface-variant, #64748b)',
              marginTop: '6px',
              textAlign: 'center',
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              gap: '4px',
            }}
          >
            <Mic size={13} style={{ opacity: 0.7 }} />
            <span>También podés dictar usando el micrófono del teclado.</span>
            <button
              type="button"
              onClick={dismissKeyboardVoiceHint}
              aria-label="Cerrar sugerencia"
              style={{
                background: 'none',
                border: 'none',
                color: 'var(--color-on-surface-variant, #94a3b8)',
                cursor: 'pointer',
                padding: '2px 4px',
                fontSize: '11px',
                marginLeft: '4px',
              }}
            >
              ✕
            </button>
          </div>
        )}

        {/* Fallback to manual link */}
        <div style={{ textAlign: 'center', marginTop: '4px' }}>
          <button
            type="button"
            data-testid="fallback-manual-button"
            onClick={handleFallbackManual}
            style={{
              background: 'none',
              border: 'none',
              fontSize: '13px',
              fontWeight: 500,
              color: 'var(--color-on-surface-variant, #64748b)',
              cursor: 'pointer',
              minHeight: '44px',
              padding: '8px 16px',
              borderRadius: '8px',
              display: 'inline-flex',
              alignItems: 'center',
              justifyContent: 'center',
              transition: 'color 0.15s ease',
            }}
          >
            Usar formulario manual
          </button>
        </div>
      </div>

      {/* Modal de confirmación de salida con borrador */}
      {showExitConfirm && (
        <div
          data-testid="exit-confirm-modal"
          role="dialog"
          aria-modal="true"
          aria-labelledby="exit-confirm-title"
          style={{
            position: 'fixed',
            top: 0,
            left: 0,
            width: '100%',
            height: '100%',
            backgroundColor: 'rgba(15, 23, 42, 0.6)',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            zIndex: 1000,
            padding: '20px',
          }}
        >
          <div
            style={{
              background: 'var(--color-surface, #ffffff)',
              borderRadius: '24px',
              padding: '24px',
              width: '100%',
              maxWidth: '400px',
              boxShadow: '0 20px 25px -5px rgba(0,0,0,0.1)',
            }}
          >
            <h3
              id="exit-confirm-title"
              data-testid="exit-confirm-title"
              style={{
                fontSize: '18px',
                fontWeight: 700,
                margin: '0 0 8px 0',
                color: 'var(--color-on-surface, #0f172a)',
              }}
            >
              ¿Salir de Crear con IA?
            </h3>
            <p
              data-testid="exit-confirm-description"
              style={{
                margin: '0 0 24px 0',
                color: 'var(--color-on-surface-variant, #64748b)',
                fontSize: '14px',
                lineHeight: 1.5,
              }}
            >
              Vas a perder los datos cargados de este encuentro.
            </p>
            <div style={{ display: 'flex', flexDirection: 'column', gap: '10px' }}>
              <button
                type="button"
                data-testid="exit-confirm-keep-editing"
                onClick={handleKeepEditing}
                style={{
                  width: '100%',
                  padding: '12px 16px',
                  borderRadius: '12px',
                  background: 'var(--color-primary, #4f46e5)',
                  color: '#ffffff',
                  border: 'none',
                  fontSize: '14px',
                  fontWeight: 600,
                  cursor: 'pointer',
                }}
              >
                Seguir editando
              </button>
              <button
                type="button"
                data-testid="exit-confirm-discard-and-exit"
                onClick={handleDiscardAndExit}
                style={{
                  width: '100%',
                  padding: '12px 16px',
                  borderRadius: '12px',
                  background: 'transparent',
                  color: '#dc2626',
                  border: '1px solid #fecaca',
                  fontSize: '14px',
                  fontWeight: 600,
                  cursor: 'pointer',
                }}
              >
                Descartar y salir
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Structured Field Edit Bottom Sheet */}
      <FieldEditSheet
        field={activeEditField}
        draft={draft}
        config={config}
        isOpen={activeEditField !== null}
        onClose={() => setActiveEditField(null)}
        externalDiscardRequest={sheetDiscardRequested}
        onExternalDiscardHandled={() => setSheetDiscardRequested(false)}
        onSaveDateOptions={handleSaveDateOptions}
        onConvertToFixedFromOption={handleConvertToFixedFromOption}
        onSaveFixedDateTime={handleSaveFixedDateTime}
        onSaveTitle={handleSaveTitle}
        onSaveLocation={handleSaveLocation}
        onSaveTheme={handleSaveTheme}
      />
    </ScreenContainer>
  );
};

export default CreateAIWizard;

