export type RomanticTemplateId =
  | 'romantic_classic'
  | 'romantic_young'
  | 'romantic_pride';

export interface RomanticTemplateConfig {
  id: RomanticTemplateId;
  name: string;
  category: 'romantic';
  previewColor: string;
  thumbnail: string;
  background: string;
}

export const romanticTemplates: RomanticTemplateConfig[] = [
  {
    id: 'romantic_classic',
    name: 'Rosas elegantes',
    category: 'romantic',
    previewColor: 'linear-gradient(135deg, #fbcfe8 0%, #f472b6 100%)',
    thumbnail: '/invitation-templates/romantic/romantic_classic_v3.webp?v=3',
    background: '/invitation-templates/romantic/romantic_classic_v3.webp?v=3'
  },
  {
    id: 'romantic_young',
    name: 'Romance juvenil',
    category: 'romantic',
    previewColor: 'linear-gradient(135deg, #e879f9 0%, #c084fc 100%)',
    thumbnail: '/invitation-templates/romantic/romantic_young_v3.webp?v=3',
    background: '/invitation-templates/romantic/romantic_young_v3.webp?v=3'
  },
  {
    id: 'romantic_pride',
    name: 'Amor diverso',
    category: 'romantic',
    previewColor: 'linear-gradient(135deg, #f87171 0%, #facc15 33%, #4ade80 66%, #3b82f6 100%)',
    thumbnail: '/invitation-templates/romantic/romantic_pride_v3.webp?v=3',
    background: '/invitation-templates/romantic/romantic_pride_v3.webp?v=3'
  }
];

export function getRomanticTemplateConfig(templateId?: string | null): RomanticTemplateConfig | null {
  if (!templateId) return null;
  const found = romanticTemplates.find(t => t.id === templateId);
  return found || null;
}
