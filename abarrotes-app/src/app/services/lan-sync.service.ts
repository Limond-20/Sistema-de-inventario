import { Injectable, NgZone, inject, signal, computed } from '@angular/core';

export type LanSyncStatus = 'idle' | 'unavailable' | 'connecting' | 'open' | 'closed' | 'unauthorized';

export interface LanSyncSnapshot {
  status: LanSyncStatus;
  role: 'phone' | 'pc';
  pc: boolean;
  phones: number;
  id: string | null;
  connected: boolean;
}

export interface WindowLanSync {
  role: 'phone' | 'pc';
  readonly status: LanSyncStatus;
  readonly connected: boolean;
  readonly pc: boolean;
  readonly phones: number;
  snapshot(): LanSyncSnapshot;
  uploadEvidence?(file: File | Blob): Promise<{ id: string; bytes: number; sha256: string }>;
  on(type: 'status' | 'peers', fn: (snap: LanSyncSnapshot) => void): void;
  off(type: 'status' | 'peers', fn: (snap: LanSyncSnapshot) => void): void;
  connect(): void;
  disconnect(): void;
}

declare global {
  interface Window {
    LanSync?: WindowLanSync;
    __lanSyncInstalled?: boolean;
  }
}

export interface PairingInfo {
  token: string;
  expiresAt: string;
  url: string;
}

@Injectable({
  providedIn: 'root',
})
export class LanSyncService {
  private readonly ngZone = inject(NgZone);

  readonly status = signal<LanSyncStatus>('unavailable');
  readonly phones = signal<number>(0);
  readonly pc = signal<boolean>(false);
  readonly role = signal<'phone' | 'pc'>('pc');

  readonly isUnavailable = computed(() => this.status() === 'unavailable');
  readonly isConnected = computed(() => this.status() === 'open');
  readonly hasPhones = computed(() => this.phones() > 0);

  constructor() {
    this.init();
  }

  private init(): void {
    if (typeof window === 'undefined') return;

    const sync = window.LanSync;
    if (sync) {
      const snap = sync.snapshot();
      this.status.set(snap.status);
      this.phones.set(snap.phones);
      this.pc.set(snap.pc);
      this.role.set(snap.role);

      sync.on('status', (s) => {
        this.ngZone.run(() => {
          this.status.set(s.status);
          this.phones.set(s.phones);
          this.pc.set(s.pc);
        });
      });

      sync.on('peers', (s) => {
        this.ngZone.run(() => {
          this.phones.set(s.phones);
          this.pc.set(s.pc);
        });
      });
    } else {
      this.status.set('unavailable');
    }
  }

  async fetchPairingInfo(): Promise<PairingInfo | null> {
    if (this.isUnavailable()) return null;
    try {
      const res = await fetch('/api/pairing', { cache: 'no-store' });
      if (!res.ok) return null;
      return (await res.json()) as PairingInfo;
    } catch {
      return null;
    }
  }

  async rotatePairing(): Promise<PairingInfo | null> {
    if (this.isUnavailable()) return null;
    try {
      const res = await fetch('/api/pairing/rotate', { method: 'POST' });
      if (!res.ok) return null;
      return (await res.json()) as PairingInfo;
    } catch {
      return null;
    }
  }
}
