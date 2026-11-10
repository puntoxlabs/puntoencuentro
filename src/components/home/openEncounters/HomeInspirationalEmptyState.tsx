import React from 'react';
import { Sparkles, Bell, MapPin, ArrowUpRight } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import './HomeInspirationalEmptyState.css';

export interface InspirationalIdea {
  id: string;
  title: string;
  description: string;
  prompt: string;
  emoji: string;
  badge: string;
}

export const INSPIRATIONAL_IDEAS: InspirationalIdea[] = [
  {
    id: 'caminar',
    title: 'Salir a caminar',
    description: 'Una caminata, una charla y aire libre.',
    prompt: 'Quiero salir a caminar y charlar al aire libre',
    emoji: '🥾',
    badge: 'Idea para organizar',
  },
  {
    id: 'mates',
    title: 'Compartir unos mates',
    description: 'Un rato para charlar y conectar.',
    prompt: 'Quiero compartir unos mates para charlar y conectar',
    emoji: '🧉',
    badge: 'Idea para organizar',
  },
  {
    id: 'cafe',
    title: 'Café y charla',
    description: 'Conocer gente en un ambiente tranquilo.',
    prompt: 'Quiero tomar un café para conocer gente en un ambiente tranquilo',
    emoji: '☕',
    badge: 'Idea para organizar',
  },
  {
    id: 'juegos',
    title: 'Juegos de mesa',
    description: 'Compartir una actividad divertida.',
    prompt: 'Quiero juntarnos a jugar juegos de mesa y divertirnos',
    emoji: '🎲',
    badge: 'Idea para organizar',
  },
];

export interface HomeInspirationalEmptyStateProps {
  noZonesConfigured?: boolean;
  onSelectIdea: (idea: InspirationalIdea) => void;
  onOpenCreate?: () => void;
  onOpenAvisame?: () => void;
  onConfigureZones?: () => void;
}

export const HomeInspirationalEmptyState: React.FC<HomeInspirationalEmptyStateProps> = ({
  noZonesConfigured = false,
  onSelectIdea,
  onOpenCreate,
  onOpenAvisame,
  onConfigureZones,
}) => {
  const { t } = useTranslation();

  return (
    <div
      className="pe-inspirational-container"
      data-testid="inspirational-empty-state"
      role="region"
      aria-label="Ideas inspiradoras para organizar encuentros"
    >
      {/* Encabezado y Contexto Humano */}
      <div className="pe-inspirational-header">
        <h3 className="pe-inspirational-title">
          {t('open_encounters.inspirational_title', {
            defaultValue: 'Los próximos encuentros empiezan con una idea',
          })}
        </h3>
        <p className="pe-inspirational-desc">
          {noZonesConfigured
            ? t('open_encounters.inspirational_no_zones_desc', {
                defaultValue: 'Elegí tus zonas para ver encuentros cerca tuyo o inspirate con estas ideas para organizar tu propio encuentro.',
              })
            : t('open_encounters.inspirational_desc', {
                defaultValue: 'Todavía no hay encuentros abiertos en tu zona. Pero hay muchas cosas que podemos hacer juntos.',
              })}
        </p>

        {/* CTA contextual de configuración cuando no hay zonas configuradas */}
        {noZonesConfigured && (
          <div className="pe-inspirational-zone-prompt" data-testid="inspirational-zone-prompt">
            <div className="pe-inspirational-zone-prompt-text">
              <MapPin size={16} className="pe-inspirational-zone-prompt-icon" aria-hidden="true" />
              <span>
                {t('open_encounters.no_zones_title', {
                  defaultValue: 'Elegí tus zonas para ver encuentros cerca tuyo.',
                })}
              </span>
            </div>
            <button
              type="button"
              className="pe-discovery-empty-btn pe-discovery-empty-btn--outline pe-inspirational-zone-btn"
              onClick={onConfigureZones}
              data-testid="inspirational-btn-configure-zones"
            >
              {t('open_encounters.no_zones_cta', { defaultValue: 'Configurar zonas' })}
            </button>
          </div>
        )}

        <div className="pe-inspirational-notice" role="note">
          <Sparkles size={13} className="pe-inspirational-notice-icon" aria-hidden="true" />
          <span>
            {t('open_encounters.inspirational_disclaimer', {
              defaultValue: 'Ideas para organizar • No son encuentros publicados',
            })}
          </span>
        </div>
      </div>

      {/* Cuadrícula de 4 Tarjetas Inspiradoras */}
      <div className="pe-inspirational-grid" role="list">
        {INSPIRATIONAL_IDEAS.map((idea) => {
          const cardAria = `${idea.badge}: ${idea.title}. ${idea.description}. Elegir esta idea para Tengo ganas de…`;
          return (
            <button
              key={idea.id}
              type="button"
              className="pe-inspirational-card"
              onClick={() => onSelectIdea(idea)}
              aria-label={cardAria}
              role="listitem"
              data-testid={`inspirational-card-${idea.id}`}
            >
              <div className="pe-inspirational-card-top">
                <span className="pe-inspirational-card-emoji" aria-hidden="true">
                  {idea.emoji}
                </span>
                <span className="pe-inspirational-card-badge">{idea.badge}</span>
              </div>

              <h4 className="pe-inspirational-card-title">{idea.title}</h4>
              <p className="pe-inspirational-card-desc">{idea.description}</p>

              <div className="pe-inspirational-card-footer" aria-hidden="true">
                <span className="pe-inspirational-card-action">
                  <span>
                    {t('open_encounters.inspirational_use_idea', { defaultValue: 'Usar esta idea' })}
                  </span>
                  <ArrowUpRight size={13} />
                </span>
              </div>
            </button>
          );
        })}
      </div>

      {/* Acciones Complementarias (Crear, Avisame, Cambiar Zonas) */}
      <div className="pe-inspirational-actions">
        <button
          type="button"
          className="pe-discovery-empty-btn pe-discovery-empty-btn--primary"
          onClick={onOpenCreate}
          data-testid="inspirational-cta-create"
        >
          <Sparkles size={14} style={{ display: 'inline', marginRight: 6, verticalAlign: 'text-bottom' }} />
          {t('open_encounters.empty_cta', { defaultValue: 'Abrir un encuentro' })}
        </button>

        <button
          type="button"
          className="pe-discovery-empty-btn pe-discovery-empty-btn--secondary pe-discovery-avisame-empty-btn"
          onClick={onOpenAvisame}
          data-testid="inspirational-cta-avisame"
        >
          <Bell size={14} style={{ display: 'inline', marginRight: 6, verticalAlign: 'text-bottom' }} />
          {t('avisame.empty_cta', { defaultValue: 'Avisame si aparece uno' })}
        </button>

        {!noZonesConfigured && (
          <button
            type="button"
            className="pe-discovery-empty-btn pe-discovery-empty-btn--outline"
            onClick={onConfigureZones}
            data-testid="inspirational-cta-zones"
          >
            <MapPin size={14} style={{ display: 'inline', marginRight: 6, verticalAlign: 'text-bottom' }} />
            {t('open_encounters.inspirational_change_zones', { defaultValue: 'Cambiar o sumar zonas' })}
          </button>
        )}
      </div>
    </div>
  );
};
