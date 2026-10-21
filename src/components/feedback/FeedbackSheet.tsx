import React, { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { X, AlertCircle, Lightbulb, MessageSquare, CheckCircle2 } from 'lucide-react';
import { useAuth } from '@/contexts/AuthContext';
import { feedbackService, type FeedbackCategory } from '@/services/feedbackService';
import '@/components/ui/BottomSheet.css';
import './FeedbackSheet.css';

export interface FeedbackSheetProps {
  isOpen: boolean;
  onClose: () => void;
  initialCategory?: FeedbackCategory;
  onOpenLogin?: () => void;
}

export const FeedbackSheet: React.FC<FeedbackSheetProps> = ({
  isOpen,
  onClose,
  initialCategory = 'suggestion',
  onOpenLogin,
}) => {
  const { t } = useTranslation();
  const { user } = useAuth();
  const isPermanent = Boolean(user && !user.is_anonymous);

  const [category, setCategory] = useState<FeedbackCategory>(initialCategory);
  const [comment, setComment] = useState('');
  const [honeypot, setHoneypot] = useState('');
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [isSuccess, setIsSuccess] = useState(false);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);

  if (!isOpen) return null;

  const handleClose = () => {
    setComment('');
    setHoneypot('');
    setIsSuccess(false);
    setErrorMessage(null);
    onClose();
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!comment.trim() || comment.trim().length < 3) return;

    setIsSubmitting(true);
    setErrorMessage(null);

    try {
      const result = await feedbackService.submitFeedback({
        category,
        comment,
        honeypot,
      });

      if (!result.ok) {
        if (result.error === 'rate_limit_exceeded') {
          setErrorMessage(t('feedback.rate_limited', 'Has enviado varios comentarios recientemente. Por favor esperá un momento antes de enviar otro.'));
        } else if (result.error === 'permanent_account_required' || result.error === 'authentication_required') {
          setErrorMessage(t('feedback.permanent_account_msg', 'Para proteger la comunidad contra el spam, se requiere una cuenta permanente de Google para enviar opiniones.'));
        } else {
          setErrorMessage(t('feedback.generic_error', 'No se pudo enviar tu opinión. Por favor intentá nuevamente.'));
        }
        return;
      }

      setIsSuccess(true);
      setComment('');
    } catch {
      setErrorMessage(t('feedback.generic_error', 'No se pudo enviar tu opinión. Por favor intentá nuevamente.'));
    } finally {
      setIsSubmitting(false);
    }
  };

  const getPlaceholder = () => {
    switch (category) {
      case 'issue':
        return t('feedback.placeholder_issue', '¿Qué problema experimentaste y qué estabas intentando hacer?');
      case 'suggestion':
        return t('feedback.placeholder_suggestion', '¿Qué mejora o funcionalidad te gustaría ver en PuntoEncuentro?');
      case 'general':
      default:
        return t('feedback.placeholder_general', 'Contanos qué te parece la app o compartí cualquier comentario...');
    }
  };

  return (
    <>
      <div onClick={handleClose} className="pe-sheet-overlay" />
      <div
        className="pe-sheet-container pe-feedback-sheet"
        role="dialog"
        aria-modal="true"
        aria-labelledby="feedback-sheet-title"
      >
        <div className="pe-sheet-handle" />

        <div className="pe-feedback-header">
          <h2 id="feedback-sheet-title" className="pe-feedback-title">
            {t('feedback.title', 'Ayudanos a mejorar')}
          </h2>
          <button
            type="button"
            onClick={handleClose}
            className="pe-feedback-close-btn"
            aria-label={t('common.close', 'Cerrar')}
          >
            <X size={20} />
          </button>
        </div>

        {isSuccess ? (
          <div className="pe-feedback-success">
            <div className="pe-feedback-success-icon">
              <CheckCircle2 size={48} color="#16a34a" />
            </div>
            <h3 className="pe-feedback-success-title">
              {t('feedback.success_title', '¡Muchas gracias por tu opinión!')}
            </h3>
            <p className="pe-feedback-success-desc">
              {t('feedback.success_desc', 'Tus comentarios nos ayudan a que PuntoEncuentro sea más simple y confiable para todos.')}
            </p>
            <button
              type="button"
              className="pe-feedback-submit-btn"
              onClick={handleClose}
            >
              {t('feedback.close_btn', 'Listo')}
            </button>
          </div>
        ) : !isPermanent ? (
          /* Ajuste 3: Exclusión de anónimos y restricción estricta a cuentas permanentes */
          <div className="pe-feedback-auth-required">
            <div className="pe-feedback-alert pe-feedback-alert--info">
              {t('feedback.auth_note', 'Para proteger la comunidad contra envíos masivos o spam no deseado, requerimos que inicies sesión con una cuenta permanente de Google antes de enviar tu opinión.')}
            </div>
            {onOpenLogin ? (
              <button
                type="button"
                className="pe-feedback-submit-btn"
                onClick={() => {
                  handleClose();
                  onOpenLogin();
                }}
              >
                {t('feedback.login_cta', 'Iniciar sesión para enviar opinión')}
              </button>
            ) : (
              <p style={{ fontSize: '0.9rem', color: 'var(--color-outline)' }}>
                {t('feedback.login_prompt', 'Por favor iniciá sesión desde el menú principal para poder opinar.')}
              </p>
            )}
          </div>
        ) : (
          <form onSubmit={handleSubmit}>
            {/* Categorías */}
            <div className="pe-feedback-category-group" role="radiogroup" aria-label={t('feedback.category_label', 'Tipo de opinión')}>
              <button
                type="button"
                role="radio"
                aria-checked={category === 'issue'}
                className={`pe-feedback-cat-btn ${category === 'issue' ? 'pe-feedback-cat-btn--active' : ''}`}
                onClick={() => setCategory('issue')}
              >
                <AlertCircle size={20} />
                <span>{t('feedback.cat_issue', 'Problema')}</span>
              </button>

              <button
                type="button"
                role="radio"
                aria-checked={category === 'suggestion'}
                className={`pe-feedback-cat-btn ${category === 'suggestion' ? 'pe-feedback-cat-btn--active' : ''}`}
                onClick={() => setCategory('suggestion')}
              >
                <Lightbulb size={20} />
                <span>{t('feedback.cat_suggestion', 'Mejora')}</span>
              </button>

              <button
                type="button"
                role="radio"
                aria-checked={category === 'general'}
                className={`pe-feedback-cat-btn ${category === 'general' ? 'pe-feedback-cat-btn--active' : ''}`}
                onClick={() => setCategory('general')}
              >
                <MessageSquare size={20} />
                <span>{t('feedback.cat_general', 'Opinión')}</span>
              </button>
            </div>

            {/* Honeypot field (anti-spam bot trap) */}
            <input
              type="text"
              name="website_feedback_hp"
              value={honeypot}
              onChange={(e) => setHoneypot(e.target.value)}
              tabIndex={-1}
              autoComplete="off"
              style={{ display: 'none' }}
              aria-hidden="true"
            />

            {/* Textarea */}
            <div className="pe-feedback-textarea-wrap">
              <textarea
                className="pe-feedback-textarea"
                rows={4}
                maxLength={1000}
                placeholder={getPlaceholder()}
                value={comment}
                onChange={(e) => setComment(e.target.value)}
                disabled={isSubmitting}
                aria-label={t('feedback.textarea_label', 'Escribí tu comentario')}
              />
              <div
                className={`pe-feedback-counter ${comment.length > 900 ? 'pe-feedback-counter--warn' : ''}`}
              >
                {comment.length} / 1000
              </div>
            </div>

            {errorMessage && (
              <div className="pe-feedback-alert pe-feedback-alert--error" role="alert">
                {errorMessage}
              </div>
            )}

            <button
              type="submit"
              className="pe-feedback-submit-btn"
              disabled={isSubmitting || comment.trim().length < 3 || comment.trim().length > 1000}
            >
              {isSubmitting
                ? t('feedback.submitting', 'Enviando...')
                : t('feedback.submit_btn', 'Enviar opinión')}
            </button>
          </form>
        )}
      </div>
    </>
  );
};
