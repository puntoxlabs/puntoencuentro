export type RectLike = Pick<DOMRect, 'top' | 'right' | 'bottom' | 'left'>;

export interface HintPlacement {
  bottom: number;
  top: number;
  left: number;
  align: 'center' | 'left' | 'right';
}

const HINT_WIDTH = 204;
const HINT_HEIGHT = 44;
const HORIZONTAL_MARGIN = 14;
const VERTICAL_STEP = 4;
const OBSTACLE_PADDING = 3;

function overlap(a: RectLike, b: RectLike, padding = OBSTACLE_PADDING): boolean {
  return (
    a.left < b.right + padding &&
    a.right > b.left - padding &&
    a.top < b.bottom + padding &&
    a.bottom > b.top - padding
  );
}

/** Función pura y comprobable sin navegador. `null` indica que ningún punto evita bloquear controles. */
export function selectSafeHintPlacement(
  viewport: {
    width: number;
    height: number;
    offsetTop?: number;
    offsetLeft?: number;
    minBottom?: number;
    headerBottom?: number;
    hintWidth?: number;
  },
  blockers: ReadonlyArray<RectLike>,
  candidateBottoms?: readonly number[],
): HintPlacement | null {
  const hintW = Math.min(viewport.hintWidth ?? HINT_WIDTH, Math.max(160, viewport.width - HORIZONTAL_MARGIN * 2));
  const offsetTop = viewport.offsetTop ?? 0;
  const offsetLeft = viewport.offsetLeft ?? 0;
  const visibleBottom = offsetTop + viewport.height;
  const minBottom = Math.max(8, Math.round(viewport.minBottom ?? 10));
  const minSafeTop = Math.max(offsetTop + 72, Math.round((viewport.headerBottom ?? 72) + 8));
  const maxBottom = Math.floor(visibleBottom - HINT_HEIGHT - minSafeTop);

  if (maxBottom < minBottom) return null;

  const bottoms: number[] = candidateBottoms
    ? [...candidateBottoms]
    : Array.from(
        { length: Math.floor((maxBottom - minBottom) / VERTICAL_STEP) + 1 },
        (_, i) => minBottom + i * VERTICAL_STEP,
      );

  const alignments: Array<{ align: 'center' | 'left' | 'right'; left: number }> = [
    { align: 'center', left: Math.round(offsetLeft + (viewport.width - hintW) / 2) },
    { align: 'left', left: Math.round(offsetLeft + HORIZONTAL_MARGIN) },
    { align: 'right', left: Math.round(offsetLeft + viewport.width - hintW - HORIZONTAL_MARGIN) },
  ];

  for (const bottom of bottoms) {
    if (bottom < minBottom) continue;
    const top = Math.round(visibleBottom - bottom - HINT_HEIGHT);
    const rectBottom = top + HINT_HEIGHT;
    if (top < minSafeTop) continue;

    for (const { align, left } of alignments) {
      if (left < offsetLeft + 8 || left + hintW > offsetLeft + viewport.width - 8) continue;
      const candidate: RectLike = {
        left,
        right: left + hintW,
        top,
        bottom: rectBottom,
      };
      if (blockers.every((rect) => !overlap(candidate, rect))) {
        return { bottom, top, left, align };
      }
    }
  }

  return null;
}
