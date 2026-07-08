export type FormalTemplateId =
  | 'formal_black_tie'
  | 'formal_ivory'
  | 'formal_executive';

export interface FormalTemplateConfig {
  id: FormalTemplateId;
  name: string;
  category: 'formal';
  previewColor: string;
  thumbnail: string;
  background: string;
}

export const formalTemplates: FormalTemplateConfig[] = [
  {
    id: 'formal_black_tie',
    name: 'Gala',
    category: 'formal',
    previewColor: 'linear-gradient(135deg, #0f172a 0%, #1e293b 50%, #334155 100%)',
    thumbnail: '/invitation-templates/formal/formal_black_tie_thumb_v3.webp?v=3',
    background: '/invitation-templates/formal/formal_black_tie_bg_v3.webp?v=3'
  },
  {
    id: 'formal_ivory',
    name: 'Marfil',
    category: 'formal',
    previewColor: 'linear-gradient(135deg, #fef3c7 0%, #fde68a 50%, #fcd34d 100%)',
    thumbnail: '/invitation-templates/formal/formal_ivory_thumb_v3.webp?v=3',
    background: '/invitation-templates/formal/formal_ivory_bg_v3.webp?v=3'
  },
  {
    id: 'formal_executive',
    name: 'Ejecutivo',
    category: 'formal',
    previewColor: 'linear-gradient(135deg, #1e3a8a 0%, #1e40af 50%, #1d4ed8 100%)',
    thumbnail: '/invitation-templates/formal/formal_executive_thumb_v3.webp?v=3',
    background: '/invitation-templates/formal/formal_executive_bg_v3.webp?v=3'
  }
];

export function getFormalTemplateConfig(templateId?: string | null): FormalTemplateConfig | null {
  if (!templateId) return null;
  const found = formalTemplates.find(t => t.id === templateId);
  return found || null;
}
