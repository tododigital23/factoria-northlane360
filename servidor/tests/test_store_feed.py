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
    monkeypatch.setattr("app.eliot_company_db.list_mysql_tables", lambda _u: ["wp_wc_orders", "wp_posts"])
    shape = store.probe_store_shape("mysql://u:p@h/db")
    assert shape == {"profile": "woocommerce", "table_prefix": "wp_", "hpos": True}


def test_probe_mysql_sin_tablas_prefiere_woocommerce():
    def boom(*_a, **_k):
        raise RuntimeError("no schema")
    from unittest.mock import patch
    with patch("app.eliot_company_db.list_mysql_tables", boom), patch("app.eliot_company_db.run_select", boom):
        shape = store.probe_store_shape("mysql://u:p@h/db")
    assert shape["profile"] == "woocommerce" and shape["table_prefix"] == "wp_"


def test_resolve_mysql_elige_el_perfil_con_mas_consultas(monkeypatch):
    def fake_score(_url, shape, _prefix):
        return 3 if shape["profile"] == "woocommerce" and not shape.get("hpos") else 0
    monkeypatch.setattr(store, "probe_store_shape", lambda *_a, **_k: {"profile": "generic", "table_prefix": "wp_", "hpos": False})
    monkeypatch.setattr(store, "score_shape", fake_score)
    shape = store.resolve_mysql_shape("mysql://u:p@h/db", "generic", "td")
    assert shape["profile"] == "woocommerce" and shape["hpos"] is False


def test_resolve_mysql_nunca_elige_generic_aunque_marque_puntos(monkeypatch):
    def fake_score(_url, shape, _prefix):
        return 2 if shape["profile"] == "generic" else 0
    monkeypatch.setattr(store, "probe_store_shape", lambda *_a, **_k: {"profile": "generic", "table_prefix": "wp_", "hpos": False})
    monkeypatch.setattr(store, "score_shape", fake_score)
    shape = store.resolve_mysql_shape("mysql://u:p@h/db", "generic", "td")
    assert shape["profile"] != "generic"


def test_resolve_mysql_prefiere_custom_si_tablas_lo_dicen(monkeypatch):
    monkeypatch.setattr(store, "probe_store_shape", lambda *_a, **_k: {"profile": "custom", "table_prefix": "wp_", "hpos": False})
    monkeypatch.setattr(store, "score_shape", lambda _u, shape, _p: 2 if shape["profile"] == "custom" else 0)
    shape = store.resolve_mysql_shape("mysql://u:p@h/db", "generic", "td")
    assert shape["profile"] == "custom"


def test_detecta_tienda_custom_sin_wordpress():
    names = {"orders", "order_items", "chat_conversations", "products", "store_activity_log", "users"}
    assert store.is_custom_shop(names) is True
    assert store.is_custom_shop({"wp_posts", "orders"}) is False
    assert store._shape_from_names(names)["profile"] == "custom"


def test_watchers_custom_usa_chat_y_activity(monkeypatch):
    def cols(_url, table):
        return {
            "orders": {"id", "status", "created_at", "total"},
            "chat_conversations": {"id", "status", "updated_at"},
            "store_activity_log": {"id", "created_at", "resolved_at"},
        }.get(table, set())
    monkeypatch.setattr(store, "table_columns", cols)
    monkeypatch.setattr(store, "_table_alive", lambda _u, t: t in ("chat_conversations", "store_activity_log"))
    watchers = store._watchers_custom("mysql://u:p@h/db", "td")
    assert [w["id"] for w in watchers] == ["pedidos", "pagos", "fallos", "chats"]
    assert "chat_conversations" in watchers[-1]["sql"]
    assert "store_activity_log" in watchers[2]["sql"]


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
