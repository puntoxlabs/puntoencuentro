import i18n from 'i18next';
import { initReactI18next } from 'react-i18next';

import es from '@/i18n/locales/es.json';
import en from '@/i18n/locales/en.json';
import pt from '@/i18n/locales/pt.json';

i18n
  .use(initReactI18next)
  .init({
    resources: {
      es: { translation: es },
      en: { translation: en },
      pt: { translation: pt }
    },
    lng: 'es', // Default language
    fallbackLng: 'en',
    interpolation: {
      escapeValue: false
    }
  });

export default i18n;
