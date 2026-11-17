import { Component, OnInit, computed, inject, signal } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { RouterLink } from '@angular/router';
import { MockInventoryService } from '../../services/mock-inventory.service';
import { IconComponent } from '../../components/icon/icon.component';
import { type LicenseStatusKind } from '../../domain/license';

@Component({
  selector: 'app-license-view',
  standalone: true,
  imports: [CommonModule, FormsModule, RouterLink, IconComponent],
  templateUrl: './license-view.component.html',
})
export class LicenseViewComponent implements OnInit {
  protected readonly inv = inject(MockInventoryService);

  protected readonly codeInput = signal<string>('');
  protected readonly isSubmitting = signal<boolean>(false);
  protected readonly feedback = signal<{ ok: boolean; message: string } | null>(null);
  protected readonly copyFeedback = signal<string | null>(null);

  protected readonly evalState = computed(() => this.inv.licenseEvaluation());

  ngOnInit(): void {
    void this.inv.refreshLicenseState();
  }

  protected statusBadgeClasses(status: LicenseStatusKind): string {
    switch (status) {
      case 'ACTIVA':
        return 'border-emerald-300 bg-emerald-50 text-emerald-900';
      case 'POR_VENCER':
        return 'border-amber-300 bg-amber-50 text-amber-900';
      case 'PERIODO_GRACIA':
        return 'border-orange-300 bg-orange-50 text-orange-900';
      case 'VENCIDA':
      case 'RELOJ_RETROCEDIDO':
      case 'SIN_LICENCIA':
      case 'INVALIDA':
        return 'border-rose-300 bg-rose-50 text-rose-900';
    }
  }

  async copyInstallationIdForWhatsApp(): Promise<void> {
    const id = this.inv.installationId();
    const text = `Hola, solicito código de licencia para ${this.inv.storeName}. ID de Instalación: ${id}`;
    try {
      if (typeof navigator !== 'undefined' && navigator.clipboard?.writeText) {
        await navigator.clipboard.writeText(text);
      }
      this.copyFeedback.set(`ID copiado al portapapeles: ${id}`);
    } catch {
      this.copyFeedback.set(`ID de instalación: ${id}`);
    }
  }

  async onActivateLicense(): Promise<void> {
    const raw = this.codeInput().trim();
    if (!raw) {
      this.feedback.set({
        ok: false,
        message: 'Pega el código de licencia recibido por WhatsApp (formato BT1...).',
      });
      return;
    }

    this.isSubmitting.set(true);
    try {
      const res = await this.inv.activateLicenseCode(raw);
      this.feedback.set({
        ok: res.ok,
        message: res.message,
      });
      if (res.ok) {
        this.codeInput.set('');
      }
    } finally {
      this.isSubmitting.set(false);
    }
  }
}
