import { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { ChevronsDown } from 'lucide-react';
import {
  selectSafeHintPlacement,
  type HintPlacement,
  type RectLike,
} from './homeV3dScrollHintPlacement';
import './HomeV3dScrollHint.css';

/**
 * Señal de continuidad exclusiva de Home V3-D.
 * No depende de GSAP: no modifica ni sus tiempos ni sus coordenadas.
 */
interface HomeV3dScrollHintProps {
  onExplore: () => void;
}

const INTERACTIVE_SELECTORS = [
  '.home-v3d-variant .home-dual-cta',
  '.home-v3d-variant .home-v3d-intent-box',
  '.home-v3d-variant .home-v3d-mic-btn',
  '.home-v3d-variant .home-v3d-intent-clear',
  '.home-v3d-variant .home-suggestion-chip',
  '.home-v3d-variant .home-fab-container--visible',
  '.home-v3d-variant .home-fab-container--visible .home-fab',
  '.home-v3d-variant .home-header',
  '.home-v3d-variant #home-discovery-section button',
  '.home-v3d-variant #home-personal-activity-section button',
  '.home-v3d-variant .home-encounters-section button',
  '.home-v3d-variant .pe-discovery-header',
  '.home-v3d-variant .pe-discovery-title',
  '.home-v3d-variant .pe-discovery-section-subtitle',
  '.home-v3d-variant .pe-inspirational-title',
  '.home-v3d-variant .pe-inspirational-subtitle',
  '.home-v3d-variant .pe-discovery-empty-title',
  '.home-v3d-variant .pe-discovery-empty-desc',
  '.home-v3d-variant .home-encounters-title',
  '.home-v3d-variant #home-personal-activity-section h2',
  '.home-v3d-variant .home-dual-card__title',
  '.home-v3d-variant .home-dual-card__desc',
  '.home-v3d-variant .home-dual-hero__title',
  '.home-v3d-variant .home-dual-hero__subtitle',
  '.home-v3d-variant .home-v3d-card__guarantee',
  '.home-hero-wrapper--v3d .home-gsap-tag',
].join(',');

const MODAL_SELECTORS = [
  '[role="dialog"]',
  '[aria-modal="true"]',
  '.pe-sheet-overlay',
  '.pe-detail-overlay',
  '.pe-zones-overlay',
  '.pe-zones-modal',
  '.pe-avisame-sheet',
  '.pe-discovery-see-all-backdrop',
  '.login-required-overlay',
  '.login-required-sheet',
  '.home-quick-nav-menu',
  '.home-quick-nav-backdrop',
].join(',');

function isVisible(el: HTMLElement): boolean {
  const style = window.getComputedStyle(el);
  if (style.display === 'none' || style.visibility === 'hidden' || Number(style.opacity) < 0.12) return false;
  const rect = el.getBoundingClientRect();
  return rect.width > 0 && rect.height > 0;
}

function modalIsOpen(): boolean {
  return Array.from(document.querySelectorAll<HTMLElement>(MODAL_SELECTORS)).some(isVisible);
}

function focusedOnInput(): boolean {
  const active = document.activeElement;
  return active instanceof HTMLElement && Boolean(active.closest('input,textarea,select,[contenteditable="true"]'));
}

function scrollMetrics(): { top: number; max: number; nested: HTMLElement | null } {
  const nested = document.getElementById('home-scroll-container');
  if (nested && nested.scrollHeight > nested.clientHeight + 32) {
    return { top: nested.scrollTop, max: nested.scrollHeight - nested.clientHeight, nested };
  }
  const root = document.scrollingElement ?? document.documentElement;
  const visibleHeight = window.visualViewport?.height ?? window.innerHeight;
  return {
    top: Math.max(window.scrollY, root.scrollTop),
    max: root.scrollHeight - visibleHeight,
    nested: null,
  };
}

function readSafeAreaBottomPx(): number {
  if (typeof document === 'undefined' || !document.body) return 0;
  const probe = document.createElement('div');
  probe.style.cssText = 'position:fixed;bottom:0;left:0;height:env(safe-area-inset-bottom,0px);width:0;pointer-events:none;visibility:hidden;';
  document.body.appendChild(probe);
  const measured = probe.getBoundingClientRect().height;
  probe.remove();
  return Number.isFinite(measured) ? Math.max(0, Math.round(measured)) : 0;
}

function gatherBlockers(): RectLike[] {
  const rects: RectLike[] = Array.from(document.querySelectorAll<HTMLElement>(INTERACTIVE_SELECTORS))
    .filter(isVisible)
    .map((node) => node.getBoundingClientRect());

  // Proteger de forma continua la banda Zone C de GSAP bajo los chips durante todo el ciclo 26.1s
  const hero = document.querySelector<HTMLElement>('.home-hero-wrapper--v3d');
  const chips = document.querySelector<HTMLElement>('.home-hero-wrapper--v3d .home-suggestions-container');
  if (hero && chips && isVisible(chips)) {
    const heroRect = hero.getBoundingClientRect();
    const chipsRect = chips.getBoundingClientRect();
    const zoneWidth = Math.min(240, Math.max(160, heroRect.width - 24));
    const zoneLeft = Math.round(heroRect.left + (heroRect.width - zoneWidth) / 2);
    rects.push({
      left: zoneLeft,
      right: zoneLeft + zoneWidth,
      top: Math.round(chipsRect.bottom + 4),
      bottom: Math.round(chipsRect.bottom + 46),
    });
  }

  return rects;
}

export function HomeV3dScrollHint({ onExplore }: HomeV3dScrollHintProps) {
  const [placement, setPlacement] = useState<HintPlacement | null>(null);
  const dismissedRef = useRef(false);

  useEffect(() => {
    if (typeof window === 'undefined' || typeof document === 'undefined') return;
    const media = window.matchMedia('(max-width: 767px)');
    let raf = 0;
    let active = true;
    let nestedRoot: HTMLElement | null = null;
    const safeAreaBottom = readSafeAreaBottomPx();

    const recalculate = () => {
      if (!active) return;
      const scroll = scrollMetrics();
      const viewport = window.visualViewport;
      const layoutHeight = window.innerHeight || document.documentElement.clientHeight;
      const visibleHeight = viewport?.height ?? layoutHeight;
      const offsetTop = viewport?.offsetTop ?? 0;
      const offsetLeft = viewport?.offsetLeft ?? 0;
      const visibleWidth = viewport?.width ?? window.innerWidth;
      const keyboardOpen = Boolean(viewport && visibleHeight < layoutHeight - 120);

      if (scroll.top > 28) dismissedRef.current = true;
      if (
        !media.matches ||
        dismissedRef.current ||
        scroll.top > 12 ||
        scroll.max < 48 ||
        keyboardOpen ||
        focusedOnInput() ||
        modalIsOpen() ||
        document.visibilityState !== 'visible'
      ) {
        setPlacement((old) => (old === null ? old : null));
        return;
      }

      const headerEl = document.querySelector<HTMLElement>('.home-v3d-variant .home-header');
      const headerBottom = headerEl ? headerEl.getBoundingClientRect().bottom : 72;
      // Safe-area se compensa una sola vez aquí; el CSS posiciona mediante top exacto dentro del visualViewport.
      const effectiveMinBottom = Math.max(8, safeAreaBottom + 8);

      const next = selectSafeHintPlacement(
        {
          width: visibleWidth,
          height: visibleHeight,
          offsetTop,
          offsetLeft,
          minBottom: effectiveMinBottom,
          headerBottom,
        },
        gatherBlockers(),
      );

      setPlacement((old) => {
        if (old === null && next === null) return old;
        if (
          old &&
          next &&
          old.top === next.top &&
          old.left === next.left &&
          old.bottom === next.bottom &&
          old.align === next.align
        ) {
          return old;
        }
        return next;
      });
    };

    const schedule = () => {
      if (!active || raf) return;
      raf = window.requestAnimationFrame(() => {
        raf = 0;
        recalculate();
      });
    };

    const bindNested = () => {
      const current = document.getElementById('home-scroll-container');
      if (current === nestedRoot) return;
      nestedRoot?.removeEventListener('scroll', schedule);
      nestedRoot = current;
      nestedRoot?.addEventListener('scroll', schedule, { passive: true });
    };

    const onResize = () => {
      bindNested();
      schedule();
    };

    const resizeObserver = new ResizeObserver(onResize);
    resizeObserver.observe(document.documentElement);
    const hero = document.querySelector<HTMLElement>('.home-hero-wrapper--v3d');
    if (hero) resizeObserver.observe(hero);

    const mutationObserver = new MutationObserver(schedule);
    if (document.body) {
      mutationObserver.observe(document.body, {
        childList: true,
        subtree: true,
        attributes: true,
        attributeFilter: ['class', 'style', 'hidden', 'aria-hidden', 'open'],
      });
    }

    bindNested();
    window.addEventListener('scroll', schedule, { passive: true });
    window.addEventListener('resize', onResize);
    document.addEventListener('focusin', schedule);
    document.addEventListener('focusout', schedule);
    document.addEventListener('visibilitychange', schedule);
    media.addEventListener('change', schedule);
    window.visualViewport?.addEventListener('resize', schedule);
    window.visualViewport?.addEventListener('scroll', schedule);
    schedule();

    return () => {
      active = false;
      window.cancelAnimationFrame(raf);
      resizeObserver.disconnect();
      mutationObserver.disconnect();
      nestedRoot?.removeEventListener('scroll', schedule);
      window.removeEventListener('scroll', schedule);
      window.removeEventListener('resize', onResize);
      document.removeEventListener('focusin', schedule);
      document.removeEventListener('focusout', schedule);
      document.removeEventListener('visibilitychange', schedule);
      media.removeEventListener('change', schedule);
      window.visualViewport?.removeEventListener('resize', schedule);
      window.visualViewport?.removeEventListener('scroll', schedule);
    };
  }, []);

  if (placement === null || typeof document === 'undefined') return null;

  return createPortal(
    <button
      type="button"
      className="home-v3d-scroll-hint"
      style={
        {
          '--home-v3d-hint-top': `${placement.top}px`,
          '--home-v3d-hint-left': `${placement.left}px`,
        } as React.CSSProperties
      }
      onClick={() => {
        dismissedRef.current = true;
        setPlacement(null);
        onExplore();
      }}
      aria-label="Deslizá para explorar encuentros"
      data-testid="v3d-viewport-scroll-hint"
      data-align={placement.align}
    >
      <span>Deslizá para explorar</span>
      <ChevronsDown size={18} aria-hidden="true" className="home-v3d-scroll-hint__chevrons" />
    </button>,
    document.body,
  );
}
