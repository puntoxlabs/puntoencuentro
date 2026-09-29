import { useWizardStore } from '@/store/wizardStore';
import type { Intencion } from '@/types/intenciones';

/**
 * Preload wizard store from an existing Intención for conversion into an Encounter.
 *
 * Requirements (Fase 2.0-A Bloque 4):
 * - titulo -> titulo
 * - descripcion -> descripcion
 * - modalidad -> modalidad (presencial/virtual; null si es indistinto)
 * - fecha, hora, lugar_texto, link_virtual -> vacíos (no inventar fechas ni direcciones)
 * - sourceIntentionId -> id de la intención en wizardStore
 * - step -> 1
 */
export function preloadWizardFromIntencion(
  intencion: Pick<Intencion, 'id' | 'titulo' | 'descripcion' | 'modalidad'>,
  wizardStore = useWizardStore.getState()
) {
  wizardStore.reset();
  const { setField, setSourceIntentionId } = wizardStore;

  setField('titulo', intencion.titulo || '');
  setField('descripcion', intencion.descripcion || '');
  setField(
    'modalidad',
    intencion.modalidad === 'presencial' || intencion.modalidad === 'virtual'
      ? intencion.modalidad
      : null
  );
  setField('fecha', '');
  setField('hora', '');
  setField('lugar_texto', '');
  setField('link_virtual', '');
  setSourceIntentionId(intencion.id);
  setField('step', 1);
}
