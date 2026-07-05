export type FamilyTemplateId =
  | 'family_home'
  | 'family_sunday'
  | 'family_memories';

export interface FamilyTemplateConfig {
  id: FamilyTemplateId;
  name: string;
  category: 'family';
  previewColor: string;
  thumbnail: string;
  background: string;
}

export const familyTemplates: FamilyTemplateConfig[] = [
  {
    id: 'family_home',
    name: 'Hogar',
    category: 'family',
    previewColor: 'linear-gradient(135deg, #e2d1c3 0%, #fdfbf7 50%, #c4a484 100%)',
    thumbnail: '/invitation-templates/family/family_home.webp?v=2',
    background: '/invitation-templates/family/family_home.webp?v=2'
  },
  {
    id: 'family_sunday',
    name: 'Domingo',
    category: 'family',
    previewColor: 'linear-gradient(135deg, #f0e6d2 0%, #fffdfa 50%, #d8cdb8 100%)',
    thumbnail: '/invitation-templates/family/family_sunday.webp?v=2',
    background: '/invitation-templates/family/family_sunday.webp?v=2'
  },
  {
    id: 'family_memories',
    name: 'Recuerdos',
    category: 'family',
    previewColor: 'linear-gradient(135deg, #d2b48c 0%, #f5deb3 50%, #deb887 100%)',
    thumbnail: '/invitation-templates/family/family_memories.webp?v=2',
    background: '/invitation-templates/family/family_memories.webp?v=2'
  }
];

export function getFamilyTemplateConfig(templateId?: string | null): FamilyTemplateConfig | null {
  if (!templateId) return null;
  const found = familyTemplates.find(t => t.id === templateId);
  return found || null;
}
