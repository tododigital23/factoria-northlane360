from unittest.mock import MagicMock, patch
from uuid import UUID

from app.eliot_store_planning_sources import (
    company_db_source,
    document_sha,
    list_documents,
    list_owner_connectors,
    matches_step,
    source_from_connector_rows,
)

ORG = UUID('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa')


def test_source_from_owner_connector_rows_prefers_configured():
    rows = [
        {'kind': 'ftp', 'label': 'files', 'status': 'configured', 'database_name': None},
        {'kind': 'mysql', 'label': 'Digital services llc', 'status': 'failed', 'database_name': 'shop'},
        {'kind': 'mysql', 'label': 'Tienda principal', 'status': 'configured', 'database_name': 'shop'},
    ]
    source = source_from_connector_rows(rows)
    assert source['repository'] == 'company-db/tienda-principal'
    assert source['label'] == 'Tienda principal'


def test_failed_probe_still_unlocks_planning():
    rows = [{'kind': 'mysql', 'label': 'Digital services llc', 'status': 'failed', 'database_name': 'shop'}]
    source = source_from_connector_rows(rows)
    assert source['kind'] == 'database'
    assert source['repository'] == 'company-db/digital-services-llc'


def test_company_db_source_uses_owner_rows_before_admin_fallback():
    rows = [{'kind': 'postgresql', 'label': 'ops', 'status': 'configured', 'database_name': 'db1'}]
    with patch('app.eliot_store_feed.load_store_connector') as admin:
        source = company_db_source(ORG, rows)
        admin.assert_not_called()
    assert source['repository'] == 'company-db/ops'


def test_list_and_match_ops_documents():
    rows = [{'kind': 'mysql', 'label': 'tienda', 'status': 'configured', 'database_name': 'shop'}]
    docs = list_documents(ORG, 'company-db/tienda', rows)
    assert len(docs) == 5
    assert docs[0]['path'] == 'ops/pedidos.md'
    assert matches_step(ORG, 'company-db/tienda', 'live', 'ops/pedidos.md', docs[0]['sha'], rows)
    assert not matches_step(ORG, 'company-db/tienda', 'live', 'ops/secret.md', 'a' * 40, rows)
    assert document_sha(ORG, 'ops/pedidos.md') == docs[0]['sha']


def test_list_owner_connectors_missing_function_is_empty():
    cur = MagicMock()
    cur.fetchone.return_value = (None,)
    assert list_owner_connectors(cur, ORG) == []
