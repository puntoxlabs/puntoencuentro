import i18n from 'i18next';
import { initReactI18next } from 'react-i18next';

import es from '@/i18n/locales/es.json';
import en from '@/i18n/locales/en.json';
import ptBR from '@/i18n/locales/pt-BR.json';
import pt from '@/i18n/locales/pt.json';

i18n
  .use(initReactI18next)
  .init({
    resources: {
      es: { translation: es },
      en: { translation: en },
      'pt-BR': { translation: ptBR },
      pt: { translation: pt }
    },
    lng: 'es', // Default language
    fallbackLng: 'en',
    interpolation: {
      escapeValue: false
    }
  });

if (typeof window !== 'undefined' && import.meta.env.DEV) {
  (window as any).i18n = i18n;
}

export default i18n;
