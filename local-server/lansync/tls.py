"""Certificado TLS autofirmado para servir la app por HTTPS en la red local.

Los navegadores del celular exigen HTTPS (contexto seguro) para abrir la cámara en vivo.
El certificado se regenera solo si cambia la IP de la PC o está por vencer.
"""
from __future__ import annotations

import datetime as dt
import ipaddress
import os
from pathlib import Path

from cryptography import x509
from cryptography.hazmat.primitives import hashes, serialization
from cryptography.hazmat.primitives.asymmetric import ec
from cryptography.x509.oid import ExtendedKeyUsageOID, NameOID

VALID_DAYS = 825  # límite que aceptan iOS/macOS para certificados de servidor
RENEW_BEFORE_DAYS = 30


def _wanted_sans(ips: list[str]) -> tuple[set[str], set[str]]:
    dns = {"localhost"}
    addrs = {"127.0.0.1", "::1", *ips}
    return dns, addrs


def _covers(cert: x509.Certificate, ips: list[str]) -> bool:
    now = dt.datetime.now(dt.timezone.utc)
    if cert.not_valid_after_utc - now < dt.timedelta(days=RENEW_BEFORE_DAYS):
        return False
    try:
        san = cert.extensions.get_extension_for_class(x509.SubjectAlternativeName).value
    except x509.ExtensionNotFound:
        return False
    have_ips = {str(i) for i in san.get_values_for_type(x509.IPAddress)}
    _, want_ips = _wanted_sans(ips)
    return want_ips.issubset(have_ips)


def ensure_cert(cert_dir: Path, ips: list[str]) -> tuple[Path, Path]:
    cert_dir.mkdir(parents=True, exist_ok=True)
    cert_path, key_path = cert_dir / "server.crt", cert_dir / "server.key"

    if cert_path.exists() and key_path.exists():
        try:
            cert = x509.load_pem_x509_certificate(cert_path.read_bytes())
            if _covers(cert, ips):
                return cert_path, key_path
        except ValueError:
            pass  # archivo dañado: se regenera

    key = ec.generate_private_key(ec.SECP256R1())
    dns, addrs = _wanted_sans(ips)
    san = [x509.DNSName(d) for d in sorted(dns)] + [x509.IPAddress(ipaddress.ip_address(a)) for a in sorted(addrs)]
    name = x509.Name([x509.NameAttribute(NameOID.COMMON_NAME, "Abarrotes - servidor local")])
    now = dt.datetime.now(dt.timezone.utc)
    cert = (
        x509.CertificateBuilder()
        .subject_name(name)
        .issuer_name(name)
        .public_key(key.public_key())
        .serial_number(x509.random_serial_number())
        .not_valid_before(now - dt.timedelta(minutes=5))
        .not_valid_after(now + dt.timedelta(days=VALID_DAYS))
        .add_extension(x509.SubjectAlternativeName(san), critical=False)
        .add_extension(x509.BasicConstraints(ca=False, path_length=None), critical=True)
        .add_extension(x509.ExtendedKeyUsage([ExtendedKeyUsageOID.SERVER_AUTH]), critical=False)
        .sign(key, hashes.SHA256())
    )
    key_path.write_bytes(
        key.private_bytes(
            serialization.Encoding.PEM,
            serialization.PrivateFormat.PKCS8,
            serialization.NoEncryption(),
        )
    )
    try:
        os.chmod(key_path, 0o600)
    except OSError:
        pass  # Windows
    cert_path.write_bytes(cert.public_bytes(serialization.Encoding.PEM))
    return cert_path, key_path
