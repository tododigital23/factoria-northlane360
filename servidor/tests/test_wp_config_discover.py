from unittest.mock import patch
from uuid import uuid4

from fastapi import FastAPI
from fastapi.testclient import TestClient

from app import eliot_connectors_api as api
from app.eliot_connectors import parse_wp_config, remote_db_host, wp_config_candidates

WP = """
<?php
define('DB_NAME', 'shop_wp');
define( "DB_USER", "shop_user" );
define('DB_PASSWORD', 's3cret');
define('DB_HOST', 'localhost');
$table_prefix = 'wp_ab12_';
"""


def test_parse_wp_config_defines():
    parsed = parse_wp_config(WP)
    assert parsed == {
        "DB_NAME": "shop_wp",
        "DB_USER": "shop_user",
        "DB_PASSWORD": "s3cret",
        "DB_HOST": "localhost",
        "table_prefix": "wp_ab12_",
    }


def test_localhost_becomes_ftp_host():
    host, adjusted = remote_db_host("localhost", "ftp.digitalservice-academia.com")
    assert adjusted is True and host == "ftp.digitalservice-academia.com"
    host2, adj2 = remote_db_host("mysql.example.com", "ftp.example.com")
    assert adj2 is False and host2 == "mysql.example.com"


def test_wp_config_candidates_include_public_html_variants():
    paths = wp_config_candidates("public_html/tienda-online.digitalservice-academia.com")
    assert "public_html/tienda-online.digitalservice-academia.com/wp-config.php" in paths
    assert "tienda-online.digitalservice-academia.com/wp-config.php" in paths
    assert paths[0].endswith("wp-config.php")


def test_discover_endpoint_saves_mysql_without_returning_password():
    from contextlib import contextmanager
    from unittest.mock import MagicMock

    org, cid, did = uuid4(), uuid4(), uuid4()
    app = FastAPI()
    app.include_router(api.router)
    client = TestClient(app)
    cur = MagicMock()
    meta = {
        "id": str(cid), "organization_id": str(org), "kind": "ftp", "label": "tienda online",
        "host": "ftp.example.com", "port": 21, "username": "u", "remote_path": "public_html/shop",
        "database_name": None, "status": "configured",
    }

    @contextmanager
    def cursor(_):
        yield cur

    cur.fetchall.return_value = [(meta,)]
    cur.fetchone.side_effect = (
        [("fn",)] * len(api.FUNCTIONS)
        + [("nl360:v1:cipher",)]
        + [("fn",)] * len(api.FUNCTIONS)
        + [({"id": str(did), "organization_id": str(org), "kind": "mysql",
             "label": "WooCommerce tienda online", "status": "configured", "saved": True},)]
    )
    discovered = {
        "kind": "mysql", "host": "ftp.example.com", "port": 3306, "username": "shop_user",
        "password": "s3cret", "database_name": "shop_wp",
        "host_adjusted_from_localhost": True, "source": "wp-config.php",
    }
    with patch.object(api.identity, "verified_identity", return_value="iss|owner"), \
         patch.object(api, "_open_password", return_value="ftp-pass"), \
         patch.object(api, "discover_wp_database_bounded", return_value=discovered), \
         patch.object(api, "crypto_ready", return_value=True), \
         patch.object(api, "seal", return_value="nl360:v1:" + "b" * 40), \
         patch.object(api, "_cursor", cursor):
        r = client.post(f"/v1/me/organizations/{org}/connectors/{cid}/discover-database")
    assert r.status_code == 201, r.text
    body = r.json()
    assert body["saved"] is True and body["database_name"] == "shop_wp"
    assert body["password_stored"] is True
    assert "s3cret" not in r.text and "password" not in body
