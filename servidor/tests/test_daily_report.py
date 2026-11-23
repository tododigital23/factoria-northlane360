"""Resumen diario de Freddy: a las 21:00 de Madrid, una vez al día, con la empresa resaltada y sin datos de clientes."""
import threading
from datetime import datetime
from zoneinfo import ZoneInfo

from app import eliot_daily_report as dr

M = ZoneInfo('Europe/Madrid')
at = lambda *a: datetime(*a, tzinfo=M).timestamp()
SALES = {'cobros': 7, 'importe_eur': 1234.5, 'altas': {'cobros': 3, 'importe_eur': 400.0}, 'renovaciones': {'cobros': 4, 'importe_eur': 834.5}}
note = lambda level, code='pedido_parado', agent='Entregas': {'level': level, 'code': code, 'count': 1, 'refs': ['ab-ORD-1'], 'agent': agent, 'people': ['secreto · 600000000']}


def test_toca_solo_en_su_hora_de_madrid_y_una_vez_al_dia(monkeypatch):
    monkeypatch.delenv('ELIOT_DAILY_REPORT_HOUR', raising=False)
    assert dr.due(at(2026, 11, 21, 21, 0), None) and dr.due(at(2026, 11, 21, 21, 59), None)
    assert not dr.due(at(2026, 11, 21, 20, 59), None) and not dr.due(at(2026, 11, 21, 22, 0), None)
    assert not dr.due(at(2026, 11, 21, 21, 30), '2026-11-21') and dr.due(at(2026, 11, 22, 21, 0), '2026-11-21')
    assert dr.due(at(2026, 7, 1, 21, 5), None)                       # también en horario de verano
    monkeypatch.setenv('ELIOT_DAILY_REPORT_HOUR', '9')
    assert dr.due(at(2026, 11, 21, 9, 10), None) and not dr.due(at(2026, 11, 21, 21, 0), None)
    for bad in ('x', '24', '-1'):
        monkeypatch.setenv('ELIOT_DAILY_REPORT_HOUR', bad)
        assert dr.hour() == 21
    monkeypatch.setenv('ELIOT_DAILY_REPORT', 'off')
    assert dr.enabled() is False


def test_cada_empresa_va_resaltada_con_sus_cifras_y_lo_que_queda_para_manana():
    text = dr.compose([('Nova Demo', SALES, [note('importante'), note('info', 'otro'), note('urgente')]), ('Juguetes Demo', None, None)], at(2026, 11, 21, 21, 0))
    assert 'Resumen del día' in text and 'sábado 21 de noviembre' in text
    assert '<b>NOVA DEMO</b>' in text and '<b>JUGUETES DEMO</b>' in text
    assert text.index('JUGUETES DEMO') < text.index('NOVA DEMO')          # por orden alfabético
    assert 'Ventas: <b>7</b>' in text and '1.234,50 €' in text and 'Clientes nuevos: <b>3</b>' in text and 'Renovaciones: <b>4</b>' in text
    assert 'Para mañana (2)' in text and 'Urgentes que siguen abiertas: <b>1</b>' in text
    assert 'no he podido consultarlas' in text and 'no he podido hablar con sus agentes' in text
    assert 'secreto' not in text and '600000000' not in text and 'ab-ORD-1' not in text       # sin clientes ni pedidos
    assert 'TOTAL' in text and '(1 de 2 empresas)' in text


def test_sin_incidencias_sin_empresas_y_nombres_raros():
    text = dr.compose([('A <b>&', {**SALES, 'cobros': 0, 'importe_eur': 0}, [])], at(2026, 11, 21, 21, 0))
    assert 'A &lt;B&gt;&amp;' in text and 'ninguna ✅' in text and 'TOTAL' not in text and '0,00 €' in text
    assert 'ninguna empresa conectada' in dr.compose([], at(2026, 11, 21, 21, 0))
    assert dr.euros(None) == '—' and dr.euros(1234567.891) == '1.234.567,89 €'


class N:
    def __init__(self, last):
        self.last, self.lock, self.refreshed = last, threading.Lock(), 0

    def refresh(self, max_age=20):
        self.refreshed += 1


def test_reune_ventas_y_avisos_y_una_empresa_caida_no_para_a_las_demas():
    n = N({'o1': {'company': 'Uno', 'notices': {'k': note('info')}, 'summary': {}}})
    def ask(feed):
        if feed == 'f2':
            raise RuntimeError('portal caído')
        return SALES
    sent = []
    ok = dr.run_once(n, lambda t: sent.append(t) or True, now=at(2026, 11, 21, 21, 0), ask=ask, companies=lambda: [('o1', 'Uno', 'f1'), ('o2', 'Dos', 'f2')])
    assert ok and n.refreshed == 1 and len(sent) == 1
    assert '<b>UNO</b>' in sent[0] and 'Para mañana (1)' in sent[0] and '<b>DOS</b>' in sent[0] and 'no he podido consultarlas' in sent[0]


def test_si_telegram_rechaza_las_negritas_llega_en_texto_plano(monkeypatch):
    calls = []
    class R:
        def __init__(self, code): self.status_code = code
    class Client:
        def __init__(self, **k): pass
        def __enter__(self): return self
        def __exit__(self, *a): return False
        def post(self, url, json):
            calls.append(json)
            return R(400 if 'parse_mode' in json else 200)
    monkeypatch.setattr(dr.httpx, 'Client', Client)
    assert dr.html_sender('123456:' + 'a' * 35, '12345')('🏢 <b>A &amp; B</b>') is True
    assert calls[0]['parse_mode'] == 'HTML' and 'parse_mode' not in calls[1] and calls[1]['text'] == '🏢 A & B'
