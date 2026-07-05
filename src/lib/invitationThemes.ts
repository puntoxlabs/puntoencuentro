import { 
  Building2, 
  Coffee, 
  PartyPopper, 
  Gamepad2, 
  Home, 
  Star,
  CheckCircle2,
  Heart,
  Trophy,
  Ticket,
  BookOpen,
  Leaf
} from 'lucide-react';


import { getCelebrationTemplateConfig } from './celebrationTemplates';
import { getSportsTemplateConfig } from './sportsTemplates';
import { getEntertainmentTemplateConfig } from './entertainmentTemplates';
import { getLearningTemplateConfig } from './learningTemplates';
import { getWellnessTemplateConfig } from './wellnessTemplates';

export type InvitationTheme =
  | 'classic'
  | 'formal'
  | 'friends'
  | 'celebration'
  | 'kids_birthday'
  | 'family'
  | 'special'
  | 'romantic'
  | 'sports'
  | 'entertainment'
  | 'learning'
  | 'wellness';

export interface InvitationThemeConfig {
  id: InvitationTheme;
  label: string;
  description: string;
  icon: any; // Using any for LucideIcon to avoid strict type issues
  cssClass: string;
  eyebrow: string;
}

export const INVITATION_THEMES: InvitationThemeConfig[] = [
  {
    id: 'classic',
    label: 'Clásico',
    description: 'Profesional, neutro y claro.',
    icon: CheckCircle2,
    cssClass: 'guest-theme--classic',
    eyebrow: 'Te invitan a un encuentro'
  },
  {
    id: 'friends',
    label: 'Amigos',
    description: 'Juntadas y cenas informales.',
    icon: Coffee,
    cssClass: 'guest-theme--friends',
    eyebrow: 'Te invitan a juntarse'
  },
  {
    id: 'wellness',
    label: 'Bienestar',
    description: 'Actividades de calma, salud y conexión.',
    icon: Leaf,
    cssClass: 'guest-theme--wellness',
    eyebrow: 'Una invitación para conectar'
  },
  {
    id: 'celebration',
    label: 'Celebración',
    description: 'Cumpleaños y festejos.',
    icon: PartyPopper,
    cssClass: 'guest-theme--celebration',
    eyebrow: 'Te invitan a celebrar'
  },
  {
    id: 'kids_birthday',
    label: 'Cumple Infantil',
    description: 'Fiestas y reuniones infantiles.',
    icon: Gamepad2,
    cssClass: 'guest-theme--kids-birthday',
    eyebrow: 'Te invitan a un cumple'
  },
  {
    id: 'sports',
    label: 'Deportes',
    description: 'Partidos, torneos y entrenamientos.',
    icon: Trophy,
    cssClass: 'guest-theme--sports',
    eyebrow: 'Una invitación deportiva'
  },
  {
    id: 'entertainment',
    label: 'Entretenimiento',
    description: 'Cine, teatro, recitales y shows.',
    icon: Ticket,
    cssClass: 'guest-theme--entertainment',
    eyebrow: 'Una invitación para disfrutar'
  },
  {
    id: 'special',
    label: 'Especial',
    description: 'Cenas especiales o aniversarios.',
    icon: Star,
    cssClass: 'guest-theme--special',
    eyebrow: 'Tenés una invitación especial'
  },
  {
    id: 'family',
    label: 'Familia',
    description: 'Almuerzos y reuniones familiares.',
    icon: Home,
    cssClass: 'guest-theme--family',
    eyebrow: 'Encuentro familiar'
  },
  {
    id: 'formal',
    label: 'Formal',
    description: 'Trabajo, institucional o académico.',
    icon: Building2,
    cssClass: 'guest-theme--formal',
    eyebrow: 'Te invitan a una reunión'
  },
  {
    id: 'learning',
    label: 'Formación',
    description: 'Cursos, talleres y aprendizaje.',
    icon: BookOpen,
    cssClass: 'guest-theme--learning',
    eyebrow: 'Una invitación para aprender'
  },
  {
    id: 'romantic',
    label: 'Romántico',
    description: 'Cenas románticas y aniversarios.',
    icon: Heart,
    cssClass: 'guest-theme--romantic',
    eyebrow: 'Te invitan a un encuentro especial'
  }
];

export function getThemeEyebrow(themeId: string | undefined | null): string {
  const theme = normalizeInvitationTheme(themeId);
  const config = INVITATION_THEMES.find(t => t.id === theme);
  return config?.eyebrow || 'Te invitan a';
}

export function normalizeInvitationTheme(value: unknown): InvitationTheme {
  if (typeof value !== 'string') return 'classic';
  
  const validThemes: InvitationTheme[] = [
    'classic',
    'formal',
    'friends',
    'celebration',
    'kids_birthday',
    'family',
    'special',
    'romantic',
    'sports',
    'entertainment',
    'learning',
    'wellness'
  ];
  
  if (validThemes.includes(value as InvitationTheme)) {
    return value as InvitationTheme;
  }
  
  return 'classic';
}

export function getDefaultInvitationTemplate(theme?: string | null): string | null {
  switch (theme) {
    case 'kids_birthday': return 'kids_jungle';
    case 'celebration': return 'celebration_gold';
    case 'sports': return 'sports_field';
    case 'entertainment': return 'entertainment_cinema';
    case 'learning': return 'learning_class';
    case 'wellness': return 'wellness_calm';
    default: return null;
  }
}

export function resolveInvitationTemplateForTheme(
  theme?: string | null,
  template?: string | null
): string | null {
  const defaultTemplate = getDefaultInvitationTemplate(theme);
  
  if (!template) {
    return defaultTemplate;
  }

  // Verificar si el template es válido para el theme
  let isValid = false;
  switch (theme) {
    case 'kids_birthday':
      // @ts-ignore - The function currently only accepts certain types in TS, but at runtime works
      const kidsConfig = [ 'kids_jungle', 'kids_unicorn', 'kids_space' ];
      isValid = kidsConfig.includes(template);
      break;
    case 'celebration':
      const celConfig = getCelebrationTemplateConfig(template);
      isValid = celConfig.id === template;
      break;
    case 'sports':
      const sportsConfig = getSportsTemplateConfig(template);
      isValid = sportsConfig !== null;
      break;
    case 'entertainment':
      const entConfig = getEntertainmentTemplateConfig(template);
      isValid = entConfig !== null;
      break;
    case 'learning':
      const learningConfig = getLearningTemplateConfig(template);
      isValid = learningConfig !== null;
      break;
    case 'wellness':
      const wellnessConfig = getWellnessTemplateConfig(template);
      isValid = wellnessConfig !== null;
      break;
    default:
      // Para formal, friends, family, special no hay listado estricto con helper o no lo controlamos igual,
      // pero devolvemos el template en caso de que sean temas que lo necesiten.
      // Actualmente family y special SÍ tienen helpers en DetailHost/InvitationPreviewModal...
      // Para ser seguros:
      return template;
  }

  return isValid ? template : defaultTemplate;
}
