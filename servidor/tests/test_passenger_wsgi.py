from pathlib import Path

from passenger_wsgi import load_dotenv


def test_load_dotenv_does_not_override(monkeypatch, tmp_path):
    env = tmp_path / ".env"
    env.write_text("ELIOT_DEMO_KEY=desde-archivo\nELIOT_HOLDING_NAME=Hosting\n", encoding="utf-8")
    monkeypatch.setenv("ELIOT_DEMO_KEY", "ya-estaba")
    monkeypatch.delenv("ELIOT_HOLDING_NAME", raising=False)
    load_dotenv(env)
    import os
    assert os.environ["ELIOT_DEMO_KEY"] == "ya-estaba"
    assert os.environ["ELIOT_HOLDING_NAME"] == "Hosting"


def test_passenger_exports_wsgi_callable():
    import passenger_wsgi
    assert callable(passenger_wsgi.application)
