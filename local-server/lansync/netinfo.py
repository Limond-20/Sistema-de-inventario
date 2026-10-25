"""Detección de las direcciones IP privadas de la PC dentro de la red local."""
from __future__ import annotations

import ipaddress
import socket


def is_loopback(host: str | None) -> bool:
    """True si el cliente se conecta desde la propia PC (127.0.0.1, ::1, ::ffff:127.0.0.1)."""
    if not host:
        return False
    if host == "localhost":
        return True
    try:
        ip = ipaddress.ip_address(host)
    except ValueError:
        return False
    if isinstance(ip, ipaddress.IPv6Address) and ip.ipv4_mapped is not None:
        ip = ip.ipv4_mapped
    return ip.is_loopback


def lan_ips() -> list[str]:
    """IPs IPv4 privadas de la PC, la de la ruta por defecto primero.

    No genera tráfico: connect() sobre UDP solo consulta la tabla de rutas, así que
    funciona aunque el router no tenga internet contratado.
    """
    found: list[str] = []

    def add(ip: str) -> None:
        try:
            addr = ipaddress.ip_address(ip)
        except ValueError:
            return
        if addr.version != 4 or addr.is_loopback or addr.is_link_local or addr.is_unspecified:
            return
        if ip not in found:
            found.append(ip)

    try:
        with socket.socket(socket.AF_INET, socket.SOCK_DGRAM) as s:
            s.settimeout(0.2)
            s.connect(("10.255.255.255", 1))
            add(s.getsockname()[0])
    except OSError:
        pass

    try:
        for info in socket.getaddrinfo(socket.gethostname(), None, socket.AF_INET):
            add(info[4][0])
    except OSError:
        pass

    return found
