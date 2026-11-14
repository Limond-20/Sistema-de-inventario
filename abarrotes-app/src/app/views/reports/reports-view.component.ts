import { Component, computed, inject, signal } from '@angular/core';
import { CommonModule, DecimalPipe } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { MockInventoryService } from '../../services/mock-inventory.service';
import { IconComponent } from '../../components/icon/icon.component';
import {
  type ReportPeriodPreset,
  type ReportTabKey,
  type IndicatorCardMetric,
  type IndicatorTone,
  formatCentsMxn,
  formatDurationCompact,
  formatLocalYyyyMmDd,
} from '../../domain/reports';

interface ReportTabMeta {
  key: ReportTabKey;
  label: string;
}

@Component({
  selector: 'app-reports-view',
  standalone: true,
  imports: [CommonModule, FormsModule, DecimalPipe, IconComponent],
  templateUrl: './reports-view.component.html',
})
export class ReportsViewComponent {
  protected readonly inv = inject(MockInventoryService);

  protected readonly preset = signal<ReportPeriodPreset>('MES');
  protected readonly customStartDate = signal<string>(formatLocalYyyyMmDd(new Date()));
  protected readonly customEndDate = signal<string>(formatLocalYyyyMmDd(new Date()));
  protected readonly activeTab = signal<ReportTabKey>('VENTAS');
  protected readonly exportFeedback = signal<{ ok: boolean; text: string } | null>(null);

  // Encuesta semanal inline opcional cuando esté pendiente
  protected readonly inlineSurveyOpen = signal<boolean>(false);
  protected readonly inlineSurveyRating = signal<number>(5);
  protected readonly inlineSurveyComment = signal<string>('');

  protected readonly reportTabs: ReportTabMeta[] = [
    { key: 'VENTAS', label: 'Ventas' },
    { key: 'MARGENES', label: 'Márgenes' },
    { key: 'MERMAS', label: 'Mermas' },
    { key: 'CREDITOS_VENCIDOS', label: 'Créditos vencidos' },
    { key: 'DIFERENCIAS_CONTEO', label: 'Stock vs. conteo' },
    { key: 'TIEMPO_VENTAS', label: 'Tiempo por venta' },
    { key: 'VALUACION_INVENTARIO', label: 'Valor inventario' },
  ];

  protected readonly bundle = computed(() =>
    this.inv.getReportsBundle({
      preset: this.preset(),
      startDate: this.customStartDate(),
      endDate: this.customEndDate(),
    })
  );

  protected readonly activeTabLabel = computed(
    () => this.reportTabs.find((t) => t.key === this.activeTab())?.label || 'Ventas'
  );

  protected readonly nonZeroHourRows = computed(() =>
    this.bundle().sales.byHour.filter((h) => h.ticketCount > 0 || h.returnsCents > 0)
  );

  setPreset(next: ReportPeriodPreset): void {
    this.preset.set(next);
    this.exportFeedback.set(null);
  }

  selectTab(tab: ReportTabKey): void {
    this.activeTab.set(tab);
    this.exportFeedback.set(null);
  }

  onIndicatorClick(card: IndicatorCardMetric): void {
    if (card.targetReportTab) {
      this.selectTab(card.targetReportTab);
    }
  }

  downloadCurrentCsv(): void {
    const tab = this.activeTab();
    const res = this.inv.downloadReportCsv(tab, {
      preset: this.preset(),
      startDate: this.customStartDate(),
      endDate: this.customEndDate(),
    });
    this.exportFeedback.set({
      ok: true,
      text: `Archivo CSV UTF-8 (con BOM) generado: ${res.filename}`,
    });
  }

  downloadIndicatorsCsv(): void {
    const res = this.inv.downloadReportCsv('INDICADORES', {
      preset: this.preset(),
      startDate: this.customStartDate(),
      endDate: this.customEndDate(),
    });
    this.exportFeedback.set({
      ok: true,
      text: `Panel de 8 indicadores exportado: ${res.filename}`,
    });
  }

  printCurrentReport(): void {
    if (typeof window !== 'undefined' && typeof window.print === 'function') {
      window.print();
    }
  }

  openInlineSurvey(): void {
    this.inlineSurveyRating.set(5);
    this.inlineSurveyComment.set('');
    this.inlineSurveyOpen.set(true);
  }

  closeInlineSurvey(): void {
    this.inlineSurveyOpen.set(false);
  }

  submitInlineSurvey(): void {
    const res = this.inv.submitSatisfactionSurvey({
      rating: this.inlineSurveyRating(),
      comment: this.inlineSurveyComment(),
    });
    this.exportFeedback.set({ ok: res.ok, text: res.message });
    if (res.ok) {
      this.inlineSurveyOpen.set(false);
    }
  }

  formatCents(cents: number): string {
    return formatCentsMxn(cents);
  }

  formatDuration(ms: number): string {
    return formatDurationCompact(ms);
  }

  toneBadgeClasses(tone: IndicatorTone): string {
    switch (tone) {
      case 'emerald':
        return 'bg-emerald-100 text-emerald-800 border-emerald-200';
      case 'amber':
        return 'bg-amber-100 text-amber-900 border-amber-200';
      case 'red':
        return 'bg-rose-100 text-rose-800 border-rose-200';
      default:
        return 'bg-slate-100 text-slate-700 border-slate-200';
    }
  }

  toneAccentBorder(tone: IndicatorTone): string {
    switch (tone) {
      case 'emerald':
        return 'border-l-4 border-l-emerald-600';
      case 'amber':
        return 'border-l-4 border-l-amber-500';
      case 'red':
        return 'border-l-4 border-l-rose-600';
      default:
        return 'border-l-4 border-l-slate-400';
    }
  }
}
