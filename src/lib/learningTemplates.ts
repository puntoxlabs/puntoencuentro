export type LearningTemplateId =
  | 'learning_class'
  | 'learning_course'
  | 'learning_talk';

export interface LearningTemplateConfig {
  id: LearningTemplateId;
  name: string;
  category: 'learning';
  previewColor: string;
  thumbnail: string;
  background: string;
}

export const learningTemplates: LearningTemplateConfig[] = [
  {
    id: 'learning_class',
    name: 'Clase',
    category: 'learning',
    previewColor: 'linear-gradient(135deg, #e0f2fe 0%, #bae6fd 50%, #38bdf8 100%)',
    thumbnail: '/invitation-templates/learning/learning_class_v4.webp?v=4',
    background: '/invitation-templates/learning/learning_class_v4.webp?v=4'
  },
  {
    id: 'learning_course',
    name: 'Curso',
    category: 'learning',
    previewColor: 'linear-gradient(135deg, #fef3c7 0%, #fde68a 50%, #fbbf24 100%)',
    thumbnail: '/invitation-templates/learning/learning_course_v4.webp?v=4',
    background: '/invitation-templates/learning/learning_course_v4.webp?v=4'
  },
  {
    id: 'learning_talk',
    name: 'Charla',
    category: 'learning',
    previewColor: 'linear-gradient(135deg, #f3e8ff 0%, #e9d5ff 50%, #c084fc 100%)',
    thumbnail: '/invitation-templates/learning/learning_talk_v4.webp?v=4',
    background: '/invitation-templates/learning/learning_talk_v4.webp?v=4'
  }
];

export function getLearningTemplateConfig(templateId?: string | null): LearningTemplateConfig | null {
  if (!templateId) return null;
  const found = learningTemplates.find(t => t.id === templateId);
  return found || null;
}
