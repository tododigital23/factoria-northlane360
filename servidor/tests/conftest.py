"""El modo descanso (040) añade una consulta previa en cada punto donde un agente empieza a trabajar. Las pruebas antiguas
cuentan consultas una a una, así que por defecto se da por hecho que no hay descanso. Las pruebas del propio descanso
lo piden de verdad con @pytest.mark.real_break."""
import pytest


def pytest_configure(config):
    config.addinivalue_line('markers', 'real_break: usa la comprobación real del modo descanso')


@pytest.fixture(autouse=True)
def _sin_descanso(request, monkeypatch):
    if request.node.get_closest_marker('real_break'):
        return
    from app import eliot_break, eliot_document_worker
    monkeypatch.setattr(eliot_break, 'on_break', lambda *a, **k: False)
    monkeypatch.setattr(eliot_document_worker, 'company_on_break', lambda *a, **k: False)
