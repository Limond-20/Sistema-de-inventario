import { Component, HostListener, computed, inject, OnInit, signal } from '@angular/core';
import { CommonModule, DatePipe } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { MockInventoryService } from '../../services/mock-inventory.service';
import { IconComponent } from '../../components/icon/icon.component';
import { hasPermission, ROLE_PERMISSIONS, type AppUser, type UserRole } from '../../domain/auth';
import { verifySecurityAuditChain } from '../../domain/audit-log';
import { DEFAULT_PRIVACY_NOTICE_TEMPLATE } from '../../domain/privacy';

type SettingsTab = 'parametros' | 'usuarios' | 'seguridad' | 'privacidad' | 'bitacora';

@Component({
  selector: 'app-settings-view',
  imports: [CommonModule, FormsModule, DatePipe, IconComponent],
  templateUrl: './settings-view.component.html',
})
export class SettingsViewComponent implements OnInit {
  protected readonly inv = inject(MockInventoryService);

  // ---------- Control de Acceso por PIN Administrador ----------
  protected readonly isAdminAuthorized = signal<boolean>(false);
  protected readonly adminAuthPin = signal<string>('');
  protected readonly adminAuthError = signal<string>('');

  // ---------- Pestaña Activa ----------
  protected readonly activeTab = signal<SettingsTab>('parametros');

  // ---------- Formulario de Parámetros del Negocio ----------
  protected readonly formStoreName = signal<string>('');
  protected readonly formInitialCashFloat = signal<number>(1000);
  protected readonly formMarginThresholdPct = signal<number>(20);
  protected readonly formDefaultIvaPct = signal<number>(16);
  protected readonly formDefaultIepsPct = signal<number>(0);
  protected readonly formInactivityTimeoutMinutes = signal<number>(5);
  protected readonly formMaxDiscountPctWithoutPin = signal<number>(10);
  protected readonly settingsFeedback = signal<string>('');
  protected readonly settingsError = signal<string>('');

  // ---------- Modal Nuevo Usuario ----------
  protected readonly userModalOpen = signal<boolean>(false);
  protected readonly newUserName = signal<string>('');
  protected readonly newUserRole = signal<UserRole>('CAJERO');
  protected readonly newUserPin = signal<string>('');
  protected readonly userModalError = signal<string>('');
  protected readonly userModalFeedback = signal<string>('');
  protected readonly userActionError = signal<string>('');
  protected readonly userPendingDeactivateId = signal<string | null>(null);

  // ---------- Formulario Cambio de PIN ----------
  protected readonly selectedUserForPin = signal<string>('');
  protected readonly isResettingOtherUserPin = computed(() => {
    const targetId = this.selectedUserForPin();
    const current = this.inv.currentUser();
    return !!targetId && current?.role === 'ADMINISTRADOR' && targetId !== current.id;
  });
  protected readonly pinCurrent = signal<string>('');
  protected readonly pinNew = signal<string>('');
  protected readonly pinConfirm = signal<string>('');
  protected readonly pinError = signal<string>('');
  protected readonly pinFeedback = signal<string>('');

  // ---------- Bloque K: Aviso de privacidad y cifrado en reposo ----------
  protected readonly privacyResponsible = signal<string>('');
  protected readonly privacyContact = signal<string>('');
  protected readonly privacyTemplate = signal<string>('');
  protected readonly privacyFeedback = signal<string>('');
  protected readonly privacyError = signal<string>('');
  protected readonly privacyBusy = signal<boolean>(false);
  protected readonly privacyPlaceholders = '{{negocio}}, {{responsable}} y {{contacto}}';
  protected readonly privacyVersionsDesc = computed(() =>
    [...(this.inv.privacyNotice()?.versions || [])].sort((a, b) => b.version - a.version)
  );

  // ---------- Integridad de Bitácora de Auditoría ----------
  protected readonly auditChainStatus = computed(() => {
    return verifySecurityAuditChain(this.inv.securityAuditLog(), 'newest-first');
  });

  // ---------- Matriz de Permisos Documentada ----------
  protected readonly permissionsMatrix = [
    { permission: 'Vender en POS', cajero: true, encargado: true, admin: true },
    { permission: 'Cobrar efectivo / transferencia', cajero: true, encargado: true, admin: true },
    { permission: 'Abonar a cuenta de fiado', cajero: true, encargado: true, admin: true },
    { permission: 'Recepción de mercancía y facturas', cajero: false, encargado: true, admin: true },
    { permission: 'Bajas y revisión de mermas', cajero: false, encargado: true, admin: true },
    { permission: 'Auditoría física de pasillo', cajero: false, encargado: true, admin: true },
    { permission: 'Cortes de turno y arqueos', cajero: false, encargado: true, admin: true },
    { permission: 'Ajustes del negocio y parámetros', cajero: false, encargado: false, admin: true },
    { permission: 'Gestión de usuarios y credenciales', cajero: false, encargado: false, admin: true },
    { permission: 'Modificación de precios en catálogo', cajero: false, encargado: false, admin: true },
    { permission: 'Respaldos cifrados (.bak)', cajero: false, encargado: false, admin: true },
    { permission: 'Restablecer datos de fábrica', cajero: false, encargado: false, admin: true },
  ];

  ngOnInit(): void {
    this.syncFormWithSettings();
    const current = this.inv.currentUser();
    if (current && current.role === 'ADMINISTRADOR') {
      this.isAdminAuthorized.set(true);
    }
  }

  private syncFormWithSettings(): void {
    const s = this.inv.businessSettings();
    this.formStoreName.set(s.storeName);
    this.formInitialCashFloat.set(s.initialCashFloat);
    this.formMarginThresholdPct.set(s.marginThresholdPct);
    this.formDefaultIvaPct.set(s.defaultIvaPct);
    this.formDefaultIepsPct.set(s.defaultIepsPct);
    this.formInactivityTimeoutMinutes.set(s.inactivityTimeoutMinutes);
    this.formMaxDiscountPctWithoutPin.set(s.maxDiscountPctWithoutPin);
  }

  async verifyAdminAuth(): Promise<void> {
    this.adminAuthError.set('');
    const pin = this.adminAuthPin().trim();
    if (pin.length < 6) {
      this.adminAuthError.set('Ingresa un PIN de al menos 6 dígitos.');
      return;
    }
    const check = await this.inv.verifyAdminPin(pin);
    if (!check.success) {
      this.adminAuthError.set(check.message);
      return;
    }
    this.isAdminAuthorized.set(true);
    this.adminAuthPin.set('');
  }

  @HostListener('document:keydown.escape')
  protected onEscapeKey(): void {
    if (this.userModalOpen()) {
      this.closeNewUserModal();
    }
  }

  setTab(tab: SettingsTab): void {
    this.activeTab.set(tab);
    this.settingsFeedback.set('');
    this.settingsError.set('');
    this.pinFeedback.set('');
    this.pinError.set('');
    this.userActionError.set('');
    if (tab === 'privacidad') {
      void this.loadPrivacyForm();
    }
  }

  async loadPrivacyForm(): Promise<void> {
    this.privacyFeedback.set('');
    this.privacyError.set('');
    const config = await this.inv.ensurePrivacyNoticeInitialized();
    this.privacyResponsible.set(config.responsibleName);
    this.privacyContact.set(config.contact);
    this.privacyTemplate.set(config.template);
  }

  resetPrivacyTemplate(): void {
    this.privacyTemplate.set(DEFAULT_PRIVACY_NOTICE_TEMPLATE);
  }

  async publishPrivacyNotice(): Promise<void> {
    this.privacyFeedback.set('');
    this.privacyError.set('');
    this.privacyBusy.set(true);
    try {
      const res = await this.inv.publishPrivacyNotice({
        template: this.privacyTemplate(),
        responsibleName: this.privacyResponsible(),
        contact: this.privacyContact(),
      });
      if (res.ok) {
        this.privacyFeedback.set(res.message);
      } else {
        this.privacyError.set(res.message);
      }
    } finally {
      this.privacyBusy.set(false);
    }
  }

  async saveSettings(): Promise<void> {
    this.settingsFeedback.set('');
    this.settingsError.set('');

    const res = await this.inv.updateBusinessSettings({
      storeName: this.formStoreName(),
      initialCashFloat: Number(this.formInitialCashFloat()),
      marginThresholdPct: Number(this.formMarginThresholdPct()),
      defaultIvaPct: Number(this.formDefaultIvaPct()),
      defaultIepsPct: Number(this.formDefaultIepsPct()),
      inactivityTimeoutMinutes: Number(this.formInactivityTimeoutMinutes()),
      maxDiscountPctWithoutPin: Number(this.formMaxDiscountPctWithoutPin()),
    });

    if (!res.ok) {
      this.settingsError.set(res.errors?.join(' ') || 'Error al guardar los ajustes.');
      return;
    }

    this.settingsFeedback.set('Ajustes del negocio guardados correctamente.');
    this.syncFormWithSettings();
    setTimeout(() => this.settingsFeedback.set(''), 3500);
  }

  openNewUserModal(): void {
    this.newUserName.set('');
    this.newUserRole.set('CAJERO');
    this.newUserPin.set('');
    this.userModalError.set('');
    this.userModalFeedback.set('');
    this.userModalOpen.set(true);
  }

  closeNewUserModal(): void {
    this.userModalOpen.set(false);
  }

  async submitNewUser(): Promise<void> {
    this.userModalError.set('');
    this.userModalFeedback.set('');

    const name = this.newUserName().trim();
    const pin = this.newUserPin().trim();
    const role = this.newUserRole();

    if (name.length < 2) {
      this.userModalError.set('El nombre de usuario debe tener al menos 2 caracteres.');
      return;
    }
    if (pin.length < 6) {
      this.userModalError.set('El PIN debe contener al menos 6 dígitos numéricos.');
      return;
    }

    const res = await this.inv.createUser({ name, role, pin });
    if (!res.ok) {
      this.userModalError.set(res.message);
      return;
    }

    this.userModalFeedback.set(`Usuario "${name}" creado exitosamente.`);
    setTimeout(() => {
      this.closeNewUserModal();
    }, 1200);
  }

  async handleRoleChange(user: AppUser, newRole: UserRole, selectEl?: HTMLSelectElement): Promise<void> {
    this.userActionError.set('');
    if (user.role === newRole) return;
    const res = await this.inv.updateUserRole(user.id, newRole);
    if (!res.ok) {
      if (selectEl) {
        selectEl.value = user.role;
      }
      this.userActionError.set(res.message);
    }
  }

  requestDeactivateUser(user: AppUser): void {
    this.userActionError.set('');
    this.userPendingDeactivateId.set(user.id);
  }

  cancelDeactivateUser(): void {
    this.userPendingDeactivateId.set(null);
  }

  async handleToggleUser(user: AppUser): Promise<void> {
    this.userActionError.set('');
    if (user.isActive) {
      this.userPendingDeactivateId.set(null);
      const res = await this.inv.deactivateUser(user.id);
      if (!res.ok) {
        this.userActionError.set(res.message);
      }
    } else {
      this.inv.users.update((list) =>
        list.map((u) => (u.id === user.id ? { ...u, isActive: true, updatedAt: new Date().toISOString() } : u))
      );
      this.inv.appendSecurityAuditEntry(
        'USER_REACTIVATED',
        `Reactivación de usuario "${user.name}" (${user.role})`,
        { userId: user.id },
        user.name
      );
      await this.inv.flushSave();
    }
  }

  async submitChangePin(): Promise<void> {
    this.pinError.set('');
    this.pinFeedback.set('');

    const userId = this.selectedUserForPin() || this.inv.currentUser()?.id;
    if (!userId) {
      this.pinError.set('Selecciona un usuario.');
      return;
    }

    const currentPin = this.pinCurrent().trim();
    const newPin = this.pinNew().trim();
    const confirmPin = this.pinConfirm().trim();

    if (!currentPin) {
      this.pinError.set('Debes ingresar tu PIN actual.');
      return;
    }
    if (newPin.length < 6) {
      this.pinError.set('El nuevo PIN debe contener al menos 6 dígitos numéricos.');
      return;
    }
    if (newPin !== confirmPin) {
      this.pinError.set('La confirmación no coincide con el nuevo PIN.');
      return;
    }

    const res = await this.inv.changeUserPin(userId, currentPin, newPin);
    if (!res.ok) {
      this.pinError.set(res.message);
      return;
    }

    this.pinFeedback.set('PIN actualizado correctamente.');
    this.pinCurrent.set('');
    this.pinNew.set('');
    this.pinConfirm.set('');
    setTimeout(() => this.pinFeedback.set(''), 3500);
  }

  // ---------- Restablecimiento Demo ----------
  protected readonly resetDemoConfirm = signal<boolean>(false);
  protected readonly resetDemoDone = signal<boolean>(false);

  requestResetDemo(): void {
    this.resetDemoDone.set(false);
    this.resetDemoConfirm.set(true);
  }

  cancelResetDemo(): void {
    this.resetDemoConfirm.set(false);
  }

  async confirmResetDemoData(): Promise<void> {
    await this.inv.resetToDemoData();
    this.resetDemoConfirm.set(false);
    this.resetDemoDone.set(true);
    setTimeout(() => this.resetDemoDone.set(false), 3500);
  }
}
