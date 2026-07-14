import React, { useRef, useEffect } from 'react';
import { KidsBirthdayTemplateSelector } from '@/components/ui/KidsBirthdayTemplateSelector';
import { CelebrationTemplateSelector } from '@/components/ui/CelebrationTemplateSelector';
import { RomanticTemplateSelector } from '@/components/ui/RomanticTemplateSelector';
import { FormalTemplateSelector } from '@/components/ui/FormalTemplateSelector';
import { FriendsTemplateSelector } from '@/components/ui/FriendsTemplateSelector';
import { FamilyTemplateSelector } from '@/components/ui/FamilyTemplateSelector';
import { SpecialTemplateSelector } from '@/components/ui/SpecialTemplateSelector';
import { SportsTemplateSelector } from '@/components/ui/SportsTemplateSelector';
import { EntertainmentTemplateSelector } from '@/components/ui/EntertainmentTemplateSelector';
import { LearningTemplateSelector } from '@/components/ui/LearningTemplateSelector';
import { WellnessTemplateSelector } from './WellnessTemplateSelector';
import type { InvitationTheme } from '@/lib/invitationThemes';

export interface ActiveThemeTemplateSelectorProps {
  theme: InvitationTheme;
  template: string | null;
  onSelect: (templateId: string) => void;
  titulo?: string;
  descripcion?: string;
  fecha?: string;
  hora?: string;
  lugar_texto?: string;
  displayDateLabel?: string;
}

export const ActiveThemeTemplateSelector: React.FC<ActiveThemeTemplateSelectorProps> = ({
  theme,
  template,
  onSelect,
  titulo,
  descripcion,
  fecha,
  hora,
  lugar_texto,
  displayDateLabel
}) => {
  const containerRef = useRef<HTMLDivElement>(null);

  // Focus and scroll when this mounts or becomes visible
  useEffect(() => {
    if (theme && theme !== 'classic' && theme !== 'custom') {
      // Small timeout to allow the DOM to render the conditional children
      const timer = setTimeout(() => {
        if (containerRef.current) {
          const prefersReducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
          containerRef.current.scrollIntoView({
            behavior: prefersReducedMotion ? 'auto' : 'smooth',
            block: 'nearest',
          });
        }
      }, 100);
      return () => clearTimeout(timer);
    }
  }, [theme]);

  if (!theme || theme === 'classic' || theme === 'custom') {
    return null;
  }

  return (
    <div ref={containerRef} style={{ marginTop: 16 }}>
      {theme === 'kids_birthday' && (
        <KidsBirthdayTemplateSelector
          selectedTemplateId={template}
          onSelect={onSelect}
          titulo={titulo}
          descripcion={descripcion}
          fecha={fecha}
          hora={hora}
          lugar_texto={lugar_texto}
          displayDateLabel={displayDateLabel}
        />
      )}
      {theme === 'celebration' && (
        <CelebrationTemplateSelector
          selectedTemplateId={template}
          onSelect={onSelect}
          titulo={titulo}
          descripcion={descripcion}
          fecha={fecha}
          hora={hora}
          lugar_texto={lugar_texto}
          displayDateLabel={displayDateLabel}
        />
      )}
      {theme === 'romantic' && (
        <RomanticTemplateSelector
          selectedTemplateId={template}
          onSelect={onSelect}
          titulo={titulo}
          descripcion={descripcion}
          fecha={fecha}
          hora={hora}
          lugar_texto={lugar_texto}
          displayDateLabel={displayDateLabel}
        />
      )}
      {theme === 'formal' && (
        <FormalTemplateSelector
          selectedTemplateId={template}
          onSelect={onSelect}
          titulo={titulo}
          descripcion={descripcion}
          fecha={fecha}
          hora={hora}
          lugar_texto={lugar_texto}
          displayDateLabel={displayDateLabel}
        />
      )}
      {theme === 'friends' && (
        <FriendsTemplateSelector
          selectedTemplateId={template}
          onSelect={onSelect}
          titulo={titulo}
          descripcion={descripcion}
          fecha={fecha}
          hora={hora}
          lugar_texto={lugar_texto}
          displayDateLabel={displayDateLabel}
        />
      )}
      {theme === 'family' && (
        <FamilyTemplateSelector
          selectedTemplateId={template}
          onSelect={onSelect}
          titulo={titulo}
          descripcion={descripcion}
          fecha={fecha}
          hora={hora}
          lugar_texto={lugar_texto}
          displayDateLabel={displayDateLabel}
        />
      )}
      {theme === 'special' && (
        <SpecialTemplateSelector
          selectedTemplateId={template}
          onSelect={onSelect}
          titulo={titulo}
          descripcion={descripcion}
          fecha={fecha}
          hora={hora}
          lugar_texto={lugar_texto}
          displayDateLabel={displayDateLabel}
        />
      )}
      {theme === 'sports' && (
        <SportsTemplateSelector
          selectedTemplateId={template}
          onSelect={onSelect}
          titulo={titulo}
          descripcion={descripcion}
          fecha={fecha}
          hora={hora}
          lugar_texto={lugar_texto}
          displayDateLabel={displayDateLabel}
        />
      )}
      {theme === 'entertainment' && (
        <EntertainmentTemplateSelector
          selectedTemplateId={template}
          onSelect={onSelect}
          titulo={titulo}
          descripcion={descripcion}
          fecha={fecha}
          hora={hora}
          lugar_texto={lugar_texto}
          displayDateLabel={displayDateLabel}
        />
      )}
      {theme === 'learning' && (
        <LearningTemplateSelector
          selectedTemplateId={template}
          onSelect={onSelect}
          titulo={titulo}
          descripcion={descripcion}
          fecha={fecha}
          hora={hora}
          lugar_texto={lugar_texto}
          displayDateLabel={displayDateLabel}
        />
      )}
      {theme === 'wellness' && (
        <WellnessTemplateSelector
          selectedTemplateId={template}
          onSelect={onSelect}
          titulo={titulo}
          descripcion={descripcion}
          fecha={fecha}
          hora={hora}
          lugar_texto={lugar_texto}
          displayDateLabel={displayDateLabel}
        />
      )}
    </div>
  );
};
