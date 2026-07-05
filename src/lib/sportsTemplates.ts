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
    previewColor: 'linear-gradient(135deg, #f0fdf4 0%, #bbf7d0 50%, #4ade80 100%)',
    thumbnail: '/invitation-templates/sports/sports_field_v3.webp?v=3',
    background: '/invitation-templates/sports/sports_field_v3.webp?v=3'
  },
  {
    id: 'sports_team',
    name: 'Equipo',
    category: 'sports',
    previewColor: 'linear-gradient(135deg, #eff6ff 0%, #bfdbfe 50%, #60a5fa 100%)',
    thumbnail: '/invitation-templates/sports/sports_team_v3.webp?v=3',
    background: '/invitation-templates/sports/sports_team_v3.webp?v=3'
  },
  {
    id: 'sports_competition',
    name: 'Raqueta',
    category: 'sports',
    previewColor: 'linear-gradient(135deg, #fef2f2 0%, #fecaca 50%, #f87171 100%)',
    thumbnail: '/invitation-templates/sports/sports_competition_v3.webp?v=3',
    background: '/invitation-templates/sports/sports_competition_v3.webp?v=3'
  }
];

export function getSportsTemplateConfig(templateId?: string | null): SportsTemplateConfig | null {
  if (!templateId) return null;
  const found = sportsTemplates.find(t => t.id === templateId);
  return found || null;
}
