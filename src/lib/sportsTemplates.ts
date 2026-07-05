export type SportsTemplateId =
  | 'sports_field'
  | 'sports_team'
  | 'sports_competition';

export interface SportsTemplateConfig {
  id: SportsTemplateId;
  name: string;
  category: 'sports';
  previewColor: string;
  thumbnail: string;
  background: string;
}

export const sportsTemplates: SportsTemplateConfig[] = [
  {
    id: 'sports_field',
    name: 'Cancha',
    category: 'sports',
    previewColor: 'linear-gradient(135deg, #166534 0%, #22c55e 50%, #86efac 100%)',
    thumbnail: '/invitation-templates/sports/sports_field.webp',
    background: '/invitation-templates/sports/sports_field.webp'
  },
  {
    id: 'sports_team',
    name: 'Equipo',
    category: 'sports',
    previewColor: 'linear-gradient(135deg, #1e3a8a 0%, #3b82f6 50%, #93c5fd 100%)',
    thumbnail: '/invitation-templates/sports/sports_team.webp',
    background: '/invitation-templates/sports/sports_team.webp'
  },
  {
    id: 'sports_competition',
    name: 'Competencia',
    category: 'sports',
    previewColor: 'linear-gradient(135deg, #7f1d1d 0%, #ef4444 50%, #fca5a5 100%)',
    thumbnail: '/invitation-templates/sports/sports_competition.webp',
    background: '/invitation-templates/sports/sports_competition.webp'
  }
];

export function getSportsTemplateConfig(templateId?: string | null): SportsTemplateConfig | null {
  if (!templateId) return null;
  const found = sportsTemplates.find(t => t.id === templateId);
  return found || null;
}
