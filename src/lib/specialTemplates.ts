export type SpecialTemplateId =
  | 'special_moment'
  | 'special_surprise'
  | 'special_tribute';

export interface SpecialTemplateConfig {
  id: SpecialTemplateId;
  name: string;
  category: 'special';
  previewColor: string;
  thumbnail: string;
  background: string;
}

export const specialTemplates: SpecialTemplateConfig[] = [
  {
    id: 'special_moment',
    name: 'Momento',
    category: 'special',
    previewColor: 'linear-gradient(135deg, #fdfbf7 0%, #e2d1c3 50%, #c4a484 100%)',
    thumbnail: '/invitation-templates/special/special_moment.webp?v=1',
    background: '/invitation-templates/special/special_moment.webp?v=1'
  },
  {
    id: 'special_surprise',
    name: 'Sorpresa',
    category: 'special',
    previewColor: 'linear-gradient(135deg, #fff2f0 0%, #ffcba4 50%, #d8cdb8 100%)',
    thumbnail: '/invitation-templates/special/special_surprise.webp?v=1',
    background: '/invitation-templates/special/special_surprise.webp?v=1'
  },
  {
    id: 'special_tribute',
    name: 'Homenaje',
    category: 'special',
    previewColor: 'linear-gradient(135deg, #d2b48c 0%, #f5deb3 50%, #deb887 100%)',
    thumbnail: '/invitation-templates/special/special_tribute.webp?v=1',
    background: '/invitation-templates/special/special_tribute.webp?v=1'
  }
];

export function getSpecialTemplateConfig(templateId?: string | null): SpecialTemplateConfig | null {
  if (!templateId) return null;
  const found = specialTemplates.find(t => t.id === templateId);
  return found || null;
}
