import { Component, computed, input } from '@angular/core';

/** Íconos vectoriales (estilo línea, 24x24). Cada ícono es una lista de trazos. */
const ICONS = {
  home: ['M3 11l9-8 9 8', 'M5 10v10h14V10', 'M10 20v-6h4v6'],
  cart: ['M7 21a1 1 0 1 0 2 0a1 1 0 1 0 -2 0', 'M18 21a1 1 0 1 0 2 0a1 1 0 1 0 -2 0', 'M2 3h2.5l2.6 12.4a2 2 0 0 0 2 1.6h9.3a2 2 0 0 0 2-1.6L22 7H5.2'],
  inbox: ['M12 3v12', 'M7 11l5 5 5-5', 'M4 20h16'],
  clipboard: ['M9 2h6v4H9z', 'M15 4h1a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2h1', 'M9 14l2 2 4-4'],
  book: ['M5 4h11a3 3 0 0 1 3 3v13H8a3 3 0 0 1-3-3z', 'M9 9h6', 'M9 13h6'],
  box: ['M21 8l-9-5-9 5v8l9 5 9-5z', 'M3 8l9 5 9-5', 'M12 13v8'],
  trash: ['M3 6h18', 'M8 6V4h8v2', 'M6 6l1 14h10l1-14', 'M10 11v5', 'M14 11v5'],
  phone: ['M8 2h8a1 1 0 0 1 1 1v18a1 1 0 0 1-1 1H8a1 1 0 0 1-1-1V3a1 1 0 0 1 1-1z', 'M11 18h2'],
  qr: ['M3 3h7v7H3z', 'M14 3h7v7h-7z', 'M3 14h7v7H3z', 'M14 14h3v3h-3z', 'M20 14v3', 'M17 20h4'],
  cash: ['M2 6h20v12H2z', 'M9 12a3 3 0 1 0 6 0a3 3 0 1 0 -6 0', 'M5.5 12h.01', 'M18.5 12h.01'],
  power: ['M12 2v9', 'M18.4 6.6a9 9 0 1 1-12.8 0'],
  clock: ['M3 12a9 9 0 1 0 18 0a9 9 0 1 0 -18 0', 'M12 7v5l3 2'],
  close: ['M6 6l12 12', 'M18 6L6 18'],
  arrow: ['M5 12h14', 'M13 6l6 6-6 6'],
  logo: ['M12 3l9 9-9 9-9-9z', 'M9.8 12a2.2 2.2 0 1 0 4.4 0a2.2 2.2 0 1 0 -4.4 0'],
  refresh: ['M21 12a9 9 0 1 1-9-9c2.52 0 4.93 1 6.74 2.74L21 8', 'M21 3v5h-5'],
  user: ['M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2', 'M12 3a4 4 0 1 0 0 8 4 4 0 0 0 0-8'],
} as const;

export type IconName = keyof typeof ICONS;

@Component({
  selector: 'app-icon',
  template: `
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"
         stroke-linecap="round" stroke-linejoin="round" width="100%" height="100%" aria-hidden="true">
      @for (d of paths(); track $index) {
        <path [attr.d]="d" />
      }
    </svg>
  `,
  host: {
    class: 'inline-block shrink-0',
    '[style.width.px]': 'size()',
    '[style.height.px]': 'size()',
  },
})
export class IconComponent {
  readonly name = input.required<IconName>();
  readonly size = input<number>(20);
  protected readonly paths = computed<readonly string[]>(() => ICONS[this.name()]);
}
