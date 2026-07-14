export const openExternalVideoLink = async (url: string) => {
  if (!url) return;

  let finalUrl = url.trim();

  // Normalizar: si no tiene protocolo reconocido, asumir https
  if (!/^[a-zA-Z][a-zA-Z0-9+\-.]*:\/\//i.test(finalUrl)) {
    finalUrl = `https://${finalUrl}`;
  }

  // Solo permitir http:// y https:// — rechazar javascript:, data:, file:, etc.
  if (!/^https?:\/\//i.test(finalUrl)) {
    console.error('[VIDEO_LINK] Esquema de URL no permitido:', finalUrl);
    return;
  }

  try {
    // 1. Entorno móvil (Capacitor)
    const Capacitor = (window as any).Capacitor;
    if (Capacitor && Capacitor.isNativePlatform()) {
      const Browser = Capacitor.Plugins?.Browser;
      if (Browser && Browser.open) {
        try {
          await Browser.open({ url: finalUrl });
          return;
        } catch (err) {
          console.error("Capacitor Browser.open error:", err);
        }
      }

      const App = Capacitor.Plugins?.App;
      if (App && App.openUrl) {
        try {
          await App.openUrl({ url: finalUrl });
          return;
        } catch (err) {
          console.error("Capacitor App.openUrl error:", err);
        }
      }
    }

    // 2. Cordova InAppBrowser
    const cordova = (window as any).cordova;
    if (cordova && cordova.InAppBrowser) {
      cordova.InAppBrowser.open(finalUrl, '_system');
      return;
    }

    // 3. Fallback Web
    fallbackOpen(finalUrl);
  } catch (error) {
    console.error("Error global en openExternalVideoLink:", error);
    fallbackOpen(finalUrl);
  }
};

const fallbackOpen = (url: string) => {
  try {
    window.open(url, '_blank', 'noopener,noreferrer');
  } catch (e) {
    console.error("Fallo crítico al abrir enlace web:", e);
    // Último recurso: fallback navegación directa
    window.location.assign(url);
  }
};

