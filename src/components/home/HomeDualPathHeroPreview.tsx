import React, { useState } from 'react';
import { CalendarPlus, CheckCircle2, Sparkles, ArrowRight, X } from 'lucide-react';
import { Button } from '@/components/ui/Button';
import { HomeIntentInput } from './HomeIntentInput';
import { HomeSuggestionChips, type SuggestionOption } from './HomeSuggestionChips';
import './HomeDualPathHeroPreview.css';

export type HomeV3Variant = 'v3a' | 'v3b';

export interface HomeDualPathHeroPreviewProps {
  /** Propuesta visual V3: 'v3a' (Camino A destacado arriba) o 'v3b' (jerarquía equilibrada) */
  variant?: HomeV3Variant;
  /** Callback conectado al flujo directo existente (handleCreateClick) */
  onCreateInvitationClick: () => void;
  /** Callback conectado al flujo de intención / IA existente (handleIntentSubmit) */
  onIntentSubmit: (intentText: string) => void;
  /** Valor controlado opcional del campo de intención */
  intentValue?: string;
  /** Callback controlado opcional al cambiar el texto de intención */
  onIntentChange?: (value: string) => void;
  /** Chips opcionales para rellenar rápidamente la intención */
  suggestions?: SuggestionOption[];
  /** Estado de carga opcional mientras inicia el flujo de intención */
  isSubmittingIntent?: boolean;
  /** Notifica cambios de foco del campo de intención (Modo Calma GSAP y FAB móvil) */
  onFocusChange?: (isFocused: boolean) => void;
  /** Notifica cambios de dictado por voz */
  isListeningChange?: (isListening: boolean) => void;
}

const INVITATION_EXAMPLES = [
  { icon: '🎂', label: 'Cumpleaños' },
  { icon: '🍽️', label: 'Asado / cena' },
  { icon: '⚽', label: 'Partido' },
  { icon: '☕', label: 'Salida' },
];

const DEFAULT_INTENT_CHIPS: SuggestionOption[] = [
  { icon: '🎾', label: 'Jugar al pádel', prompt: 'Quiero jugar al pádel este sábado' },
  { icon: '🍕', label: 'Juntarnos a comer', prompt: 'Quiero juntarnos a comer unas pizzas con amigos' },
  { icon: '☕', label: 'Tomar un café', prompt: 'Quiero tomar un café con amigos esta semana' },
];

/**
 * Hero Dual-Path para Home V3 (propuestas V3-A y V3-B).
 * Conserva el ADN visual de Home V2 + GSAP y presenta de forma explícita ambos caminos:
 * - Camino A: "Organizá con tu gente" (invitaciones privadas sin registro para invitados)
 * - Camino B: "Tengo ganas de…" (expresión libre de intenciones / ideas / planes abiertos)
 */
export const HomeDualPathHeroPreview: React.FC<HomeDualPathHeroPreviewProps> = ({
  variant = 'v3b',
  onCreateInvitationClick,
  onIntentSubmit,
  intentValue,
  onIntentChange,
  suggestions = DEFAULT_INTENT_CHIPS,
  isSubmittingIntent = false,
  onFocusChange,
  isListeningChange,
}) => {
  const [internalIntent, setInternalIntent] = useState('');
  const isControlled = typeof intentValue === 'string';
  const currentIntent = isControlled ? intentValue : internalIntent;
  const trimmedIntent = currentIntent.trim();

  const updateIntent = (nextValue: string) => {
    if (!isControlled) {
      setInternalIntent(nextValue);
    }
    onIntentChange?.(nextValue);
  };

  const handleIntentFormSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (!trimmedIntent || isSubmittingIntent) return;
    onIntentSubmit(trimmedIntent);
  };

  const handleDirectIntentSubmit = () => {
    if (!trimmedIntent || isSubmittingIntent) return;
    onIntentSubmit(trimmedIntent);
  };

  const handleTextareaKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if ((e.key === 'Enter' && !e.shiftKey) || ((e.ctrlKey || e.metaKey) && e.key === 'Enter')) {
      e.preventDefault();
      if (trimmedIntent && !isSubmittingIntent) {
        onIntentSubmit(trimmedIntent);
      }
    }
  };

  const handleSelectChip = (prompt: string) => {
    updateIntent(prompt);
  };

  return (
    <section
      className={`home-dual-hero home-dual-hero--${variant}`}
      aria-labelledby="home-dual-hero-heading"
      data-testid="home-dual-path-hero-preview"
      data-home-v3-variant={variant}
    >
      <div className="home-dual-hero__header">
        <div className="home-dual-hero__eyebrow home-hero-badge">
          <span>PLANES · PERSONAS · ENCUENTROS REALES</span>
        </div>

        <h1 id="home-dual-hero-heading" className="home-dual-hero__title">
          ¿Qué querés <span className="home-dual-hero__title-accent">hacer?</span>
        </h1>

        <p className="home-dual-hero__subtitle">
          Organizá algo con tu gente o encontrá con quién compartir un plan.
        </p>
      </div>

      {variant === 'v3a' ? (
        <div className="home-v3a-stack">
          {/* Camino A destacado por encima del campo de intención */}
          <article
            className="home-v3a-invite-card"
            aria-labelledby="dual-path-invite-title"
          >
            <div className="home-v3a-invite-card__top">
              <span className="home-dual-card__badge home-dual-card__badge--invite">
                <CalendarPlus size={14} aria-hidden="true" />
                <span>Invitación privada</span>
              </span>
              <ul className="home-dual-examples home-dual-examples--inline" aria-label="Ejemplos de encuentros con tu gente">
                {INVITATION_EXAMPLES.map((item) => (
                  <li key={item.label} className="home-dual-example-pill">
                    <span aria-hidden="true">{item.icon}</span>
                    <span>{item.label}</span>
                  </li>
                ))}
              </ul>
            </div>

            <div className="home-v3a-invite-card__main">
              <div className="home-v3a-invite-card__copy">
                <h2 id="dual-path-invite-title" className="home-dual-card__title">
                  Organizá con tu gente
                </h2>
                <p className="home-dual-card__desc">
                  Creá un encuentro privado y compartí la invitación por WhatsApp o link con amigos, familia o tu grupo.
                </p>
              </div>

              <div className="home-v3a-invite-card__action">
                <Button
                  type="button"
                  variant="primary"
                  fullWidth
                  className="home-dual-cta home-dual-cta--invite home-v3a-cta"
                  onClick={onCreateInvitationClick}
                  data-testid="dual-path-create-invitation-btn"
                >
                  <span>Crear una invitación</span>
                  <ArrowRight size={17} aria-hidden="true" />
                </Button>
              </div>
            </div>

            <p className="home-dual-card__guarantee home-v3a-invite-card__guarantee">
              <CheckCircle2 size={14} className="home-dual-card__guarantee-icon" aria-hidden="true" />
              <span>Tus invitados pueden confirmar sin registrarse.</span>
            </p>
          </article>

          {/* Camino B: Tengo ganas de… (flujo de intención libre) */}
          <div className="home-v3a-intent-block" aria-label="Tengo ganas de…">
            <HomeIntentInput
              value={currentIntent}
              onChange={updateIntent}
              onSubmit={handleDirectIntentSubmit}
              isSubmitting={isSubmittingIntent}
              compact
              onFocusChange={onFocusChange}
              isListeningChange={isListeningChange}
            />
          </div>
        </div>
      ) : (
        <div className="home-dual-hero__grid">
          {/* Camino A: Organizar con mi gente */}
          <article
            className="home-dual-card home-dual-card--invite"
            aria-labelledby="dual-path-invite-title"
          >
            <div className="home-dual-card__badge-row">
              <span className="home-dual-card__badge home-dual-card__badge--invite">
                <CalendarPlus size={14} aria-hidden="true" />
                <span>Invitación privada</span>
              </span>
            </div>

            <h2 id="dual-path-invite-title" className="home-dual-card__title">
              Organizá con tu gente
            </h2>

            <p className="home-dual-card__desc">
              Cumpleaños, cenas, asados o reuniones. Creá una invitación y compartila por WhatsApp o link con tu grupo.
            </p>

            <ul className="home-dual-examples" aria-label="Ejemplos de encuentros con tu gente">
              {INVITATION_EXAMPLES.map((item) => (
                <li key={item.label} className="home-dual-example-pill">
                  <span aria-hidden="true">{item.icon}</span>
                  <span>{item.label}</span>
                </li>
              ))}
            </ul>

            <div className="home-dual-card__footer">
              <Button
                type="button"
                variant="primary"
                fullWidth
                className="home-dual-cta home-dual-cta--invite"
                onClick={onCreateInvitationClick}
                data-testid="dual-path-create-invitation-btn"
              >
                <span>Crear una invitación</span>
                <ArrowRight size={17} aria-hidden="true" />
              </Button>

              <p className="home-dual-card__guarantee">
                <CheckCircle2 size={14} className="home-dual-card__guarantee-icon" aria-hidden="true" />
                <span>Tus invitados pueden confirmar sin registrarse.</span>
              </p>
            </div>
          </article>

          {/* Camino B: Tengo ganas de… */}
          <article
            className="home-dual-card home-dual-card--intent"
            aria-labelledby="dual-path-intent-title"
          >
            <form className="home-dual-intent-form" onSubmit={handleIntentFormSubmit}>
              <div className="home-dual-card__badge-row">
                <span className="home-dual-card__badge home-dual-card__badge--intent">
                  <Sparkles size={14} aria-hidden="true" />
                  <span>Idea o plan abierto</span>
                </span>
              </div>

              <h2 id="dual-path-intent-title" className="home-dual-card__title">
                Tengo ganas de…
              </h2>

              <p className="home-dual-card__desc">
                Contanos qué te gustaría hacer para armarlo paso a paso o abrir lugares en tus zonas.
              </p>

              <div className="home-dual-intent-field">
                <label htmlFor="dual-path-intent-input" className="sr-only">
                  Tengo ganas de…
                </label>
                <textarea
                  id="dual-path-intent-input"
                  className="home-dual-intent-textarea"
                  rows={2}
                  value={currentIntent}
                  onChange={(e) => updateIntent(e.target.value)}
                  onKeyDown={handleTextareaKeyDown}
                  onFocus={() => onFocusChange?.(true)}
                  onBlur={() => onFocusChange?.(false)}
                  placeholder="ej. jugar al pádel este sábado a la tarde"
                  aria-label="Tengo ganas de..."
                  disabled={isSubmittingIntent}
                  data-testid="home-intent-textarea"
                />
                {currentIntent && (
                  <button
                    type="button"
                    className="home-dual-intent-clear"
                    onClick={() => updateIntent('')}
                    aria-label="Borrar texto"
                    title="Borrar texto"
                    disabled={isSubmittingIntent}
                  >
                    <X size={14} />
                  </button>
                )}
              </div>

              <div className="home-dual-card__footer">
                <Button
                  type="submit"
                  variant="outline"
                  fullWidth
                  className="home-dual-cta home-dual-cta--intent"
                  disabled={!trimmedIntent || isSubmittingIntent}
                  data-testid="dual-path-intent-submit-btn"
                >
                  <span>{isSubmittingIntent ? 'Preparando encuentro…' : 'Hagamos que pase'}</span>
                  <ArrowRight size={17} aria-hidden="true" />
                </Button>

                <p className="home-dual-card__helper">
                  Armalo con ayuda guiada o abrí lugares.
                </p>
              </div>
            </form>
          </article>
        </div>
      )}

      {suggestions.length > 0 && (
        <div className="home-dual-hero__suggestions">
          <HomeSuggestionChips suggestions={suggestions} onSelect={handleSelectChip} />
        </div>
      )}
    </section>
  );
};

export default HomeDualPathHeroPreview;
