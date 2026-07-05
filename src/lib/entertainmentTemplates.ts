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
    previewColor: 'linear-gradient(135deg, #312e81 0%, #4f46e5 50%, #a5b4fc 100%)',
    thumbnail: '/invitation-templates/entertainment/entertainment_cinema.webp',
    background: '/invitation-templates/entertainment/entertainment_cinema.webp'
  },
  {
    id: 'entertainment_music',
    name: 'Música',
    category: 'entertainment',
    previewColor: 'linear-gradient(135deg, #4c1d95 0%, #8b5cf6 50%, #d8b4fe 100%)',
    thumbnail: '/invitation-templates/entertainment/entertainment_music.webp',
    background: '/invitation-templates/entertainment/entertainment_music.webp'
  },
  {
    id: 'entertainment_show',
    name: 'Show',
    category: 'entertainment',
    previewColor: 'linear-gradient(135deg, #831843 0%, #db2777 50%, #f9a8d4 100%)',
    thumbnail: '/invitation-templates/entertainment/entertainment_show.webp',
    background: '/invitation-templates/entertainment/entertainment_show.webp'
  }
];

export function getEntertainmentTemplateConfig(templateId?: string | null): EntertainmentTemplateConfig | null {
  if (!templateId) return null;
  const found = entertainmentTemplates.find(t => t.id === templateId);
  return found || null;
}
