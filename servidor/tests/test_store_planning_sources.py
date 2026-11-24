from unittest.mock import patch
from uuid import UUID

from app.eliot_store_planning_sources import (
    company_db_source,
    document_sha,
    list_documents,
    matches_step,
)

ORG = UUID('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa')


def test_company_db_source_from_configured_connector():
    meta = {
        'id': '1', 'kind': 'mysql', 'label': 'Digital services llc',
        'host': 'db.example', 'port': 3306, 'username': 'u',
        'database_name': 'shop', 'secret_cipher': 'x', 'status': 'configured',
    }
    with patch('app.eliot_store_planning_sources.load_store_connector', return_value=meta):
        source = company_db_source(ORG)
    assert source['kind'] == 'database'
    assert source['repository'] == 'company-db/digital-services-llc'
    assert source['ref'] == 'live' and source['prefix'] == 'ops/'


def test_list_and_match_ops_documents():
    meta = {
        'id': '1', 'kind': 'mysql', 'label': 'tienda',
        'host': 'h', 'port': 3306, 'username': 'u',
        'database_name': 'shop', 'secret_cipher': 'x', 'status': 'configured',
    }
    with patch('app.eliot_store_planning_sources.load_store_connector', return_value=meta):
        docs = list_documents(ORG, 'company-db/tienda')
        assert len(docs) == 5
        assert docs[0]['path'] == 'ops/pedidos.md'
        assert matches_step(ORG, 'company-db/tienda', 'live', 'ops/pedidos.md', docs[0]['sha'])
        assert not matches_step(ORG, 'company-db/tienda', 'live', 'ops/secret.md', 'a' * 40)
        assert not matches_step(ORG, 'other/repo', 'live', 'ops/pedidos.md', docs[0]['sha'])
    assert document_sha(ORG, 'ops/pedidos.md') == docs[0]['sha']
