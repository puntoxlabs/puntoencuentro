export type RomanticTemplateId =
  | 'romantic_rose'
  | 'romantic_rainbow'
  | 'romantic_gold';

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
    id: 'romantic_rose',
    name: 'Rosas suaves',
    category: 'romantic',
    previewColor: 'linear-gradient(135deg, #fbcfe8 0%, #f472b6 100%)',
    thumbnail: '/invitation-templates/romantic/romantic_rose_v3.webp?v=3',
    background: '/invitation-templates/romantic/romantic_rose_v3.webp?v=3'
  },
  {
    id: 'romantic_rainbow',
    name: 'Luz cálida',
    category: 'romantic',
    previewColor: 'linear-gradient(135deg, #f87171 0%, #facc15 33%, #4ade80 66%, #3b82f6 100%)',
    thumbnail: '/invitation-templates/romantic/romantic_rainbow_v3.webp?v=3',
    background: '/invitation-templates/romantic/romantic_rainbow_v3.webp?v=3'
  },
  {
    id: 'romantic_gold',
    name: 'Dorado romántico',
    category: 'romantic',
    previewColor: 'linear-gradient(135deg, #fef08a 0%, #eab308 100%)',
    thumbnail: '/invitation-templates/romantic/romantic_gold_v3.webp?v=3',
    background: '/invitation-templates/romantic/romantic_gold_v3.webp?v=3'
  }
];

export function getRomanticTemplateConfig(templateId?: string | null): RomanticTemplateConfig | null {
  if (!templateId) return null;
  const found = romanticTemplates.find(t => t.id === templateId);
  return found || null;
}
