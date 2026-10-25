"""Códigos de vinculación para los celulares (el QR lleva uno de ellos)."""
from __future__ import annotations

import hmac
import json
import os
import secrets
import time
from pathlib import Path

# La PC de una tienda se apaga y enciende a diario: el código sobrevive reinicios (se guarda en
# disco) para no obligar a escanear el QR cada mañana. Se puede invalidar cuando se quiera.
DEFAULT_TTL_SECONDS = 30 * 24 * 3600


class PairingStore:
    def __init__(self, ttl_seconds: int = DEFAULT_TTL_SECONDS, clock=time.time, path: str | Path | None = None) -> None:
        self._ttl = ttl_seconds
        self._clock = clock
        self._path = Path(path) if path else None
        self._tokens: dict[str, float] = {}
        self._current: str | None = None
        self._load()

    def _load(self) -> None:
        if self._path is None or not self._path.exists():
            return
        try:
            data = json.loads(self._path.read_text())
            tok, exp = data["token"], float(data["expires"])
        except (ValueError, KeyError, TypeError, OSError):
            return
        if isinstance(tok, str) and tok and exp > self._clock():
            self._tokens[tok] = exp
            self._current = tok

    def _save(self) -> None:
        if self._path is None:
            return
        try:
            self._path.parent.mkdir(parents=True, exist_ok=True)
            if self._current is None:
                self._path.unlink(missing_ok=True)
                return
            self._path.write_text(json.dumps({"token": self._current, "expires": self._tokens[self._current]}))
            try:
                os.chmod(self._path, 0o600)
            except OSError:
                pass  # Windows
        except OSError:
            pass  # sin disco no se pierde el servicio; solo habrá que volver a escanear tras reiniciar

    def _purge(self) -> None:
        now = self._clock()
        for t in [t for t, exp in self._tokens.items() if exp <= now]:
            del self._tokens[t]
            if t == self._current:
                self._current = None

    def current(self) -> tuple[str, float]:
        """Código vigente (crea uno nuevo si no hay o ya venció)."""
        self._purge()
        if self._current is None:
            self._current = secrets.token_urlsafe(16)
            self._tokens[self._current] = self._clock() + self._ttl
            self._save()
        return self._current, self._tokens[self._current]

    def rotate(self) -> tuple[str, float]:
        """Invalida todos los códigos anteriores y crea uno nuevo."""
        self._tokens.clear()
        self._current = None
        self._save()
        return self.current()

    def valid(self, token: object) -> bool:
        if not isinstance(token, str) or not token:
            return False
        self._purge()
        ok = False
        for t in self._tokens:  # sin cortar el ciclo: tiempo constante respecto al contenido
            if hmac.compare_digest(t.encode(), token.encode()):
                ok = True
        return ok
