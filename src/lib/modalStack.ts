import { useEffect, useRef } from 'react';

/**
 * Gestor global de pila de modales accesibles (Modal Stack).
 *
 * Resuelve de forma determinista el problema de modales anidados donde múltiples
 * escuchadores de "keydown Escape" en window compiten entre sí.
 * Garantiza que únicamente el diálogo que está en la cima (top) de la pila responda a Escape.
 */

const stack: string[] = [];

export function pushModal(id: string): void {
  // Evitar duplicados consecutivos
  const idx = stack.indexOf(id);
  if (idx !== -1) {
    stack.splice(idx, 1);
  }
  stack.push(id);
}

export function popModal(id: string): void {
  const idx = stack.lastIndexOf(id);
  if (idx !== -1) {
    stack.splice(idx, 1);
  }
}

export function isTopModal(id: string): boolean {
  if (stack.length === 0) return false;
  return stack[stack.length - 1] === id;
}

export function hasModalsAbove(id: string): boolean {
  const idx = stack.indexOf(id);
  if (idx === -1) return stack.length > 0;
  return idx < stack.length - 1;
}

export function getActiveModalCount(): number {
  return stack.length;
}

export function resetModalStack(): void {
  stack.length = 0;
}

export interface UseModalStackOptions {
  onEscape?: () => void;
  restoreFocus?: boolean;
}

/**
 * Hook para registrar un modal en la pila, capturar Escape exclusivamente
 * cuando está al frente y restaurar el foco accesible al elemento disparador previo.
 */
export function useModalStack(
  modalId: string,
  isOpen: boolean,
  options?: UseModalStackOptions
) {
  const prevActiveElementRef = useRef<HTMLElement | null>(null);

  useEffect(() => {
    if (!isOpen) return;

    // 1. Guardar el elemento enfocado antes de que el modal capture el foco
    prevActiveElementRef.current = document.activeElement as HTMLElement | null;

    // 2. Apilar este modal
    pushModal(modalId);

    // 3. Listener seguro para Escape
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && isTopModal(modalId)) {
        e.stopPropagation();
        options?.onEscape?.();
      }
    };

    window.addEventListener('keydown', handleKeyDown);

    return () => {
      window.removeEventListener('keydown', handleKeyDown);
      popModal(modalId);

      // 4. Restauración de foco accesible al cerrar
      if (options?.restoreFocus !== false && prevActiveElementRef.current) {
        try {
          prevActiveElementRef.current.focus();
        } catch {}
      }
    };
  }, [isOpen, modalId, options?.onEscape, options?.restoreFocus]);
}
