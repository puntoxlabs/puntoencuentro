export const openLink = async (url: string) => {
  try {
    // 1. Intentar Capacitor
    const Capacitor = (window as any).Capacitor;
    if (Capacitor && Capacitor.isNativePlatform()) {
      // Necesitamos asegurar que el plugin de App exista en el bundle
      // Si usan @capacitor/app se registra en Capacitor.Plugins
      const App = Capacitor.Plugins?.App;
      if (App && App.openUrl) {
        try {
          await App.openUrl({ url });
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
      cordova.InAppBrowser.open(url, '_system');
      return;
    }

    // 3. Fallback Web
    fallbackOpen(url);
  } catch (error) {
    console.error("Error global en openLink:", error);
    fallbackOpen(url);
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
