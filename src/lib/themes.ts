import type { CSSProperties } from 'react';

export type ThemeId = 'blue' | 'green' | 'orange' | 'purple' | 'pink' | 'yellow';

export interface Theme {
  id: ThemeId;
  label: string;
  emoji: string;
  description: string;
  primary: string;
  primaryDark: string;
  primaryContainer: string;
  onPrimaryContainer: string;
  backgroundTint: string;
  primaryShadow: string;
  primaryFocusRing: string;
}

export const themes: Record<ThemeId, Theme> = {
  blue: {
    id: 'blue',
    label: 'Clásico',
    emoji: '💙',
    description: 'Claro y confiable',
    primary: '#1A56F0',
    primaryDark: '#0B3FCC',
    primaryContainer: '#E0EBFF',
    onPrimaryContainer: '#001050',
    backgroundTint: '#F4F6FC',
    primaryShadow: 'rgba(26,86,240,0.20)',
    primaryFocusRing: 'rgba(26,86,240,0.12)',
  },
  green: {
    id: 'green',
    label: 'Social',
    emoji: '💚',
    description: 'Cálido y cercano',
    primary: '#1B9E6E',
    primaryDark: '#147A54',
    primaryContainer: '#D6F5E8',
    onPrimaryContainer: '#00331E',
    backgroundTint: '#F0FAF6',
    primaryShadow: 'rgba(27,158,110,0.20)',
    primaryFocusRing: 'rgba(27,158,110,0.12)',
  },
  orange: {
    id: 'orange',
    label: 'Energía',
    emoji: '🧡',
    description: 'Dinámico y activo',
    primary: '#E85D04',
    primaryDark: '#C44E03',
    primaryContainer: '#FFE8D6',
    onPrimaryContainer: '#4A1800',
    backgroundTint: '#FFF5EF',
    primaryShadow: 'rgba(232,93,4,0.20)',
    primaryFocusRing: 'rgba(232,93,4,0.12)',
  },
  purple: {
    id: 'purple',
    label: 'Evento',
    emoji: '💜',
    description: 'Especial y atractivo',
    primary: '#6B3FA0',
    primaryDark: '#552F85',
    primaryContainer: '#EDE0FF',
    onPrimaryContainer: '#20004E',
    backgroundTint: '#F5F0FF',
    primaryShadow: 'rgba(107,63,160,0.20)',
    primaryFocusRing: 'rgba(107,63,160,0.12)',
  },
  pink: {
    id: 'pink',
    label: 'Pasión',
    emoji: '🩷',
    description: 'Vibrante y expresivo',
    primary: '#E91E63',
    primaryDark: '#C2185B',
    primaryContainer: '#FCE4EC',
    onPrimaryContainer: '#4A0020',
    backgroundTint: '#FFF5F8',
    primaryShadow: 'rgba(233,30,99,0.20)',
    primaryFocusRing: 'rgba(233,30,99,0.12)',
  },
  yellow: {
    id: 'yellow',
    label: 'Alegría',
    emoji: '🌟',
    description: 'Cálido y luminoso',
    primary: '#F59E0B',
    primaryDark: '#D97706',
    primaryContainer: '#FEF3C7',
    onPrimaryContainer: '#451A00',
    backgroundTint: '#FFFBEB',
    primaryShadow: 'rgba(245,158,11,0.20)',
    primaryFocusRing: 'rgba(245,158,11,0.12)',
  },
};

export const DEFAULT_THEME: ThemeId = 'blue';

export function getThemeStyle(themeId?: string | null): CSSProperties {
  const safeId: ThemeId =
    themeId && themes[themeId as ThemeId] ? (themeId as ThemeId) : DEFAULT_THEME;
  const t = themes[safeId];

  return {
    '--color-primary': t.primary,
    '--color-primary-dark': t.primaryDark,
    '--color-primary-container': t.primaryContainer,
    '--color-on-primary-container': t.onPrimaryContainer,
    '--color-background': t.backgroundTint,
    '--color-primary-shadow': t.primaryShadow,
    '--color-primary-focus-ring': t.primaryFocusRing,
  } as CSSProperties;
}
