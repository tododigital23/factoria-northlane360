from uuid import uuid4
from unittest.mock import patch

from app import eliot_store_feed as store
from app import eliot_portal_agents_api as portal


def test_profiles_tienen_pedidos_y_ventas():
    for profile in ("generic", "woocommerce", "prestashop"):
        watchers = store._watchers(profile, "td")
        assert any(w["id"] == "pedidos" for w in watchers)
        assert any(w["capacidad"] == "orders" for w in watchers)
        assert "ventas" in store._queries(profile)


def test_woocommerce_hpos_usa_wc_orders():
    watchers = store._watchers("woocommerce", "td", table_prefix="wp_", hpos=True)
    assert "wc_orders" in watchers[0]["sql"]
    assert "wp_posts" not in watchers[0]["sql"]
    assert "wc_orders" in store._queries("woocommerce", table_prefix="wp_", hpos=True)["ventas"]


def test_prefijo_custom_en_sql():
    watchers = store._watchers("woocommerce", "ab", table_prefix="xyz_")
    assert "xyz_posts" in watchers[0]["sql"]
    assert store._table_prefix("xyz_posts", "_posts") == "xyz_"
    assert store._table_prefix("wp_wc_orders", "_wc_orders") == "wp_"


def test_probe_store_shape_detecta_hpos(monkeypatch):
    monkeypatch.setattr(
        "app.eliot_company_db.run_select",
        lambda *_a, **_k: [{"t": "wp_wc_orders"}, {"t": "wp_posts"}],
    )
    shape = store.probe_store_shape("mysql://u:p@h/db")
    assert shape == {"profile": "woocommerce", "table_prefix": "wp_", "hpos": True}


def test_profile_for_detecta_woo_en_etiqueta():
    assert store.profile_for(str(uuid4()), "WooCommerce producción") == "woocommerce"
    assert store.profile_for(str(uuid4()), "PrestaShop demo") == "prestashop"


def test_feed_for_cae_al_conector_si_no_hay_portal_env(monkeypatch):
    monkeypatch.delenv("ELIOT_PORTAL_FEEDS", raising=False)
    org = uuid4()
    fake = {"kind": "database", "db_url": "mysql://u:p@h/db", "secret": "x" * 32, "watchers": [], "queries": {}}
    with patch.object(store, "feed_from_connector", return_value=fake):
        # feed_for importa feed_from_connector dentro; hay que parcharlo en el módulo store
        with patch("app.eliot_store_feed.feed_from_connector", return_value=fake):
            assert portal.feed_for(org) == fake


def test_mysql_interval_conversion():
    sql = "SELECT id FROM orders WHERE paid_at < CURRENT_TIMESTAMP - INTERVAL '2 hours'"
    out = store._mysql_intervals(sql)
    assert "INTERVAL 2 HOUR" in out
