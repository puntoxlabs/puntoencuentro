export type CelebrationTemplateId =
  | 'celebration_gold'
  | 'celebration_festiva'
  | 'celebration_blue_party';

export interface CelebrationTemplateConfig {
  id: CelebrationTemplateId;
  name: string;
  category: 'celebration';
  // En lugar de imagen real, para el selector usamos un color o preview base
  previewColor: string; 
}

export const celebrationTemplates: CelebrationTemplateConfig[] = [
  {
    id: 'celebration_gold',
    name: 'Dorado festivo',
    category: 'celebration',
    previewColor: 'linear-gradient(135deg, #fef08a 0%, #eab308 100%)'
  },
  {
    id: 'celebration_festiva',
    name: 'Fiesta colorida',
    category: 'celebration',
    previewColor: 'linear-gradient(135deg, #f472b6 0%, #a855f7 50%, #3b82f6 100%)'
  },
  {
    id: 'celebration_blue_party',
    name: 'Azul celebración',
    category: 'celebration',
    previewColor: 'linear-gradient(135deg, #1e3a8a 0%, #0f172a 100%)'
  }
];

export function getCelebrationTemplateConfig(templateId?: string | null): CelebrationTemplateConfig {
  if (!templateId) return celebrationTemplates[0];
  const found = celebrationTemplates.find(t => t.id === templateId);
  return found || celebrationTemplates[0];
}
