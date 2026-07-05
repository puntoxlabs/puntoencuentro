export type EntertainmentTemplateId =
  | 'entertainment_cinema'
  | 'entertainment_music'
  | 'entertainment_show';

export interface EntertainmentTemplateConfig {
  id: EntertainmentTemplateId;
  name: string;
  category: 'entertainment';
  previewColor: string;
  thumbnail: string;
  background: string;
}

export const entertainmentTemplates: EntertainmentTemplateConfig[] = [
  {
    id: 'entertainment_cinema',
    name: 'Cine',
    category: 'entertainment',
    previewColor: 'linear-gradient(135deg, #eef2ff 0%, #c7d2fe 50%, #818cf8 100%)',
    thumbnail: '/invitation-templates/entertainment/entertainment_cinema_v2.webp?v=2',
    background: '/invitation-templates/entertainment/entertainment_cinema_v2.webp?v=2'
  },
  {
    id: 'entertainment_music',
    name: 'Música',
    category: 'entertainment',
    previewColor: 'linear-gradient(135deg, #f5f3ff 0%, #ddd6fe 50%, #a78bfa 100%)',
    thumbnail: '/invitation-templates/entertainment/entertainment_music_v2.webp?v=2',
    background: '/invitation-templates/entertainment/entertainment_music_v2.webp?v=2'
  },
  {
    id: 'entertainment_show',
    name: 'Show',
    category: 'entertainment',
    previewColor: 'linear-gradient(135deg, #fdf2f8 0%, #fbcfe8 50%, #f472b6 100%)',
    thumbnail: '/invitation-templates/entertainment/entertainment_show_v2.webp?v=2',
    background: '/invitation-templates/entertainment/entertainment_show_v2.webp?v=2'
  }
];

export function getEntertainmentTemplateConfig(templateId?: string | null): EntertainmentTemplateConfig | null {
  if (!templateId) return null;
  const found = entertainmentTemplates.find(t => t.id === templateId);
  return found || null;
}
