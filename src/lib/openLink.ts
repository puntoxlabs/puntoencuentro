export const openLink = async (url: string) => {
  console.log('[openLink] Recibida URL original:', url);
  
  let finalUrl = url.trim();
  // Ensure the URL is absolute to prevent the browser from treating it as a relative path
  if (!/^https?:\/\//i.test(finalUrl) && !/^[a-zA-Z0-9]+:\/\//i.test(finalUrl)) {
    finalUrl = `https://${finalUrl}`;
  }

  console.log('[openLink] URL enviada a procesar:', finalUrl);

  try {
    // 1. Intentar Capacitor
    const Capacitor = (window as any).Capacitor;
    if (Capacitor && Capacitor.isNativePlatform()) {
      // Necesitamos asegurar que el plugin de App exista en el bundle
      // Si usan @capacitor/app se registra en Capacitor.Plugins
      const App = Capacitor.Plugins?.App;
      if (App && App.openUrl) {
        try {
          console.log('[openLink] Abriendo con Capacitor App.openUrl');
          await App.openUrl({ url: finalUrl });
          return;
        } catch (err) {
          console.error("Capacitor openUrl error:", err);
          // Si falla, permitimos que siga el flujo hacia el fallback
        }
      }
    }

    // 2. Intentar Cordova InAppBrowser
    const cordova = (window as any).cordova;
    if (cordova && cordova.InAppBrowser) {
      console.log('[openLink] Abriendo con Cordova InAppBrowser');
      cordova.InAppBrowser.open(finalUrl, '_system');
      return;
    }

    // 3. Fallback Web
    console.log('[openLink] Abriendo con Fallback Web');
    fallbackOpen(finalUrl);
  } catch (error) {
    console.error("Error global en openLink:", error);
    fallbackOpen(finalUrl);
  }
};

const fallbackOpen = (url: string) => {
  try {
    window.open(url, '_blank', 'noopener,noreferrer');
  } catch (e) {
    console.error("Fallo crítico al abrir enlace web:", e);
    // Último recurso: navegación directa
    window.location.href = url;
  }
};
