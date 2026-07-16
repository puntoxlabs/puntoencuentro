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


import { celebrationTemplates } from './celebrationTemplates';
import { getSportsTemplateConfig, sportsTemplates } from './sportsTemplates';
import { getEntertainmentTemplateConfig, entertainmentTemplates } from './entertainmentTemplates';
import { getLearningTemplateConfig, learningTemplates } from './learningTemplates';
import { getWellnessTemplateConfig, wellnessTemplates } from './wellnessTemplates';
import { kidsBirthdayTemplates } from './kidsBirthdayTemplates';
import { formalTemplates, getFormalTemplateConfig } from './formalTemplates';
import { friendsTemplates, getFriendsTemplateConfig } from './friendsTemplates';
import { familyTemplates, getFamilyTemplateConfig } from './familyTemplates';
import { specialTemplates, getSpecialTemplateConfig } from './specialTemplates';
import { romanticTemplates, getRomanticTemplateConfig } from './romanticTemplates';

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
  | 'wellness'
  | 'custom';

export function isInvitationTheme(value: unknown): value is InvitationTheme {
  return typeof value === 'string' && [
    'classic', 'formal', 'friends', 'celebration', 'kids_birthday',
    'family', 'special', 'romantic', 'sports', 'entertainment',
    'learning', 'wellness', 'custom'
  ].includes(value);
}

export function parseInvitationTheme(value: unknown): InvitationTheme | null {
  return isInvitationTheme(value) ? value : null;
}

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
    id: 'classic',
    label: 'Clásico',
    description: 'Profesional, neutro y claro.',
    icon: CheckCircle2,
    cssClass: 'guest-theme--classic',
    eyebrow: 'Te invitan a un encuentro'
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
    id: 'learning',
    label: 'Formación',
    description: 'Cursos, talleres y aprendizaje.',
    icon: BookOpen,
    cssClass: 'guest-theme--learning',
    eyebrow: 'Una invitación para aprender'
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
    id: 'romantic',
    label: 'Romántico',
    description: 'Cenas románticas y aniversarios.',
    icon: Heart,
    cssClass: 'guest-theme--romantic',
    eyebrow: 'Te invitan a un encuentro especial'
  },
  {
    id: 'custom',
    label: 'Diseño personalizado',
    description: 'Diseño subido por el organizador.',
    icon: Star,
    cssClass: 'guest-theme--custom',
    eyebrow: 'Te invitan a un evento'
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
    'wellness',
    'custom'
  ];

  if (validThemes.includes(value as InvitationTheme)) {
    return value as InvitationTheme;
  }

  return 'classic';
}

export function getDefaultInvitationTemplate(theme?: InvitationTheme | null): string | null {
  switch (theme) {
    case 'kids_birthday': return 'kids_jungle';
    case 'celebration': return 'celebration_gold';
    case 'sports': return 'sports_field';
    case 'entertainment': return 'entertainment_cinema';
    case 'learning': return 'learning_class';
    case 'wellness': return 'wellness_calm';
    case 'friends': return 'friends_coffee';
    case 'formal': return 'formal_black_tie';
    case 'family': return 'family_home';
    case 'special': return 'special_moment';
    case 'romantic': return 'romantic_classic';
    default: return null;
  }
}

export function getThemeFromTemplate(template?: string | null): InvitationTheme | null {
  if (!template) return null;

  if (template.startsWith('kids_')) return 'kids_birthday';
  if (template.startsWith('celebration_')) return 'celebration';
  if (template.startsWith('sports_')) return 'sports';
  if (template.startsWith('entertainment_')) return 'entertainment';
  if (template.startsWith('learning_')) return 'learning';
  if (template.startsWith('wellness_')) return 'wellness';
  if (template.startsWith('formal_')) return 'formal';
  if (template.startsWith('friends_')) return 'friends';
  if (template.startsWith('family_')) return 'family';
  if (template.startsWith('special_')) return 'special';
  if (template.startsWith('romantic_')) return 'romantic';
  if (template.startsWith('custom_')) return 'custom';

  return null;
}

export interface InvitationTemplateOption {
  id: string;
  name: string;
}

export function themeRequiresTemplate(theme?: InvitationTheme | null): boolean {
  if (!theme || theme === 'classic' || theme === 'custom') return false;
  // All other predefined themes require a template
  const validThemes: InvitationTheme[] = [
    'formal', 'friends', 'celebration', 'kids_birthday', 'family',
    'special', 'romantic', 'sports', 'entertainment', 'learning', 'wellness'
  ];
  return validThemes.includes(theme);
}

export function isTemplateValidForTheme(theme?: InvitationTheme | null, template?: string | null): boolean {
  if (!theme || !template) return false;

  switch (theme) {
    case 'kids_birthday': {
      const kidsConfig = ['kids_jungle', 'kids_unicorn', 'kids_space'];
      return kidsConfig.includes(template);
    }
    case 'celebration': return !!celebrationTemplates.find(t => t.id === template);
    case 'sports': return getSportsTemplateConfig(template) !== null;
    case 'entertainment': return getEntertainmentTemplateConfig(template) !== null;
    case 'learning': return getLearningTemplateConfig(template) !== null;
    case 'wellness': return getWellnessTemplateConfig(template) !== null;
    case 'romantic': return getRomanticTemplateConfig(template) !== null;
    case 'formal': return getFormalTemplateConfig(template) !== null;
    case 'friends': return getFriendsTemplateConfig(template) !== null;
    case 'family': return getFamilyTemplateConfig(template) !== null;
    case 'special': return getSpecialTemplateConfig(template) !== null;
    case 'custom': return template.startsWith('custom_');
    case 'classic': return false;
    default: return false;
  }
}

export function getTemplateOptionsForTheme(theme?: InvitationTheme | null): readonly InvitationTemplateOption[] {
  if (!theme) return [];
  switch (theme) {
    case 'celebration': return celebrationTemplates as InvitationTemplateOption[];
    case 'sports': return sportsTemplates as InvitationTemplateOption[];
    case 'entertainment': return entertainmentTemplates as InvitationTemplateOption[];
    case 'learning': return learningTemplates as InvitationTemplateOption[];
    case 'wellness': return wellnessTemplates as InvitationTemplateOption[];
    case 'romantic': return romanticTemplates as InvitationTemplateOption[];
    case 'formal': return formalTemplates as InvitationTemplateOption[];
    case 'friends': return friendsTemplates as InvitationTemplateOption[];
    case 'family': return familyTemplates as InvitationTemplateOption[];
    case 'special': return specialTemplates as InvitationTemplateOption[];
    case 'kids_birthday': return kidsBirthdayTemplates as InvitationTemplateOption[];
    default: return [];
  }
}

export function resolveInvitationTemplateForTheme(
  theme?: InvitationTheme | null,
  template?: string | null
): string | null {
  const defaultTemplate = getDefaultInvitationTemplate(theme);

  if (!template) {
    return defaultTemplate;
  }

  const isValid = isTemplateValidForTheme(theme, template);

  if (theme === 'classic') return null;
  if (!isValid && theme !== 'custom' && !themeRequiresTemplate(theme)) {
    return template; // unknown theme
  }

  return isValid ? template : defaultTemplate;
}

export interface InvitationDesignOption {
  theme: InvitationTheme;
  template: string | null;
  categoryLabel: string;
  templateLabel: string | null;
  customDesignId?: string;
  customImagePath?: string | null;
  customThumbnailPath?: string | null;
}

export function getAllInvitationDesignOptions(): InvitationDesignOption[] {
  const options: InvitationDesignOption[] = [];

  const getThemeLabel = (id: string) => INVITATION_THEMES.find(t => t.id === id)?.label || '';

  // Clásico
  options.push({
    theme: 'classic',
    template: null,
    categoryLabel: getThemeLabel('classic'),
    templateLabel: 'Clásico'
  });

  // Amigos
  const friendsLabel = getThemeLabel('friends');
  friendsTemplates.forEach(t => {
    options.push({ theme: 'friends', template: t.id, categoryLabel: friendsLabel, templateLabel: t.name });
  });

  // Bienestar
  const wellnessLabel = getThemeLabel('wellness');
  wellnessTemplates.forEach(t => {
    options.push({ theme: 'wellness', template: t.id, categoryLabel: wellnessLabel, templateLabel: t.name });
  });

  // Celebración
  const celebrationLabel = getThemeLabel('celebration');
  celebrationTemplates.forEach(t => {
    options.push({ theme: 'celebration', template: t.id, categoryLabel: celebrationLabel, templateLabel: t.name });
  });

  // Cumple Infantil
  const kidsLabel = getThemeLabel('kids_birthday');
  kidsBirthdayTemplates.forEach(t => {
    options.push({ theme: 'kids_birthday', template: t.id, categoryLabel: kidsLabel, templateLabel: t.name });
  });

  // Deportes
  const sportsLabel = getThemeLabel('sports');
  sportsTemplates.forEach(t => {
    options.push({ theme: 'sports', template: t.id, categoryLabel: sportsLabel, templateLabel: t.name });
  });

  // Entretenimiento
  const entertainmentLabel = getThemeLabel('entertainment');
  entertainmentTemplates.forEach(t => {
    options.push({ theme: 'entertainment', template: t.id, categoryLabel: entertainmentLabel, templateLabel: t.name });
  });

  // Especial
  const specialLabel = getThemeLabel('special');
  specialTemplates.forEach(t => {
    options.push({ theme: 'special', template: t.id, categoryLabel: specialLabel, templateLabel: t.name });
  });

  // Familia
  const familyLabel = getThemeLabel('family');
  familyTemplates.forEach(t => {
    options.push({ theme: 'family', template: t.id, categoryLabel: familyLabel, templateLabel: t.name });
  });

  // Formal
  const formalLabel = getThemeLabel('formal');
  formalTemplates.forEach(t => {
    options.push({ theme: 'formal', template: t.id, categoryLabel: formalLabel, templateLabel: t.name });
  });

  // Formación
  const learningLabel = getThemeLabel('learning');
  learningTemplates.forEach(t => {
    options.push({ theme: 'learning', template: t.id, categoryLabel: learningLabel, templateLabel: t.name });
  });

  // Romántico
  const romanticLabel = getThemeLabel('romantic');
  romanticTemplates.forEach(t => {
    options.push({ theme: 'romantic', template: t.id, categoryLabel: romanticLabel, templateLabel: t.name });
  });

  return options;
}

export function findDesignOptionIndex(theme: string | null | undefined, template: string | null | undefined): number {
  const options = getAllInvitationDesignOptions();
  const themeNormalized = normalizeInvitationTheme(theme);

  const index = options.findIndex(opt => opt.theme === themeNormalized && opt.template === template);

  if (index !== -1) return index;

  // If exact match not found, try to find the theme default
  const themeIndex = options.findIndex(opt => opt.theme === themeNormalized);
  return themeIndex !== -1 ? themeIndex : 0;
}
