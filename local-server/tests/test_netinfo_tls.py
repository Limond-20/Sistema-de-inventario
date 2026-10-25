import datetime as dt

from cryptography import x509

from lansync.netinfo import is_loopback, lan_ips
from lansync.tls import ensure_cert


def test_is_loopback():
    for h in ("127.0.0.1", "::1", "localhost", "::ffff:127.0.0.1"):
        assert is_loopback(h)
    for h in ("192.168.1.20", "10.0.0.5", "8.8.8.8", "testclient", "", None):
        assert not is_loopback(h)


def test_lan_ips_no_incluye_loopback():
    for ip in lan_ips():
        assert not ip.startswith("127.") and not ip.startswith("169.254.")


def test_certificado_cubre_ips_y_se_regenera_si_cambia_la_red(tmp_path):
    crt, key = ensure_cert(tmp_path, ["192.168.1.70"])
    cert = x509.load_pem_x509_certificate(crt.read_bytes())
    san = cert.extensions.get_extension_for_class(x509.SubjectAlternativeName).value
    assert "192.168.1.70" in {str(i) for i in san.get_values_for_type(x509.IPAddress)}
    assert "localhost" in san.get_values_for_type(x509.DNSName)
    assert (cert.not_valid_after_utc - dt.datetime.now(dt.timezone.utc)).days > 800

    serie1 = cert.serial_number
    ensure_cert(tmp_path, ["192.168.1.70"])               # misma red: se reutiliza
    assert x509.load_pem_x509_certificate(crt.read_bytes()).serial_number == serie1
    ensure_cert(tmp_path, ["192.168.1.70", "10.0.0.9"])   # IP nueva: se regenera
    assert x509.load_pem_x509_certificate(crt.read_bytes()).serial_number != serie1
