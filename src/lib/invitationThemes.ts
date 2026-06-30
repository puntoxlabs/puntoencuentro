import { 
  Building2, 
  Coffee, 
  PartyPopper, 
  Gamepad2, 
  Home, 
  Star,
  CheckCircle2
} from 'lucide-react';

export type InvitationTheme =
  | 'classic'
  | 'formal'
  | 'friends'
  | 'celebration'
  | 'kids_birthday'
  | 'family'
  | 'special';

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
    id: 'formal',
    label: 'Formal',
    description: 'Trabajo, institucional o académico.',
    icon: Building2,
    cssClass: 'guest-theme--formal',
    eyebrow: 'Te invitan a una reunión'
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
    id: 'family',
    label: 'Familia',
    description: 'Almuerzos y reuniones familiares.',
    icon: Home,
    cssClass: 'guest-theme--family',
    eyebrow: 'Encuentro familiar'
  },
  {
    id: 'special',
    label: 'Especial',
    description: 'Cenas especiales o aniversarios.',
    icon: Star,
    cssClass: 'guest-theme--special',
    eyebrow: 'Tenés una invitación especial'
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
    'special'
  ];
  
  if (validThemes.includes(value as InvitationTheme)) {
    return value as InvitationTheme;
  }
  
  return 'classic';
}
