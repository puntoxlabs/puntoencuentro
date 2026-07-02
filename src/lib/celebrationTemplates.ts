export type CelebrationTemplateId =
  | 'celebration_gold'
  | 'celebration_festiva'
  | 'celebration_blue_party';

export interface CelebrationTemplateConfig {
  id: CelebrationTemplateId;
  name: string;
  category: 'celebration';
  previewColor: string;
  thumbnail: string;
  background: string;
}

export const celebrationTemplates: CelebrationTemplateConfig[] = [
  {
    id: 'celebration_gold',
    name: 'Dorado festivo',
    category: 'celebration',
    previewColor: 'linear-gradient(160deg, #fef9c3 0%, #fde68a 30%, #f59e0b 65%, #92400e 100%)',
    thumbnail: '/invitation-templates/celebration/celebration_gold.jpg',
    background: '/invitation-templates/celebration/celebration_gold.jpg'
  },
  {
    id: 'celebration_festiva',
    name: 'Fiesta colorida',
    category: 'celebration',
    previewColor: 'linear-gradient(135deg, #f472b6 0%, #a855f7 50%, #3b82f6 100%)',
    thumbnail: '/invitation-templates/celebration/celebration_festiva.jpg',
    background: '/invitation-templates/celebration/celebration_festiva.jpg'
  },
  {
    id: 'celebration_blue_party',
    name: 'Azul celebración',
    category: 'celebration',
    previewColor: 'linear-gradient(135deg, #1e3a8a 0%, #0f172a 100%)',
    thumbnail: '/invitation-templates/celebration/celebration_blue_party.jpg',
    background: '/invitation-templates/celebration/celebration_blue_party.jpg'
  }
];

export function getCelebrationTemplateConfig(templateId?: string | null): CelebrationTemplateConfig {
  if (!templateId) return celebrationTemplates[0];
  const found = celebrationTemplates.find(t => t.id === templateId);
  return found || celebrationTemplates[0];
}
