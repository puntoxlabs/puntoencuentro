export type WellnessTemplateId =
  | 'wellness_calm'
  | 'wellness_nature'
  | 'wellness_movement';

export interface WellnessTemplateConfig {
  id: WellnessTemplateId;
  name: string;
  category: 'wellness';
  previewColor: string;
  thumbnail: string;
  background: string;
}

export const wellnessTemplates: WellnessTemplateConfig[] = [
  {
    id: 'wellness_calm',
    name: 'Calma',
    category: 'wellness',
    previewColor: 'linear-gradient(135deg, #f5f5f4 0%, #e7e5e4 50%, #d6d3d1 100%)',
    thumbnail: '/invitation-templates/wellness/wellness_calm_v4.webp?v=4',
    background: '/invitation-templates/wellness/wellness_calm_v4.webp?v=4'
  },
  {
    id: 'wellness_nature',
    name: 'Aire libre',
    category: 'wellness',
    previewColor: 'linear-gradient(135deg, #f0fdf4 0%, #dcfce7 50%, #bbf7d0 100%)',
    thumbnail: '/invitation-templates/wellness/wellness_nature_v4.webp?v=4',
    background: '/invitation-templates/wellness/wellness_nature_v4.webp?v=4'
  },
  {
    id: 'wellness_movement',
    name: 'Movimiento',
    category: 'wellness',
    previewColor: 'linear-gradient(135deg, #fff1f2 0%, #ffe4e6 50%, #fecdd3 100%)',
    thumbnail: '/invitation-templates/wellness/wellness_movement_v4.webp?v=4',
    background: '/invitation-templates/wellness/wellness_movement_v5_background.webp?v=5'
  }
];

export function getWellnessTemplateConfig(templateId?: string | null): WellnessTemplateConfig | null {
  if (!templateId) return null;
  const found = wellnessTemplates.find(t => t.id === templateId);
  return found || null;
}
