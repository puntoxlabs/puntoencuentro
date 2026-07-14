export const HOST_ALIAS_KEY = 'puntoencuentro_host_alias';

export const getHostAlias = (): string => {
  try {
    return localStorage.getItem(HOST_ALIAS_KEY)?.trim() || '';
  } catch {
    return '';
  }
};

export const setHostAlias = (alias: string) => {
  try {
    // Eliminar saltos de línea y espacios extra
    let cleanAlias = alias.replace(/[\r\n]+/g, ' ').trim();
    // Limitar largo máximo a 40 caracteres
    if (cleanAlias.length > 40) {
      cleanAlias = cleanAlias.substring(0, 40).trim();
    }

    if (cleanAlias === '') {
      localStorage.removeItem(HOST_ALIAS_KEY);
    } else {
      localStorage.setItem(HOST_ALIAS_KEY, cleanAlias);
    }
  } catch {
    // Ignorar errores de localStorage (ej. navegación privada estricta)
  }
};
